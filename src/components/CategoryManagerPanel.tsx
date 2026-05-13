import { useState } from "react";
import { useCategories } from "../lib/categoriesContext";
import { api } from "../lib/api";
import type { Category } from "../lib/schemas";

/**
 * Admin-only panel rendered inside SettingsDialog. Provides CRUD + reorder
 * for the categories table. Parent already gates on currentUser.is_admin
 * before rendering this; we don't re-check here.
 */
export function CategoryManagerPanel() {
  const { categories, refresh, error: listError } = useCategories();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  return (
    <div className="border-t border-primary/10 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-primary mb-2">分类管理</h3>
      {listError && <p className="text-error text-xs mb-2">{listError}</p>}
      {opError && <p className="text-error text-xs mb-2">{opError}</p>}
      <div className="space-y-1">
        {categories.map((c, idx) => (
          <CategoryRow
            key={c.id}
            category={c}
            isFirst={idx === 0}
            isLast={idx === categories.length - 1}
            busy={busyId === c.id}
            onBusy={setBusyId}
            onError={setOpError}
            onChanged={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  isFirst,
  isLast,
  busy,
  onBusy,
  onError,
  onChanged,
}: {
  category: Category;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onBusy: (id: string | null) => void;
  onError: (msg: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const handleMove = async (direction: "up" | "down") => {
    onError(null);
    onBusy(category.id);
    try {
      await api.moveCategory(category.id, direction);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "移动失败");
    } finally {
      onBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1 text-sm">
      <button
        type="button"
        disabled={isFirst || busy}
        onClick={() => void handleMove("up")}
        className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
        title="上移"
      >
        ↑
      </button>
      <button
        type="button"
        disabled={isLast || busy}
        onClick={() => void handleMove("down")}
        className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
        title="下移"
      >
        ↓
      </button>
      <span className="flex-1 truncate">{category.name}</span>
      {/* rename + delete buttons come in Task 17/18 */}
    </div>
  );
}
