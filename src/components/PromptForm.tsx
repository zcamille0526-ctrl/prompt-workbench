import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CATEGORIES } from "../lib/constants";
import { PromptCreateSchema, PromptUpdateSchema } from "../lib/schemas";
import { PROMPT_TEMPLATE } from "../lib/templates";
import { getUserName } from "../lib/userName";
import type {
  Prompt,
  PromptCreateInput,
  PromptUpdateInput,
  Variable,
} from "../lib/schemas";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (data: PromptCreateInput) => Promise<void>;
  onUpdate: (data: PromptUpdateInput) => Promise<void>;
  initial?: Prompt;
}

export function PromptForm({
  open,
  onOpenChange,
  onCreate,
  onUpdate,
  initial,
}: Props) {
  const isEdit = initial !== undefined;
  const [title, setTitle] = useState(initial?.title || "");
  const [content, setContent] = useState(initial?.content || "");
  const [category, setCategory] = useState(initial?.category || "");
  const [tagsInput, setTagsInput] = useState(initial?.tags.join(", ") || "");
  const [variables, setVariables] = useState<Variable[]>(initial?.variables || []);
  const [isDraft, setIsDraft] = useState(initial?.is_draft ?? false);
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

    const cleanedVariables = variables.filter((v) => v.name.trim());

    setIsSubmitting(true);
    try {
      if (isEdit) {
        const parsed = PromptUpdateSchema.safeParse({
          title,
          content,
          category,
          tags,
          variables: cleanedVariables,
          is_draft: isDraft,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0].message);
          setIsSubmitting(false);
          return;
        }
        await onUpdate(parsed.data);
      } else {
        const userName = getUserName();
        if (!userName) {
          setError("请先在设置中填写名字");
          setIsSubmitting(false);
          return;
        }
        const parsed = PromptCreateSchema.safeParse({
          title,
          content,
          category,
          tags,
          variables: cleanedVariables,
          created_by: userName,
          is_draft: isDraft,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0].message);
          setIsSubmitting(false);
          return;
        }
        await onCreate(parsed.data);
      }
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
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-elevated z-[60]">
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
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-text-primary">
                  内容（支持 Markdown，用 {"{{变量名}}"} 定义变量）
                </label>
                {!isEdit && (
                  <button
                    type="button"
                    onClick={() => setContent(PROMPT_TEMPLATE)}
                    disabled={content.trim() !== ""}
                    className="text-xs font-medium text-primary hover:text-orange-600 disabled:text-gray-400 disabled:cursor-not-allowed"
                    title={
                      content.trim() !== ""
                        ? "内容不为空时无法插入模板，避免覆盖已有内容"
                        : "插入「角色 + 任务 + 输出格式 + 约束 + 示例」骨架"
                    }
                  >
                    📋 使用模板
                  </button>
                )}
              </div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                className="input-field font-mono"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-text-primary">变量定义</label>
                <button
                  type="button"
                  onClick={addVariable}
                  className="text-xs font-medium text-primary hover:text-orange-600"
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

            <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={isDraft}
                onChange={(e) => setIsDraft(e.target.checked)}
                className="w-4 h-4 accent-primary"
              />
              <span>
                保存为草稿
                <span className="text-xs text-text-primary/60 ml-1">
                  （只有你能看到，可以在编辑时切换为已发布）
                </span>
              </span>
            </label>

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
