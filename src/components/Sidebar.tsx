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
    <aside className="w-56 border-r border-gray-200 bg-gray-50 flex flex-col h-full">
      <div className="p-4">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          提示词工作台
        </h2>
        <label className="sr-only" htmlFor="search-input">搜索</label>
        <input
          id="search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索..."
          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
        />
        <button
          onClick={onNewPrompt}
          className="w-full py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 mb-4"
        >
          + 新建提示词
        </button>
      </div>

      {selectedTag && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1 text-xs">
            <span className="bg-blue-100 text-blue-700 rounded px-2 py-0.5">
              标签：{selectedTag}
            </span>
            <button
              onClick={onClearTag}
              className="text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <nav className="flex-1 px-2">
        <button
          onClick={() => onSelectCategory(null)}
          className={`w-full text-left px-3 py-1.5 text-sm rounded-md mb-1 ${
            selectedCategory === null
              ? "bg-blue-100 text-blue-700"
              : "text-gray-700 hover:bg-gray-100"
          }`}
        >
          全部
        </button>
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => onSelectCategory(cat)}
            className={`w-full text-left px-3 py-1.5 text-sm rounded-md mb-1 ${
              selectedCategory === cat
                ? "bg-blue-100 text-blue-700"
                : "text-gray-700 hover:bg-gray-100"
            }`}
          >
            {cat}
          </button>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-200">
        <button
          onClick={onExport}
          className="w-full py-1.5 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-100"
        >
          导出数据
        </button>
      </div>
    </aside>
  );
}
