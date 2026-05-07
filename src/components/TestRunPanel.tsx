import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { useChat } from "../hooks/useChat";
import { MODELS, DEFAULT_MODEL, type ModelId } from "../lib/models";
import { hasApiKey } from "../lib/apiKey";
import { ApiKeyDialog } from "./ApiKeyDialog";

interface Props {
  systemPrompt: string;
  /** Used as part of the React key so swapping prompts resets state. */
  promptId: string;
  /** Variables present in content but not yet filled — disables sending. */
  hasMissingVariables: boolean;
}

export function TestRunPanel({ systemPrompt, promptId, hasMissingVariables }: Props) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [input, setInput] = useState("");
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [, forceRender] = useState(0);

  const { messages, isLoading, error, sendMessage, clearHistory } = useChat(
    systemPrompt,
    model
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the conversation to the bottom on new messages
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading]);

  // Reset everything when the user switches prompts
  useEffect(() => {
    setOpen(false);
    setInput("");
  }, [promptId]);

  const keySet = hasApiKey();
  const canSend = keySet && !hasMissingVariables && !isLoading && input.trim().length > 0;

  const handleOpen = () => {
    if (!keySet) {
      setKeyDialogOpen(true);
      return;
    }
    setOpen((v) => !v);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    const text = input;
    setInput("");
    void sendMessage(text);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="btn-secondary ml-2"
        title={hasMissingVariables ? "请先填写变量" : "用当前提示词与 DeepSeek 多轮对话"}
        disabled={hasMissingVariables}
      >
        {open ? "试运行 ▴" : "试运行 ▾"}
      </button>

      {open && (
        <div className="mt-4 border-t border-gray-200 pt-4">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <label className="text-sm text-text-primary">模型：</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
              className="text-sm bg-surface border border-gray-200 rounded-sm px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setKeyDialogOpen(true)}
              className="text-xs text-text-primary/70 hover:text-primary underline-offset-2 hover:underline"
            >
              修改 API Key
            </button>
            <div className="flex-1" />
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="text-xs text-text-primary/70 hover:text-primary"
              >
                清空对话
              </button>
            )}
          </div>

          <div
            ref={scrollRef}
            className="bg-gray-50 rounded-lg p-3 max-h-80 overflow-y-auto space-y-3 mb-3"
          >
            {messages.length === 0 && (
              <p className="text-xs text-text-primary/60 text-center py-4">
                输入第一条消息开始对话
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-primary text-white"
                      : "bg-white border border-gray-200 text-text-primary"
                  }`}
                >
                  {m.role === "assistant" ? (
                    <div className="prose prose-sm prose-gray max-w-none prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  )}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-text-primary/60">
                  思考中...
                </div>
              </div>
            )}
            {error && (
              <div className="text-error text-xs bg-red-50 border border-red-100 rounded px-2 py-1">
                {error.message}
              </div>
            )}
          </div>

          {messages.length >= 20 && (
            <p className="text-xs text-amber-600 mb-2">
              对话已较长，可能影响响应速度，建议必要时清空对话。
            </p>
          )}

          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                hasMissingVariables
                  ? "请先填写所有变量"
                  : "输入消息后回车发送..."
              }
              className="input-field"
              disabled={hasMissingVariables || isLoading}
            />
            <button
              type="submit"
              disabled={!canSend}
              className="btn-primary disabled:opacity-50"
            >
              发送
            </button>
          </form>
        </div>
      )}

      <ApiKeyDialog
        open={keyDialogOpen}
        onOpenChange={setKeyDialogOpen}
        onSaved={() => {
          // Re-render so the gated UI picks up the new key without remount
          forceRender((n) => n + 1);
          setOpen(true);
        }}
      />
    </>
  );
}
