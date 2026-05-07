import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Example } from "../lib/schemas";
import { getUserName } from "../lib/userName";

interface Props {
  examples: Example[];
  isLoading: boolean;
  error: string | null;
  /** Owner of the parent prompt — used for the option-B delete rule. */
  promptCreatedBy: string;
  onDelete: (id: string) => Promise<void>;
}

export function ExamplesList({ examples, isLoading, error, promptCreatedBy, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const viewer = getUserName();

  // Don't render the section at all when empty — keeps the detail panel
  // uncluttered for prompts no one has tested yet. The save flow lives in
  // the test-run panel; users discover it there, not here.
  if (!isLoading && examples.length === 0 && !error) return null;

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除此示例？")) return;
    setBusyId(id);
    try {
      await onDelete(id);
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    } finally {
      setBusyId(null);
    }
  };

  const canDelete = (ex: Example) =>
    viewer && (viewer === ex.created_by || viewer === promptCreatedBy);

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left flex items-center justify-between bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg px-3 py-2 text-sm font-medium text-primary transition-colors"
      >
        <span>📝 示例输出（{examples.length}）</span>
        <span className="text-xs text-text-primary/60">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {error && (
            <p className="text-error text-xs bg-red-50 border border-red-100 rounded px-3 py-2">
              {error}
            </p>
          )}
          {examples.map((ex) => (
            <ExampleCard
              key={ex.id}
              example={ex}
              canDelete={!!canDelete(ex)}
              busy={busyId === ex.id}
              onDelete={() => void handleDelete(ex.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ExampleCard({
  example,
  canDelete,
  busy,
  onDelete,
}: {
  example: Example;
  canDelete: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const filledVars = Object.entries(example.variable_values).filter(
    ([, v]) => v && v.trim().length > 0
  );

  return (
    <div className="bg-surface border border-gray-200 rounded-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-primary">
            {example.title || `${example.created_by} 的示例`}
          </div>
          <div className="mt-1 text-xs text-text-primary/70 flex flex-wrap gap-x-3 gap-y-1">
            <span>模型：{example.model}</span>
            {filledVars.length > 0 && (
              <span>
                变量：{filledVars.map(([k, v]) => `${k}=${v}`).join(", ")}
              </span>
            )}
          </div>
        </div>
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="text-xs text-error/80 hover:text-error border border-error/20 hover:border-error/40 rounded-full px-2 py-0.5 disabled:opacity-50"
          >
            {busy ? "..." : "删除"}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-xs text-primary/70 hover:text-primary mt-2"
      >
        {expanded ? "收起对话 ▴" : `展开对话（${example.messages.length} 条）▾`}
      </button>

      {expanded && (
        <div className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2 max-h-80 overflow-y-auto">
          {example.messages.map((m, idx) => (
            <div
              key={idx}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-primary text-white"
                    : "bg-surface border border-gray-200 text-primary"
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
        </div>
      )}

      <div className="mt-2 text-xs text-text-primary/60">
        {example.created_by} · {new Date(example.created_at).toLocaleDateString("zh-CN")}
      </div>
    </div>
  );
}
