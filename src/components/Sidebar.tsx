import { useState, useEffect } from "react";
import { useCategories } from "../lib/categoriesContext";

interface Props {
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onExport: () => void;
  onNewPrompt: () => void;
  onOpenSettings: () => void;
  selectedTag: string | null;
  onClearTag: () => void;
}

const COLLAPSED_KEY = "sidebar_collapsed";

export function Sidebar({
  selectedCategory,
  onSelectCategory,
  searchQuery,
  onSearchChange,
  onExport,
  onNewPrompt,
  onOpenSettings,
  selectedTag,
  onClearTag,
}: Props) {
  const { categories } = useCategories();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  if (collapsed) {
    return (
      <aside className="w-12 bg-primary text-white flex flex-col h-full rounded-lg items-center py-3 gap-2">
        <button
          onClick={() => setCollapsed(false)}
          className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 text-lg"
          title="展开侧边栏"
          aria-label="展开侧边栏"
        >
          ☰
        </button>
        <button
          onClick={onNewPrompt}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-secondary text-primary hover:bg-accent/60 text-lg"
          title="新建提示词"
          aria-label="新建提示词"
        >
          +
        </button>
        <div className="flex-1" />
        <button
          onClick={onOpenSettings}
          className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-white/10 text-base"
          title="设置"
          aria-label="设置"
        >
          ⚙️
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-60 bg-primary text-white flex flex-col h-full rounded-lg">
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-white">提示词工作台</h2>
          <button
            onClick={() => setCollapsed(true)}
            className="text-white/90 hover:text-white text-sm font-semibold w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0"
            title="收起侧边栏"
            aria-label="收起侧边栏"
          >
            «
          </button>
        </div>
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
          className="w-full py-2 text-sm font-medium bg-secondary text-primary rounded-full hover:bg-accent/60 transition-colors duration-150 mb-4"
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
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelectCategory(c.name)}
            className={`w-full text-left px-3 py-1.5 text-sm rounded-sm mb-1 ${
              selectedCategory === c.name
                ? "bg-white/15 text-white"
                : "text-white/70 hover:bg-white/10"
            }`}
          >
            {c.name}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-white/10 space-y-2">
        <button
          onClick={onOpenSettings}
          className="w-full py-2 text-sm text-white/80 border border-white/20 rounded-full hover:bg-white/10 transition-colors duration-150"
        >
          ⚙️ 设置
        </button>
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
