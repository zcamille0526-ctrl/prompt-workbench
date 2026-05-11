import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getApiKey, setApiKey, clearApiKey } from "../lib/apiKey";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { updateProfile, AuthError } from "../lib/authClient";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after a successful display_name change. The dialog has already
   * fed the new user into CurrentUserProvider, but the parent typically
   * also wants to refetch prompts/examples since their created_by_name
   * snapshots are stale.
   */
  onProfileUpdated?: () => void;
}

/**
 * Settings: edit display_name (calls /api/profile/update) and DeepSeek API key.
 *
 * Save behavior:
 *  - If display_name changed: PATCH /api/profile/update, push the returned
 *    user into CurrentUserProvider, and notify the parent so it can refetch
 *    lists whose created_by_name is now stale.
 *  - If only the API key changed: write/clear it locally, no network call.
 *  - If both: name first (the network one that can fail), then key.
 *  - Save closes the dialog only on success; the API-key validation error
 *    and any /api/profile/update failure stay visible.
 */
export function SettingsDialog({ open, onOpenChange, onProfileUpdated }: Props) {
  const currentUser = useCurrentUser();
  const initialName =
    currentUser.status === "authenticated" ? currentUser.user.display_name : "";
  const email =
    currentUser.status === "authenticated" ? currentUser.user.email : "";

  const [displayName, setDisplayName] = useState(initialName);
  const [apiKey, setApiKeyInput] = useState(() => getApiKey());
  const [nameError, setNameError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSave = async () => {
    setNameError(null);
    setKeyError(null);

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setNameError("显示名不能为空");
      return;
    }
    if (trimmedName.length > 64) {
      setNameError("显示名最长 64 字符");
      return;
    }

    const trimmedKey = apiKey.trim();
    if (trimmedKey && trimmedKey.length < 16) {
      setKeyError("API Key 看起来不完整，请检查");
      return;
    }

    setSubmitting(true);
    try {
      if (trimmedName !== initialName) {
        const updated = await updateProfile({ display_name: trimmedName });
        currentUser.setUser(updated);
        onProfileUpdated?.();
      }

      if (trimmedKey) {
        setApiKey(trimmedKey);
      } else {
        // empty string = explicit clear
        clearApiKey();
      }

      onOpenChange(false);
    } catch (err) {
      if (err instanceof AuthError) {
        setNameError(
          err.code === "OTHER"
            ? "保存失败，请稍后再试"
            : "保存失败：" + err.message
        );
      } else {
        setNameError("保存失败，请稍后再试");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    setDisplayName(initialName);
    setApiKeyInput(getApiKey());
    setNameError(null);
    setKeyError(null);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-sm shadow-elevated z-[60]">
          <Dialog.Title className="text-lg font-medium text-primary">
            设置
          </Dialog.Title>

          <div className="mt-4">
            <label className="text-sm font-medium text-text-primary">
              显示名
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setNameError(null);
              }}
              className="input-field mt-1"
              maxLength={64}
              disabled={submitting}
            />
            {nameError && (
              <p className="text-error text-xs mt-2">{nameError}</p>
            )}
            <p className="text-xs text-text-primary/60 mt-1">
              邮箱：<span className="font-mono">{email}</span>
            </p>
          </div>

          <div className="mt-4">
            <label className="text-sm font-medium text-text-primary">
              DeepSeek API Key（用于试运行）
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKeyInput(e.target.value);
                setKeyError(null);
              }}
              placeholder="留空则清除已保存的 Key"
              className="input-field font-mono mt-1"
              disabled={submitting}
            />
            {keyError && <p className="text-error text-xs mt-2">{keyError}</p>}
            <p className="text-xs text-text-primary/70 mt-1">
              仅保存在当前浏览器标签内存中，关闭后清空。
            </p>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button
              onClick={handleCancel}
              className="btn-secondary"
              disabled={submitting}
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="btn-primary disabled:opacity-50"
              disabled={submitting}
            >
              {submitting ? "保存中..." : "保存"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
