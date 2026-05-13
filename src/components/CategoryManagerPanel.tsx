import { useState, useRef } from "react";
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
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Shared with CategoryRow — hoist to module scope or duplicate here.
  // Create + rename both surface 'duplicate_name' from the server.
  const translateCreateError = (msg: string): string => {
    if (msg === "duplicate_name") return "该分类名已存在";
    return msg;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setOpError(null);
    setCreating(true);
    try {
      await api.createCategory(name);
      setNewName("");
      await refresh();
    } catch (e) {
      setOpError(translateCreateError(e instanceof Error ? e.message : "创建失败"));
    } finally {
      setCreating(false);
    }
  };

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
      <form onSubmit={handleCreate} className="flex gap-2 mt-3">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="新分类名"
          maxLength={32}
          className="flex-1 text-sm px-2 py-1 border border-primary/20 rounded"
        />
        <button
          type="submit"
          disabled={!newName.trim() || creating}
          className="btn-pill bg-accent text-primary text-xs px-3 py-1 disabled:opacity-50"
        >
          {creating ? "创建中..." : "+ 新建"}
        </button>
      </form>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category.name);
  // Guard against onBlur firing a second rename after Enter already submitted.
  // Enter → handleRename → setEditing(false) → input unmounts → onBlur fires.
  // Without this flag we'd double-POST the same name.
  const renamingRef = useRef(false);

  const translateError = (msg: string): string => {
    if (msg === "duplicate_name") return "该分类名已存在";
    if (msg.startsWith("in_use:")) {
      const n = msg.slice("in_use:".length);
      return `有 ${n} 条提示词在用，请先迁移`;
    }
    return msg;
  };

  const handleRename = async () => {
    if (renamingRef.current) return;
    const name = draft.trim();
    if (!name || name === category.name) {
      setEditing(false);
      setDraft(category.name);
      return;
    }
    renamingRef.current = true;
    onError(null);
    onBusy(category.id);
    try {
      await api.renameCategory(category.id, name);
      await onChanged();
      setEditing(false);
    } catch (e) {
      onError(translateError(e instanceof Error ? e.message : "重命名失败"));
    } finally {
      renamingRef.current = false;
      onBusy(null);
    }
  };

  const handleDelete = async () => {
    onError(null);
    if (!window.confirm(`确认删除分类「${category.name}」？`)) return;
    onBusy(category.id);
    try {
      await api.deleteCategory(category.id);
      await onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      onError(translateError(msg));
    } finally {
      onBusy(null);
    }
  };

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
      {editing ? (
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleRename();
            if (e.key === "Escape") { setEditing(false); setDraft(category.name); }
          }}
          onBlur={() => void handleRename()}
          autoFocus
          className="flex-1 text-sm px-1.5 py-0.5 border border-primary/30 rounded"
          maxLength={32}
        />
      ) : (
        <span className="flex-1 truncate">{category.name}</span>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={busy || editing}
        className="px-1.5 py-0.5 text-xs text-primary/70 hover:text-primary disabled:opacity-30"
        title="重命名"
      >
        ✏️
      </button>
      <button
        type="button"
        onClick={() => void handleDelete()}
        disabled={busy || editing}
        className="px-1.5 py-0.5 text-xs text-error/70 hover:text-error disabled:opacity-30"
        title="删除"
      >
        🗑️
      </button>
    </div>
  );
}
