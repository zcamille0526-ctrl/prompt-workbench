import { useRef, useCallback } from "react";
import type { Prompt } from "../lib/schemas";

interface Props {
  prompts: Prompt[];
  selectedId: string | null;
  onSelect: (prompt: Prompt) => void;
  onTagClick: (tag: string) => void;
}

export function PromptList({ prompts, selectedId, onSelect, onTagClick: _onTagClick }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Radial light-follow effect: each card tracks the cursor via CSS custom
  // properties so the hover highlight rides under the pointer. Cheap — just
  // two style writes per card per mouse move, no layout thrash.
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
          className={`prompt-item w-full text-left mb-1 rounded-lg relative overflow-hidden ${
            selectedId === prompt.id ? "bg-accent/20 shadow-subtle" : ""
          }`}
        >
          <div className="relative z-10 px-3 py-2 rounded-lg transition-all duration-150">
            {/* Row 1: title | draft badge | use count */}
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-primary truncate flex-1 min-w-0">
                {prompt.title}
              </span>
              {prompt.is_draft && (
                <span className="text-[10px] font-medium bg-tertiary text-tertiary-dark rounded-full px-1.5 py-0.5 whitespace-nowrap shrink-0">
                  📝 草稿
                </span>
              )}
              {prompt.use_count > 0 && (
                <span className="text-[11px] text-text-primary/60 shrink-0 flex items-center gap-0.5 tabular-nums">
                  ↻{prompt.use_count}
                </span>
              )}
            </div>
            {/* Row 2: category chip inline with content preview */}
            <div className="flex items-center gap-1.5 mt-1 text-xs text-text-primary/75 min-w-0">
              <span className="category-chip-soft shrink-0 !py-0 !px-1.5 !text-[10px]">
                {prompt.category}
              </span>
              <span className="truncate min-w-0">
                {prompt.content.length > 40
                  ? `${prompt.content.slice(0, 40)}...`
                  : prompt.content}
              </span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
