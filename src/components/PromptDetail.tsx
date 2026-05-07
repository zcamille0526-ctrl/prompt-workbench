import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Prompt } from "../lib/schemas";
import { extractVariables, substituteVariables } from "../lib/variables";
import { api } from "../lib/api";
import { getUserName } from "../lib/userName";
import { TestRunPanel } from "./TestRunPanel";
import { ExamplesList } from "./ExamplesList";
import { useExamples } from "../hooks/useExamples";

interface Props {
  prompt: Prompt;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePublish: (next: boolean) => Promise<void>;
  onSaveContent: (content: string) => Promise<void>;
}

export function PromptDetail({ prompt, onEdit, onDelete, onTogglePublish, onSaveContent }: Props) {
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
  const [isToggling, setIsToggling] = useState(false);
  // optimistic local count: bumped on copy, reset to server value when the
  // selected prompt changes (parent passes a new prompt object via key prop)
  const [localCount, setLocalCount] = useState(prompt.use_count);

  const finalContent = useMemo(
    () => substituteVariables(prompt.content, values),
    [prompt.content, values]
  );

  const isOwner = prompt.created_by === getUserName();

  // Examples lifted here so both the test-run save action and the list view
  // share state — saving an example optimistically prepends it to the list.
  const { examples, isLoading: examplesLoading, error: examplesError, createExample, deleteExample } =
    useExamples(prompt.id);

  const handleSaveExample = async (input: {
    title: string;
    model: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    variable_values: Record<string, string>;
  }) => {
    const userName = getUserName();
    if (!userName) throw new Error("请先在设置中填写名字");
    await createExample({
      prompt_id: prompt.id,
      title: input.title || undefined,
      variable_values: input.variable_values,
      model: input.model,
      messages: input.messages,
      created_by: userName,
    });
  };

  const handleTogglePublish = async () => {
    setIsToggling(true);
    try {
      await onTogglePublish(!prompt.is_draft);
    } finally {
      setIsToggling(false);
    }
  };

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
    setLocalCount((c) => c + 1);
    void api.incrementUseCount(prompt.id);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-start justify-between mb-4 gap-4">
        <div className="min-w-0 flex-1">
          {/* Title row: identity + state badge only */}
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-semibold text-primary">
              {prompt.title}
            </h2>
            {prompt.is_draft && (
              <span className="text-xs font-medium bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 whitespace-nowrap">
                📝 草稿
              </span>
            )}
          </div>
          {/* Meta row: category and tags share visual weight */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="category-chip-soft">{prompt.category}</span>
            {prompt.tags.length > 0 && (
              <>
                <span className="text-gray-300 text-xs">·</span>
                {prompt.tags.map((tag) => (
                  <span key={tag} className="tag-chip">
                    {tag}
                  </span>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          {prompt.is_draft && isOwner && (
            <button
              onClick={handleTogglePublish}
              disabled={isToggling}
              className="btn-pill bg-secondary text-primary hover:bg-orange-200 focus-visible:ring-secondary/50 disabled:opacity-50"
            >
              {isToggling ? "发布中..." : "发布"}
            </button>
          )}
          {!prompt.is_draft && isOwner && (
            <button
              onClick={handleTogglePublish}
              disabled={isToggling}
              className="text-xs text-text-primary/70 hover:text-primary underline-offset-2 hover:underline disabled:opacity-50 px-2"
              title="只有自己能再次看到"
            >
              {isToggling ? "处理中..." : "转为草稿"}
            </button>
          )}
          {isOwner && (
            <>
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
            </>
          )}
        </div>
      </div>

      {variables.length > 0 && (
        <div className="glass-surface rounded-xl p-4 mb-4 max-w-md">
          <h3 className="text-sm font-medium text-primary mb-2">变量填写</h3>
          <div className="space-y-2">
            {variables.map((name) => (
              <div key={name} className="flex items-center gap-2">
                <label className="text-xs text-text-primary shrink-0 w-16 truncate">{name}</label>
                <input
                  type="text"
                  value={values[name] || ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [name]: e.target.value }))
                  }
                  className="input-field max-w-[120px]"
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
        创建人:{prompt.created_by} · 更新于{" "}
        {new Date(prompt.updated_at).toLocaleDateString("zh-CN")}
        {localCount > 0 && ` · 使用 ${localCount} 次`}
      </div>

      <ExamplesList
        examples={examples}
        isLoading={examplesLoading}
        error={examplesError}
        promptCreatedBy={prompt.created_by}
        onDelete={deleteExample}
      />

      <TestRunPanel
        promptId={prompt.id}
        originalContent={prompt.content}
        variableValues={values}
        hasMissingVariables={variables.some((name) => !(values[name] ?? "").trim())}
        onSaveContent={onSaveContent}
        onSaveExample={handleSaveExample}
      />
    </div>
  );
}
