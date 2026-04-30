import { useState, useMemo, useCallback } from "react";
import { useAuth } from "./hooks/useAuth";
import { usePrompts } from "./hooks/usePrompts";
import { useRealtimePrompts } from "./hooks/useRealtimePrompts";
import { PasswordGate } from "./components/PasswordGate";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { PromptList } from "./components/PromptList";
import { PromptDetail } from "./components/PromptDetail";
import { PromptForm } from "./components/PromptForm";
import { ConfirmDialog } from "./components/ConfirmDialog";
import type { Prompt, PromptInput } from "./lib/schemas";

function AuthenticatedApp() {
  const {
    prompts,
    isLoading,
    fetchPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
  } = usePrompts();

  useRealtimePrompts(fetchPrompts);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const filteredPrompts = useMemo(() => {
    let result = prompts;
    if (selectedCategory) {
      result = result.filter((p) => p.category === selectedCategory);
    }
    if (selectedTag) {
      result = result.filter((p) => p.tags.includes(selectedTag));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.content.toLowerCase().includes(q)
      );
    }
    return result;
  }, [prompts, selectedCategory, selectedTag, searchQuery]);

  const handleTagClick = useCallback((tag: string) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  }, []);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(prompts, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prompts-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [prompts]);

  const handleNewPrompt = () => {
    setEditingPrompt(undefined);
    setFormOpen(true);
  };

  const handleEdit = () => {
    setEditingPrompt(selectedPrompt || undefined);
    setFormOpen(true);
  };

  const handleFormSubmit = async (data: PromptInput) => {
    if (editingPrompt) {
      const updated = await updatePrompt(editingPrompt.id, data);
      setSelectedPrompt(updated);
    } else {
      const created = await createPrompt(data);
      setSelectedPrompt(created);
    }
  };

  const handleDeleteConfirm = async () => {
    if (selectedPrompt) {
      await deletePrompt(selectedPrompt.id);
      setSelectedPrompt(null);
      setDeleteOpen(false);
    }
  };

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  return (
    <>
      <Layout
        sidebar={
          <Sidebar
            selectedCategory={selectedCategory}
            onSelectCategory={(cat) => {
              setSelectedCategory(cat);
              setSelectedTag(null);
            }}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onExport={handleExport}
            onNewPrompt={handleNewPrompt}
            selectedTag={selectedTag}
            onClearTag={() => setSelectedTag(null)}
          />
        }
        list={
          <PromptList
            prompts={filteredPrompts}
            selectedId={selectedPrompt?.id || null}
            onSelect={setSelectedPrompt}
            onTagClick={handleTagClick}
          />
        }
        detail={
          selectedPrompt ? (
            <PromptDetail
              key={selectedPrompt.id}
              prompt={selectedPrompt}
              onEdit={handleEdit}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
              选择一个提示词查看详情
            </div>
          )
        }
      />

      <PromptForm
        key={editingPrompt?.id ?? "new"}
        open={formOpen}
        onOpenChange={setFormOpen}
        onSubmit={handleFormSubmit}
        initial={editingPrompt}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除提示词"
        description={`确定要删除「${selectedPrompt?.title}」吗？此操作不可撤销。`}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}

export default function App() {
  const { isAuthenticated, isLoading, error, login } = useAuth();

  if (!isAuthenticated) {
    return (
      <PasswordGate onLogin={login} isLoading={isLoading} error={error} />
    );
  }

  return <AuthenticatedApp />;
}
