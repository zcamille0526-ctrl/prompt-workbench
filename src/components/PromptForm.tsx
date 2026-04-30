import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CATEGORIES } from "../lib/constants";
import { PromptSchema } from "../lib/schemas";
import type { Prompt, PromptInput, Variable } from "../lib/schemas";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: PromptInput) => Promise<void>;
  initial?: Prompt;
}

export function PromptForm({ open, onOpenChange, onSubmit, initial }: Props) {
  const [title, setTitle] = useState(initial?.title || "");
  const [content, setContent] = useState(initial?.content || "");
  const [category, setCategory] = useState(initial?.category || "");
  const [tagsInput, setTagsInput] = useState(initial?.tags.join(", ") || "");
  const [variables, setVariables] = useState<Variable[]>(initial?.variables || []);
  const [createdBy, setCreatedBy] = useState(initial?.created_by || "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const addVariable = () => {
    setVariables((prev) => [...prev, { name: "", default: "" }]);
  };

  const removeVariable = (index: number) => {
    setVariables((prev) => prev.filter((_, i) => i !== index));
  };

  const updateVariable = (index: number, field: "name" | "default", value: string) => {
    setVariables((prev) =>
      prev.map((v, i) => (i === index ? { ...v, [field]: value } : v))
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const tags = tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);

    const data = {
      title,
      content,
      category,
      tags,
      variables: variables.filter((v) => v.name.trim()),
      created_by: createdBy,
    };

    const parsed = PromptSchema.safeParse(data);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit(parsed.data);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-elevated">
          <Dialog.Title className="text-xl font-medium text-primary mb-6">
            {initial ? "编辑提示词" : "新建提示词"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-text-primary">标题</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="input-field mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary">分类</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="input-field mt-1"
              >
                <option value="">请选择</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary">标签（逗号分隔）</label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="如：儿童, 科普, 绘本"
                className="input-field mt-1"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary">
                内容（支持 Markdown，用 {"{{变量名}}"} 定义变量）
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                className="input-field mt-1 font-mono"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-text-primary">变量定义</label>
                <button
                  type="button"
                  onClick={addVariable}
                  className="text-xs font-medium text-secondary hover:text-orange-300"
                >
                  + 添加变量
                </button>
              </div>
              {variables.map((v, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={v.name}
                    onChange={(e) => updateVariable(i, "name", e.target.value)}
                    placeholder="变量名"
                    className="input-field"
                  />
                  <input
                    type="text"
                    value={v.default || ""}
                    onChange={(e) => updateVariable(i, "default", e.target.value)}
                    placeholder="默认值（可选）"
                    className="input-field"
                  />
                  <button
                    type="button"
                    onClick={() => removeVariable(i)}
                    className="text-error text-sm px-2 hover:text-red-700"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary">创建人</label>
              <input
                type="text"
                value={createdBy}
                onChange={(e) => setCreatedBy(e.target.value)}
                className="input-field mt-1"
              />
            </div>

            {error && <p className="text-error text-sm">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Close className="btn-secondary">
                取消
              </Dialog.Close>
              <button
                type="submit"
                disabled={isSubmitting}
                className="btn-primary disabled:opacity-50"
              >
                {isSubmitting ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
