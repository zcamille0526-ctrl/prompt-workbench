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
          <h2 className="text-lg font-semibold text-gray-900">
            {prompt.title}
          </h2>
          <div className="flex gap-1 mt-1">
            <span className="text-xs bg-blue-100 text-blue-700 rounded px-2 py-0.5">
              {prompt.category}
            </span>
            {prompt.tags.map((tag) => (
              <span
                key={tag}
                className="text-xs bg-gray-100 text-gray-600 rounded px-2 py-0.5"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onEdit}
            className="text-sm px-3 py-1 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            编辑
          </button>
          <button
            onClick={onDelete}
            className="text-sm px-3 py-1 border border-red-300 text-red-600 rounded-md hover:bg-red-50"
          >
            删除
          </button>
        </div>
      </div>

      {variables.length > 0 && (
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">变量填写</h3>
          <div className="grid grid-cols-2 gap-2">
            {variables.map((name) => (
              <div key={name}>
                <label className="text-xs text-gray-500">{name}</label>
                <input
                  type="text"
                  value={values[name] || ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [name]: e.target.value }))
                  }
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                  placeholder={
                    prompt.variables.find((v) => v.name === name)?.default || ""
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="prose prose-sm prose-gray max-w-none mb-4 prose-headings:text-gray-800 prose-headings:border-b prose-headings:border-gray-200 prose-headings:pb-1 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-p:text-gray-700 prose-li:text-gray-700 prose-strong:text-gray-900 prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-none prose-code:after:content-none prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-table:text-sm prose-th:bg-gray-50 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5">
        <ReactMarkdown>{finalContent}</ReactMarkdown>
      </div>

      <button
        onClick={handleCopy}
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
      >
        {copied ? "已复制" : "复制提示词"}
      </button>

      <div className="mt-4 text-xs text-gray-400">
        创建人：{prompt.created_by} · 更新于{" "}
        {new Date(prompt.updated_at).toLocaleDateString("zh-CN")}
      </div>
    </div>
  );
}
