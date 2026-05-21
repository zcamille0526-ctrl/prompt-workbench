import { useState, useEffect } from "react";
import { useCategories } from "../lib/categoriesContext";

// Inline stroke icons (currentColor) so they inherit text color, align on the
// baseline, and stay crisp at any DPI — unlike the emoji glyphs they replace.
const MenuIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
const PlusIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
  </svg>
);
const SettingsIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);
const ExportIcon = ({ className = "w-5 h-5" }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
  </svg>
);

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
  const { categories, loading, error } = useCategories();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  if (collapsed) {
    return (
      <aside className="w-14 bg-primary text-white flex flex-col h-full rounded-lg items-center py-3 gap-2">
        <button
          onClick={() => setCollapsed(false)}
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/90 hover:bg-white/10 hover:text-white transition-colors"
          title="展开侧边栏"
          aria-label="展开侧边栏"
        >
          <MenuIcon />
        </button>
        <button
          onClick={onNewPrompt}
          className="w-11 h-11 flex items-center justify-center rounded-full bg-accent text-white hover:bg-accent-hover transition-colors"
          title="新建提示词"
          aria-label="新建提示词"
        >
          <PlusIcon />
        </button>
        <div className="flex-1" />
        <button
          onClick={onOpenSettings}
          className="w-11 h-11 flex items-center justify-center rounded-full text-white/90 hover:bg-white/10 hover:text-white transition-colors"
          title="设置"
          aria-label="设置"
        >
          <SettingsIcon />
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
            className="text-white/90 hover:text-white w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center shrink-0 transition-colors"
            title="收起侧边栏"
            aria-label="收起侧边栏"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
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
          className="w-full py-2.5 text-sm font-medium bg-accent text-white rounded-full hover:bg-accent-hover transition-colors duration-150 mb-4 flex items-center justify-center gap-1.5"
        >
          <PlusIcon className="w-4 h-4" />
          新建提示词
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
          className={`w-full text-left px-3 py-2 text-sm rounded-sm mb-1 transition-colors ${
            selectedCategory === null
              ? "bg-white/15 text-white"
              : "text-white/80 hover:bg-white/10 hover:text-white"
          }`}
        >
          全部分类
        </button>
        {loading && (
          <div className="px-3 py-1.5 text-sm text-white/50">加载中...</div>
        )}
        {error && (
          <div className="px-3 py-1.5 text-xs text-red-400">
            加载失败：{error}
          </div>
        )}
        {!loading && !error && categories.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelectCategory(c.name)}
            className={`w-full text-left px-3 py-2 text-sm rounded-sm mb-1 transition-colors ${
              selectedCategory === c.name
                ? "bg-white/15 text-white"
                : "text-white/80 hover:bg-white/10 hover:text-white"
            }`}
          >
            {c.name}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-white/10 space-y-2">
        <button
          onClick={onOpenSettings}
          className="w-full py-2 text-sm text-white/90 border border-white/25 rounded-full hover:bg-white/10 hover:text-white transition-colors duration-150 flex items-center justify-center gap-1.5"
        >
          <SettingsIcon className="w-4 h-4" />
          设置
        </button>
        <button
          onClick={onExport}
          className="w-full py-2 text-sm text-white/90 border border-white/25 rounded-full hover:bg-white/10 hover:text-white transition-colors duration-150 flex items-center justify-center gap-1.5"
        >
          <ExportIcon className="w-4 h-4" />
          导出数据
        </button>
      </div>
    </aside>
  );
}
