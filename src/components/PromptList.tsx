import { useRef, useCallback } from "react";
import type { Prompt } from "../lib/schemas";

interface Props {
  prompts: Prompt[];
  selectedId: string | null;
  onSelect: (prompt: Prompt) => void;
  onTagClick: (tag: string) => void;
}

export function PromptList({ prompts, selectedId, onSelect, onTagClick }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const items = listRef.current?.querySelectorAll<HTMLElement>("[data-prompt-item]");
    if (!items) return;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      item.style.setProperty("--mouse-x", `${x}px`);
      item.style.setProperty("--mouse-y", `${y}px`);
    }
  }, []);

  if (prompts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-primary text-sm">
        暂无提示词
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="flex-1 overflow-y-auto p-2"
      onMouseMove={handleMouseMove}
    >
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          data-prompt-item
          onClick={() => onSelect(prompt)}
          className={`prompt-item w-full text-left mb-1.5 rounded-xl relative overflow-hidden ${
            selectedId === prompt.id ? "bg-secondary/50 shadow-subtle" : ""
          }`}
        >
          <div className={`relative z-10 p-3 rounded-xl transition-all duration-150`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-primary truncate flex-1">
                {prompt.title}
              </span>
              {prompt.is_draft && (
                <span className="text-[10px] font-medium bg-amber-100 text-amber-700 rounded-full px-1.5 py-0.5 whitespace-nowrap shrink-0">
                  📝 草稿
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <span className="category-chip-soft">{prompt.category}</span>
              {prompt.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTagClick(tag);
                  }}
                  className="tag-chip-interactive"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex items-end justify-between gap-2 mt-1.5">
              <div className="text-xs text-text-primary truncate flex-1 min-w-0">
                {prompt.content.length > 60
                  ? `${prompt.content.slice(0, 60)}...`
                  : prompt.content}
              </div>
              {prompt.use_count > 0 && (
                <span className="text-xs text-text-primary/60 shrink-0 flex items-center gap-0.5">
                  ↻ {prompt.use_count}
                </span>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
