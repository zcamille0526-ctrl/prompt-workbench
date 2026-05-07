import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "./hooks/useAuth";
import { usePrompts } from "./hooks/usePrompts";
import { usePromptsPolling } from "./hooks/usePromptsPolling";
import { PasswordGate } from "./components/PasswordGate";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { PromptList } from "./components/PromptList";
import { PromptDetail } from "./components/PromptDetail";
import { PromptForm } from "./components/PromptForm";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { UserNameDialog } from "./components/UserNameDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { getUserName, setUserName } from "./lib/userName";
import type {
  Prompt,
  PromptCreateInput,
  PromptUpdateInput,
} from "./lib/schemas";

function AuthenticatedApp() {
  const {
    prompts,
    isLoading,
    fetchPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
  } = usePrompts();

  usePromptsPolling(fetchPrompts);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | undefined>();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [nameDialogOpen, setNameDialogOpen] = useState(() => !getUserName());
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const handleCreate = async (data: PromptCreateInput) => {
    const created = await createPrompt(data);
    setSelectedPrompt(created);
  };

  const handleUpdate = async (data: PromptUpdateInput) => {
    if (!editingPrompt) return;
    const updated = await updatePrompt(editingPrompt.id, data);
    setSelectedPrompt(updated);
  };

  const handleDeleteConfirm = async () => {
    if (selectedPrompt) {
      await deletePrompt(selectedPrompt.id);
      setSelectedPrompt(null);
      setDeleteOpen(false);
    }
  };

  const handleNameSubmit = (name: string) => {
    setUserName(name);
    setNameDialogOpen(false);
    fetchPrompts();
  };

  const handleNameChanged = useCallback(() => {
    // When the user renames themselves, their visible draft set changes —
    // refetch so the list reflects the new identity immediately.
    setSelectedPrompt(null);
    fetchPrompts();
  }, [fetchPrompts]);

  // If the viewer shifted (e.g. tab restored from backgrounded state after
  // name cleared), guard: keep forcing the name dialog.
  useEffect(() => {
    if (!getUserName()) setNameDialogOpen(true);
  }, []);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center text-text-primary">
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
            onOpenSettings={() => setSettingsOpen(true)}
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
            <div className="flex-1 flex items-center justify-center text-text-primary text-sm">
              选择一个提示词查看详情
            </div>
          )
        }
      />

      <PromptForm
        key={editingPrompt?.id ?? "new"}
        open={formOpen}
        onOpenChange={setFormOpen}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        initial={editingPrompt}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除提示词"
        description={`确定要删除「${selectedPrompt?.title}」吗？此操作不可撤销。`}
        onConfirm={handleDeleteConfirm}
      />

      <UserNameDialog open={nameDialogOpen} onSubmit={handleNameSubmit} />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        prompts={prompts}
        onNameChange={handleNameChanged}
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
