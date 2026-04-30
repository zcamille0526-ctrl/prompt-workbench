import { CATEGORIES } from "../lib/constants";

interface Props {
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onExport: () => void;
  onNewPrompt: () => void;
  selectedTag: string | null;
  onClearTag: () => void;
}

export function Sidebar({
  selectedCategory,
  onSelectCategory,
  searchQuery,
  onSearchChange,
  onExport,
  onNewPrompt,
  selectedTag,
  onClearTag,
}: Props) {
  return (
    <aside className="w-60 bg-primary text-white flex flex-col h-full rounded-lg">
      <div className="p-4">
        <h2 className="text-lg font-medium text-white mb-4">
          提示词工作台
        </h2>
        <label className="sr-only" htmlFor="search-input">搜索</label>
        <input
          id="search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索..."
          className="w-full px-3 py-1.5 text-sm bg-white/10 border border-white/20 rounded-sm text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-white/30 mb-4"
        />
        <button
          onClick={onNewPrompt}
          className="w-full py-2 text-sm font-medium bg-secondary text-primary rounded-full hover:bg-orange-200 transition-colors duration-150 mb-4"
        >
          + 新建提示词
        </button>
      </div>

      {selectedTag && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1 text-xs">
            <span className="bg-secondary/20 text-secondary rounded-full px-2 py-0.5">
              标签：{selectedTag}
            </span>
            <button
              onClick={onClearTag}
              className="text-white/60 hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <nav className="flex-1 px-2">
        <button
          onClick={() => onSelectCategory(null)}
          className={`w-full text-left px-3 py-1.5 text-sm rounded-sm mb-1 ${
            selectedCategory === null
              ? "bg-white/15 text-white"
              : "text-white/70 hover:bg-white/10"
          }`}
        >
          全部分类
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => onSelectCategory(cat)}
            className={`w-full text-left px-3 py-1.5 text-sm rounded-sm mb-1 ${
              selectedCategory === cat
                ? "bg-white/15 text-white"
                : "text-white/70 hover:bg-white/10"
            }`}
          >
            {cat}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-white/10">
        <button
          onClick={onExport}
          className="w-full py-2 text-sm text-white/80 border border-white/20 rounded-full hover:bg-white/10 transition-colors duration-150"
        >
          导出数据
        </button>
      </div>
    </aside>
  );
}
