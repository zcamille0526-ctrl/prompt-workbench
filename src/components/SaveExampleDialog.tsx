import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import ReactMarkdown from "react-markdown";
import type { ChatMessage } from "../lib/api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: Array<ChatMessage & { id: string }>;
  variableValues: Record<string, string>;
  modelLabel: string;
  onSave: (title: string) => Promise<void>;
}

export function SaveExampleDialog({
  open,
  onOpenChange,
  messages,
  variableValues,
  modelLabel,
  onSave,
}: Props) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await onSave(title.trim());
      // Reset for next open
      setTitle("");
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const filledVars = Object.entries(variableValues).filter(
    ([, v]) => v.trim().length > 0
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-elevated z-[60]">
          <Dialog.Title className="text-lg font-medium text-primary">
            保存为示例
          </Dialog.Title>
          <Dialog.Description className="text-sm text-text-primary mt-2">
            其他同事打开这条提示词时能看到这次对话，作为使用参考。
          </Dialog.Description>

          <div className="mt-4">
            <label className="text-sm font-medium text-text-primary">
              示例标题（可选）
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：使用场景 - 给三年级讲光合作用"
              className="input-field mt-1"
              maxLength={100}
            />
          </div>

          {(filledVars.length > 0 || modelLabel) && (
            <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
              <div className="text-xs font-medium text-primary/70 mb-1">本次运行参数</div>
              <div className="text-text-primary">
                <span className="font-medium">模型：</span>
                {modelLabel}
              </div>
              {filledVars.length > 0 && (
                <div className="text-text-primary mt-1">
                  <span className="font-medium">变量：</span>
                  {filledVars.map(([k, v]) => `${k}=${v}`).join(", ")}
                </div>
              )}
            </div>
          )}

          <div className="mt-4">
            <div className="text-xs font-medium text-primary/70 mb-2">
              对话内容（{messages.length} 条）
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-64 overflow-y-auto space-y-2">
              {messages.map((m) => (
                <div
                  key={m.id}
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
                      <div className="prose prose-sm prose-gray max-w-none prose-p:my-1 prose-pre:my-2">
                        <ReactMarkdown>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {error && <p className="text-error text-sm mt-3">{error}</p>}

          <div className="flex justify-end gap-2 mt-5">
            <button
              onClick={() => onOpenChange(false)}
              className="btn-secondary"
              disabled={saving}
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="btn-primary disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "保存中..." : "保存示例"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
