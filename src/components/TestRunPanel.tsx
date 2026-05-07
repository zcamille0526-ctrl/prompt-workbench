import { useState, useEffect, useRef, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useChat } from "../hooks/useChat";
import { MODELS, DEFAULT_MODEL, type ModelId } from "../lib/models";
import { hasApiKey } from "../lib/apiKey";
import { substituteVariables } from "../lib/variables";
import { ApiKeyDialog } from "./ApiKeyDialog";

interface Props {
  /** Used as part of the React key so swapping prompts resets state. */
  promptId: string;
  /**
   * Raw prompt body from the database (with {{variables}}). Used both as
   * the editor pre-fill and as the source for substitution.
   */
  originalContent: string;
  /**
   * Current values from the parent's variable-fill panel. Used to substitute
   * variables in either the saved content or the user's temp-edit before
   * sending to the LLM. Updates here flow into the next API call.
   */
  variableValues: Record<string, string>;
  /** Variables present in content but not yet filled — disables sending. */
  hasMissingVariables: boolean;
  /** Persists the temp-edited content back to the prompt record. */
  onSaveContent: (content: string) => Promise<void>;
}

export function TestRunPanel({
  promptId,
  originalContent,
  variableValues,
  hasMissingVariables,
  onSaveContent,
}: Props) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [input, setInput] = useState("");
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [, forceRender] = useState(0);

  // Temp-edit: a draft of the prompt body the user can iterate on without
  // touching the saved record. When set, takes precedence over originalContent
  // until the user discards it or saves it back.
  const [tempContent, setTempContent] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorDraft, setEditorDraft] = useState("");
  const [savingContent, setSavingContent] = useState(false);

  // Substitute variables on whichever body we're using. This is what the LLM
  // actually sees as the system prompt, and it updates as the user edits the
  // variable-fill panel — no need to re-trigger anything.
  const effectiveSystemPrompt = useMemo(
    () => substituteVariables(tempContent ?? originalContent, variableValues),
    [tempContent, originalContent, variableValues]
  );

  const { messages, isLoading, error, sendMessage, regenerateLast, deleteAssistantPair, clearHistory } = useChat(
    effectiveSystemPrompt,
    model
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
      setTempContent(null);
    } finally {
      setSavingContent(false);
    }
  };

  // All three temp-edit actions share the same pill silhouette so users
  // recognize them as a coherent button group; only the color signals intent.
  const pillBase =
    "text-xs font-medium rounded-full px-3 py-1.5 transition-colors duration-150 disabled:opacity-50";

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={handleOpenToggle}
        className="btn-pill bg-secondary text-primary border border-secondary hover:bg-orange-200 focus-visible:ring-secondary/50 font-medium"
        title="用当前提示词与 DeepSeek 多轮对话"
      >
        {open ? "收起试运行 ▴" : "试运行 ▾"}
      </button>

      {open && (
        <div className="mt-3 bg-secondary/30 border-2 border-secondary rounded-xl p-4 text-text-primary">
          {/* Status bar */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <label className="text-sm font-medium text-primary">模型：</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
              className="text-sm font-medium bg-surface border border-gray-300 rounded-sm px-2 py-1 text-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
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
              className="text-xs font-medium text-primary/70 hover:text-primary underline-offset-2 hover:underline"
            >
              修改 API Key
            </button>
            <div className="flex-1" />
            {tempContent != null && (
              <span className="text-xs font-semibold bg-amber-200 text-amber-900 rounded-full px-2 py-0.5">
                临时编辑中
              </span>
            )}
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clearHistory}
                className="text-xs font-medium bg-surface text-primary border border-gray-300 rounded-full px-3 py-1 hover:bg-gray-50"
              >
                清空对话
              </button>
            )}
          </div>

          {hasMissingVariables && (
            <div className="bg-amber-100 border border-amber-300 text-amber-800 text-sm font-medium rounded px-3 py-2 mb-3">
              当前提示词包含未填写的变量，请先在上方"变量填写"区填完再开始对话。
            </div>
          )}

          {/* Temp-edit toolbar — three pills sharing the same silhouette */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <button
              type="button"
              onClick={openEditor}
              className={`${pillBase} bg-surface text-primary border border-gray-300 hover:bg-gray-50`}
            >
              {tempContent != null ? "继续临时编辑" : "临时编辑提示词"}
            </button>
            {tempContent != null && (
              <>
                <button
                  type="button"
                  onClick={discardTempEdit}
                  className={`${pillBase} bg-surface text-error border border-error/40 hover:bg-red-50`}
                >
                  丢弃临时改动
                </button>
                <button
                  type="button"
                  onClick={saveTempToPrompt}
                  disabled={savingContent}
                  className={`${pillBase} bg-primary text-white border border-primary hover:bg-gray-800`}
                >
                  {savingContent ? "保存中..." : "保存到提示词"}
                </button>
              </>
            )}
            <p className="text-xs text-primary/60 ml-auto">
              {tempContent != null
                ? "临时改动只用于本次对话，不会存到数据库"
                : "用于快速调试不同版本的提示词"}
            </p>
          </div>

          {editorOpen && (
            <div className="mb-3 bg-surface border border-gray-300 rounded-lg p-3">
              <p className="text-xs text-primary/70 mb-2 font-medium">
                修改提示词内容（变量 {"{{name}}"} 仍可用，会替换为变量填写区的值）
              </p>
              <textarea
                value={editorDraft}
                onChange={(e) => setEditorDraft(e.target.value)}
                rows={10}
                className="input-field font-mono text-sm text-primary"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className={`${pillBase} bg-surface text-primary border border-gray-300 hover:bg-gray-50`}
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={applyTempEdit}
                  className={`${pillBase} bg-primary text-white border border-primary hover:bg-gray-800`}
                >
                  应用并清空对话
                </button>
              </div>
            </div>
          )}

          {/* Conversation */}
          <div
            ref={scrollRef}
            className="bg-surface border border-gray-300 rounded-lg p-3 max-h-96 min-h-[200px] overflow-y-auto space-y-3 mb-3"
          >
            {messages.length === 0 && (
              <p className="text-sm text-primary/50 text-center py-8">
                输入第一条消息开始对话
              </p>
            )}
            {messages.map((m, idx) => {
              const isAssistant = m.role === "assistant";
              const isLast = idx === messages.length - 1;
              return (
                <div key={m.id} className={isAssistant ? "" : "flex justify-end"}>
                  <div
                    className={
                      isAssistant
                        ? "max-w-[90%]"
                        : "max-w-[85%] rounded-lg px-3 py-2 text-sm bg-primary text-white font-medium"
                    }
                  >
                    {isAssistant ? (
                      <>
                        <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-primary">
                          <div className="prose prose-sm prose-gray max-w-none prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-p:text-primary prose-li:text-primary prose-strong:text-primary">
                            <ReactMarkdown>{m.content}</ReactMarkdown>
                          </div>
                        </div>
                        <AssistantActions
                          message={m.content}
                          isLast={isLast}
                          isLoading={isLoading}
                          onRegenerate={() => void regenerateLast()}
                          onDelete={() => deleteAssistantPair(m.id)}
                          onAskFollowup={() => inputRef.current?.focus()}
                        />
                      </>
                    ) : (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    )}
                  </div>
                </div>
              );
            })}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm text-primary/60">
                  思考中...
                </div>
              </div>
            )}
            {error && (
              <div className="text-error text-sm font-medium bg-red-50 border border-red-200 rounded px-3 py-2">
                {error.message}
              </div>
            )}
          </div>

          {messages.length >= 20 && (
            <p className="text-xs text-amber-700 mb-2 font-medium">
              对话已较长，可能影响响应速度，建议必要时清空对话。
            </p>
          )}

          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                hasMissingVariables
                  ? "请先填写所有变量"
                  : "输入消息后回车发送..."
              }
              className="input-field text-primary"
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

