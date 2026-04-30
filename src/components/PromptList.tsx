import type { Prompt } from "../lib/schemas";

interface Props {
  prompts: Prompt[];
  selectedId: string | null;
  onSelect: (prompt: Prompt) => void;
  onTagClick: (tag: string) => void;
}

export function PromptList({ prompts, selectedId, onSelect, onTagClick }: Props) {
  if (prompts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        暂无提示词
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          onClick={() => onSelect(prompt)}
          className={`w-full text-left p-3 border-b border-gray-100 hover:bg-gray-50 ${
            selectedId === prompt.id ? "bg-blue-50" : ""
          }`}
        >
          <div className="font-medium text-sm text-gray-900 truncate">
            {prompt.title}
          </div>
          <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-1">
            <span className="inline-block bg-gray-100 rounded px-1.5 py-0.5">
              {prompt.category}
            </span>
            {prompt.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                onClick={(e) => {
                  e.stopPropagation();
                  onTagClick(tag);
                }}
                className="inline-block bg-gray-100 rounded px-1.5 py-0.5 hover:bg-blue-100 hover:text-blue-700 cursor-pointer"
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="text-xs text-gray-400 mt-1 truncate">
            {prompt.content.length > 60
              ? `${prompt.content.slice(0, 60)}...`
              : prompt.content}
          </div>
        </button>
      ))}
    </div>
  );
}
