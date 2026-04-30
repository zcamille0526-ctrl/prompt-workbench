import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Prompt } from "../lib/schemas";
import { extractVariables, substituteVariables } from "../lib/variables";

interface Props {
  prompt: Prompt;
  onEdit: () => void;
  onDelete: () => void;
}

export function PromptDetail({ prompt, onEdit, onDelete }: Props) {
  const variables = useMemo(
    () => extractVariables(prompt.content),
    [prompt.content]
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const v of prompt.variables) {
      init[v.name] = v.default || "";
    }
    return init;
  });
  const [copied, setCopied] = useState(false);

  const finalContent = useMemo(
    () => substituteVariables(prompt.content, values),
    [prompt.content, values]
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(finalContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = finalContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-medium text-primary">
              {prompt.title}
            </h2>
            <span className="category-chip">
              {prompt.category}
            </span>
          </div>
          {prompt.tags.length > 0 && (
            <div className="flex gap-1 mt-2">
              {prompt.tags.map((tag) => (
                <span
                  key={tag}
                  className="tag-chip"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="btn-secondary"
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            className="btn-pill border border-error/30 text-error hover:bg-red-50 focus-visible:ring-error/30"
          >
            删除
          </button>
        </div>
      </div>

      {variables.length > 0 && (
        <div className="glass-surface rounded-xl p-4 mb-4">
          <h3 className="text-sm font-medium text-primary mb-2">变量填写</h3>
          <div className="grid grid-cols-2 gap-2">
            {variables.map((name) => (
              <div key={name}>
                <label className="text-xs text-text-primary">{name}</label>
                <input
                  type="text"
                  value={values[name] || ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [name]: e.target.value }))
                  }
                  className="input-field"
                  placeholder={
                    prompt.variables.find((v) => v.name === name)?.default || ""
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="prose prose-sm prose-gray max-w-none mb-4 prose-headings:text-primary prose-headings:border-b prose-headings:border-gray-200 prose-headings:pb-1 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-p:text-text-primary prose-li:text-text-primary prose-strong:text-primary prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded-sm prose-code:text-sm prose-code:before:content-none prose-code:after:content-none prose-pre:bg-primary prose-pre:text-gray-100 prose-pre:rounded-lg prose-table:text-sm prose-th:bg-gray-50 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5">
        <ReactMarkdown>{finalContent}</ReactMarkdown>
      </div>

      <button
        onClick={handleCopy}
        className="btn-primary"
      >
        {copied ? "已复制" : "复制提示词"}
      </button>

      <div className="mt-4 text-xs text-text-primary">
        创建人：{prompt.created_by} · 更新于{" "}
        {new Date(prompt.updated_at).toLocaleDateString("zh-CN")}
      </div>
    </div>
  );
}
