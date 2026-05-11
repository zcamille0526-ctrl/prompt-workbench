import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getApiKey, setApiKey, clearApiKey } from "../lib/apiKey";
import { useCurrentUser } from "../hooks/useCurrentUser";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Phase 2 Settings dialog: API key only.
 *
 * Display-name editing intentionally moved to Step 3 (spec §6.3) when the
 * /api/profile/update endpoint lands. Until then the user's name is shown
 * read-only here; renaming requires admin help via Supabase console.
 */
export function SettingsDialog({ open, onOpenChange }: Props) {
  const currentUser = useCurrentUser();
  const [apiKey, setApiKeyInput] = useState(() => getApiKey());
  const [keyError, setKeyError] = useState<string | null>(null);

  const handleSave = () => {
    const trimmedKey = apiKey.trim();
    if (trimmedKey && trimmedKey.length < 16) {
      setKeyError("API Key 看起来不完整，请检查");
      return;
    }

    if (trimmedKey) {
      setApiKey(trimmedKey);
    } else {
      // empty string = explicit clear
      clearApiKey();
    }

    onOpenChange(false);
  };

  const handleCancel = () => {
    setApiKeyInput(getApiKey());
    setKeyError(null);
    onOpenChange(false);
  };

  const displayName =
    currentUser.status === "authenticated" ? currentUser.user.display_name : "";
  const email =
    currentUser.status === "authenticated" ? currentUser.user.email : "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-sm shadow-elevated z-[60]">
          <Dialog.Title className="text-lg font-medium text-primary">
            设置
          </Dialog.Title>

          <div className="mt-4 text-sm text-text-primary space-y-1">
            <div>
              <span className="text-text-primary/70">显示名：</span>
              <span className="font-medium">{displayName}</span>
            </div>
            <div>
              <span className="text-text-primary/70">邮箱：</span>
              <span className="font-mono text-xs">{email}</span>
            </div>
            <p className="text-xs text-text-primary/60 pt-1">
              修改显示名将在后续版本支持。
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
            />
            {keyError && <p className="text-error text-xs mt-2">{keyError}</p>}
            <p className="text-xs text-text-primary/70 mt-1">
              仅保存在当前浏览器标签内存中，关闭后清空。
            </p>
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button onClick={handleCancel} className="btn-secondary">
              取消
            </button>
            <button onClick={handleSave} className="btn-primary">
              保存
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
