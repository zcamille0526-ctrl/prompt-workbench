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

  // Reset on prompt content swap (parent should also remount the panel via
  // key prop when switching prompts; this guards against in-place edits).
  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [systemPrompt]);

  const sendMessage = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || isLoading) return;
      const apiKey = getApiKey();
      if (!apiKey) {
        setError({ code: "NO_KEY", message: "请先在设置中填入 DeepSeek API Key" });
        return;
      }

      const userMsg: UiMessage = { id: newId(), role: "user", content: trimmed };
      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setIsLoading(true);
      setError(null);

      try {
        const payload: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          ...nextHistory.map(({ role, content }) => ({ role, content })),
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
        // Don't drop the user message — let them see what they sent and retry.
      } finally {
        setIsLoading(false);
      }
    },
    [messages, isLoading, systemPrompt, model]
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  return { messages, isLoading, error, sendMessage, clearHistory };
}
