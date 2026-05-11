import { useState, useMemo, useCallback, useEffect } from "react";
import { CurrentUserProvider, useCurrentUser } from "./hooks/useCurrentUser";
import { usePrompts } from "./hooks/usePrompts";
import { usePromptsPolling } from "./hooks/usePromptsPolling";
import { Layout } from "./components/Layout";
import { Sidebar } from "./components/Sidebar";
import { PromptList } from "./components/PromptList";
import { PromptDetail } from "./components/PromptDetail";
import { PromptForm } from "./components/PromptForm";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { AuthScreen } from "./components/AuthScreen";
import { AuthCallback } from "./components/AuthCallback";
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Keep selectedPrompt in sync with the latest list snapshot. Without this,
  // a rename (Settings → display_name) would refresh the list view but
  // PromptDetail's "created人:旧名" / authoredness checks would stay stale
  // until the user re-selected. Polling also runs through here cheaply —
  // the list's freshly-joined creator profile becomes visible on the next
  // tick without any manual reselect.
  useEffect(() => {
    if (!selectedPrompt) return;
    const fresh = prompts.find((p) => p.id === selectedPrompt.id);
    if (!fresh) return;
    // Reference equality short-circuits the no-op case so we don't churn
    // children that depend on the prompt object identity.
    if (fresh !== selectedPrompt) {
      setSelectedPrompt(fresh);
    }
  }, [prompts, selectedPrompt]);

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

  const handleTogglePublish = async (next: boolean) => {
    if (!selectedPrompt) return;
    const updated = await updatePrompt(selectedPrompt.id, {
      title: selectedPrompt.title,
      content: selectedPrompt.content,
      category: selectedPrompt.category,
      tags: selectedPrompt.tags,
      variables: selectedPrompt.variables,
      is_draft: next,
    });
    setSelectedPrompt(updated);
  };

  const handleSaveContent = async (content: string) => {
    if (!selectedPrompt) return;
    const updated = await updatePrompt(selectedPrompt.id, {
      title: selectedPrompt.title,
      content,
      category: selectedPrompt.category,
      tags: selectedPrompt.tags,
      variables: selectedPrompt.variables,
      is_draft: selectedPrompt.is_draft,
    });
    setSelectedPrompt(updated);
  };

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
              onTogglePublish={handleTogglePublish}
              onSaveContent={handleSaveContent}
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

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onProfileUpdated={() => {
          // After a rename: refetch the list so created_by_name snapshots
          // refresh, then drop the selection. Dropping selectedPrompt is
          // the pragmatic fix for the "examples list shows old creator
          // names" problem — useExamples is keyed on promptId and would
          // otherwise keep its previous snapshot until the user navigates
          // away and back. The user just confirmed a settings dialog so
          // losing the selection is acceptable; re-selecting re-fetches
          // examples with the fresh names.
          void fetchPrompts();
          setSelectedPrompt(null);
        }}
      />
    </>
  );
}

/**
 * Routing — spec §6.4 mandates this exact ordering:
 *
 *   1. /auth/callback FIRST. The invite-link landing page must render
 *      before any session check. Otherwise, an anonymous user clicking
 *      a fresh invite would be bounced into the AuthScreen (no session
 *      yet → looks anonymous), and the email-verification flow would
 *      silently break.
 *   2. Loading state for the initial /api/auth/me probe so we don't
 *      flash AuthScreen for an authenticated user mid-bootstrap.
 *   3. Anonymous → AuthScreen (login + signup tabs).
 *   4. Authenticated → AuthenticatedApp.
 */
function AppRoutes() {
  const currentUser = useCurrentUser();

  if (window.location.pathname === "/auth/callback") {
    return (
      <AuthCallback
        onAuthenticated={(user) => {
          currentUser.setUser(user);
          // Land in main app on the self-heal path. Replace history so
          // back-button doesn't take the user to a stale callback URL.
          window.history.replaceState({}, "", "/");
        }}
        onRequireLogin={() => {
          // First-setup path: server revoked the invite session. Push the
          // user back to the login screen with a clean URL.
          window.history.replaceState({}, "", "/");
          // Force re-render by reloading — simpler than wiring a "go to
          // login" state through three layers, and the page hits sub-100ms
          // since /api/auth/me will 401 and we land on AuthScreen.
          window.location.reload();
        }}
      />
    );
  }

  if (currentUser.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center text-text-primary">
        加载中...
      </div>
    );
  }

  if (currentUser.status === "anonymous") {
    return (
      <AuthScreen
        onLoggedIn={(data) => {
          currentUser.setUser(data.user_summary);
        }}
      />
    );
  }

  return <AuthenticatedApp />;
}

export default function App() {
  return (
    <CurrentUserProvider>
      <AppRoutes />
    </CurrentUserProvider>
  );
}
