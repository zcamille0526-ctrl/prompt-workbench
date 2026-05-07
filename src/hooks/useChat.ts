import { useState, useCallback, useEffect } from "react";
import { api, ChatError, type ChatMessage } from "../lib/api";
import { getApiKey } from "../lib/apiKey";

type UiMessage = ChatMessage & { id: string };

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

/**
 * Manages a single test-run conversation against the chat endpoint.
 *
 * `systemPrompt` is the resolved prompt content (after variable substitution).
 * Whenever the system prompt changes, the conversation auto-clears — the old
 * dialogue was conditioned on a different prompt and is no longer meaningful.
 */
export function useChat(systemPrompt: string, model: string) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [systemPrompt]);

  // Internal: send a request given any history slice. Used by both
  // sendMessage (append-then-send) and regenerate (replay existing tail).
  const callApi = useCallback(
    async (history: UiMessage[]) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        setError({ code: "NO_KEY", message: "请先在设置中填入 DeepSeek API Key" });
        return;
      }
      setIsLoading(true);
      setError(null);
      try {
        const payload: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...history.map(({ role, content }) => ({ role, content })),
        ];
        const reply = await api.chat(apiKey, model, payload);
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "assistant", content: reply },
        ]);
      } catch (e) {
        if (e instanceof ChatError) {
          setError({ code: e.code, message: e.message });
        } else {
          setError({ code: "OTHER", message: "请求失败，请重试" });
        }
      } finally {
        setIsLoading(false);
      }
    },
    [systemPrompt, model]
  );

  const sendMessage = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || isLoading) return;
      const userMsg: UiMessage = { id: newId(), role: "user", content: trimmed };
      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      await callApi(nextHistory);
    },
    [messages, isLoading, callApi]
  );

  /**
   * Drop the last assistant reply and re-send the conversation up to (and
   * including) the user message that prompted it. If the tail isn't an
   * assistant message — e.g. an error swallowed it — this is a no-op.
   */
  const regenerateLast = useCallback(async () => {
    if (isLoading) return;
    if (messages.length === 0 || messages[messages.length - 1].role !== "assistant") {
      return;
    }
    const trimmed = messages.slice(0, -1);
    setMessages(trimmed);
    await callApi(trimmed);
  }, [messages, isLoading, callApi]);

  /**
   * Delete an assistant message (and the user message immediately preceding
   * it, since they form an exchange). Use after a bad reply to prune the
   * conversation without losing earlier context.
   */
  const deleteAssistantPair = useCallback((assistantId: string) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === assistantId);
      if (idx === -1) return prev;
      // Walk back to find the user message that produced it
      const userIdx = idx > 0 && prev[idx - 1].role === "user" ? idx - 1 : idx;
      return [...prev.slice(0, userIdx), ...prev.slice(idx + 1)];
    });
  }, []);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return {
    messages,
    isLoading,
    error,
    sendMessage,
    regenerateLast,
    deleteAssistantPair,
    clearHistory,
  };
}