/**
 * Action strip rendered under each assistant reply. Uses plain text labels
 * (not icon-only) because icons without text read as decoration to most
 * users — the whole point is affordance.
 *
 * 重新生成 is only offered on the most recent assistant message: regenerating
 * older replies would strand subsequent turns that were conditioned on them.
 */
function AssistantActions({
  message,
  isLast,
  isLoading,
  onRegenerate,
  onDelete,
  onAskFollowup,
}: {
  message: string;
  isLast: boolean;
  isLoading: boolean;
  onRegenerate: () => void;
  onDelete: () => void;
  onAskFollowup: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = message;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const actionClass =
    "text-xs text-primary/60 hover:text-primary hover:bg-white/60 rounded-full px-2 py-0.5 transition-colors";

  return (
    <div className="flex items-center gap-1 mt-1 pl-1">
      <button type="button" onClick={handleCopy} className={actionClass}>
        {copied ? "已复制" : "复制"}
      </button>
      {isLast && (
        <button
          type="button"
          onClick={onRegenerate}
          disabled={isLoading}
          className={`${actionClass} disabled:opacity-40`}
        >
          重新生成
        </button>
      )}
      <button
        type="button"
        onClick={onAskFollowup}
        disabled={isLoading}
        className={`${actionClass} disabled:opacity-40`}
      >
        追问
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={isLoading}
        className={`${actionClass} hover:text-error disabled:opacity-40`}
      >
        删除
      </button>
    </div>
  );
}
