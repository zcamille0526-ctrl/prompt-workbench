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
            <div className="font-medium text-sm text-primary truncate">
              {prompt.title}
            </div>
            <div className="text-xs mt-1 flex flex-wrap gap-1">
              <span className="tag-chip">
                {prompt.category}
              </span>
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
            <div className="text-xs text-text-primary mt-1 truncate">
              {prompt.content.length > 60
                ? `${prompt.content.slice(0, 60)}...`
                : prompt.content}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
