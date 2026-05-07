import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { useChat } from "../hooks/useChat";
import { MODELS, DEFAULT_MODEL, type ModelId } from "../lib/models";
import { hasApiKey } from "../lib/apiKey";
import { ApiKeyDialog } from "./ApiKeyDialog";

interface Props {
  /**
   * The prompt body that will be sent as the system message — already
   * variable-substituted. When this changes the chat auto-clears.
   */
  systemPrompt: string;
  /** Used as part of the React key so swapping prompts resets state. */
  promptId: string;
  /**
   * The raw, *un-substituted* prompt content from the database. Used as the
   * starting point for the temp-edit textarea so users iterate on the
   * template, not the substituted output.
   */
  originalContent: string;
  /** Variables present in content but not yet filled — disables sending. */
  hasMissingVariables: boolean;
  /** Persists the temp-edited content back to the prompt record. */
  onSaveContent: (content: string) => Promise<void>;
}

export function TestRunPanel({
  systemPrompt,
  promptId,
  originalContent,
  hasMissingVariables,
  onSaveContent,
}: Props) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [input, setInput] = useState("");
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [, forceRender] = useState(0);

  // Temp-edit: a draft of the prompt body the user can iterate on without
  // touching the saved record. When set, takes precedence over systemPrompt
  // until the user discards it or saves it back.
  const [tempContent, setTempContent] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState("");
  const [savingContent, setSavingContent] = useState(false);

  const effectiveSystemPrompt = tempContent ?? systemPrompt;

  const { messages, isLoading, error, sendMessage, clearHistory } = useChat(
    effectiveSystemPrompt,
    model
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isLoading]);

  // Reset everything when the user switches prompts
  useEffect(() => {
    setOpen(false);
    setInput("");
    setTempContent(null);
    setEditorOpen(false);
  }, [promptId]);

  const keySet = hasApiKey();
  const canSend =
    keySet && !hasMissingVariables && !isLoading && input.trim().length > 0;

  const handleOpenToggle = () => {
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

  const openEditor = () => {
    setEditorDraft(tempContent ?? originalContent);
    setEditorOpen(true);
  };

  const applyTempEdit = () => {
    setTempContent(editorDraft);
    setEditorOpen(false);
    // useChat watches systemPrompt and auto-clears, so dialogue resets
  };

  const discardTempEdit = () => {
    setTempContent(null);
    setEditorOpen(false);
  };

  const saveTempToPrompt = async () => {
    if (tempContent == null) return;
    setSavingContent(true);
    try {
      await onSaveContent(tempContent);
      setTempContent(null); // server is now source of truth; useChat will see new systemPrompt
    } finally {
      setSavingContent(false);
    }
  };

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={handleOpenToggle}
        className="btn-secondary"
        title="用当前提示词与 DeepSeek 多轮对话"
      >
        {open ? "收起试运行 ▴" : "试运行 ▾"}
      </button>

      {open && (
        <div className="mt-3 bg-gray-50 border border-gray-200 rounded-xl p-4">
          {/* Status bar */}
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
            {tempContent != null && (
              <span className="text-xs font-medium bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">
                临时编辑中
              </span>
            )}
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

          {/* Variable warning — replaces send-disabled silence */}
          {hasMissingVariables && (
            <div className="bg-amber-50 border border-amber-200 text-amber-700 text-xs rounded px-3 py-2 mb-3">
              当前提示词包含未填写的变量，请先在上方"变量填写"区填完再开始对话。
            </div>
          )}

          {/* Temp-edit toolbar */}
          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              onClick={openEditor}
              className="text-xs text-primary border border-gray-300 rounded-full px-3 py-1 hover:bg-white"
            >
              {tempContent != null ? "继续临时编辑" : "临时编辑提示词"}
            </button>
            {tempContent != null && (
              <>
                <button
                  type="button"
                  onClick={discardTempEdit}
                  className="text-xs text-text-primary/70 hover:text-error"
                >
                  丢弃临时改动
                </button>
                <button
                  type="button"
                  onClick={saveTempToPrompt}
                  disabled={savingContent}
                  className="text-xs font-medium bg-secondary text-primary rounded-full px-3 py-1 hover:bg-orange-200 disabled:opacity-50"
                >
                  {savingContent ? "保存中..." : "保存到提示词"}
                </button>
              </>
            )}
            <p className="text-xs text-text-primary/60 ml-auto">
              {tempContent != null
                ? "临时改动只用于本次对话，不会存到数据库"
                : "用于快速调试不同版本的提示词"}
            </p>
          </div>

          {/* Inline editor */}
          {editorOpen && (
            <div className="mb-3 bg-white border border-gray-200 rounded-lg p-3">
              <p className="text-xs text-text-primary/70 mb-2">
                修改提示词内容（变量 {"{{name}}"} 仍可用，会替换为变量填写区的值）
              </p>
              <textarea
                value={editorDraft}
                onChange={(e) => setEditorDraft(e.target.value)}
                rows={8}
                className="input-field font-mono text-sm"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="text-xs text-text-primary/70 px-3 py-1"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={applyTempEdit}
                  className="text-xs font-medium bg-primary text-white rounded-full px-3 py-1 hover:bg-gray-800"
                >
                  应用并清空对话
                </button>
              </div>
            </div>
          )}

          {/* Conversation */}
          <div
            ref={scrollRef}
            className="bg-white border border-gray-200 rounded-lg p-3 max-h-80 overflow-y-auto space-y-3 mb-3"
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
                      : "bg-gray-50 border border-gray-200 text-text-primary"
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
                <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-text-primary/60">
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
          forceRender((n) => n + 1);
          setOpen(true);
        }}
      />
    </div>
  );
}
