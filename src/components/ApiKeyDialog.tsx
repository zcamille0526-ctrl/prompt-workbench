import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { setApiKey, getApiKey } from "../lib/apiKey";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

export function ApiKeyDialog({ open, onOpenChange, onSaved }: Props) {
  const [value, setValue] = useState(() => getApiKey());
  const [error, setError] = useState<string | null>(null);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("API Key 不能为空");
      return;
    }
    if (trimmed.length < 16) {
      setError("API Key 看起来不完整，请检查");
      return;
    }
    setApiKey(trimmed);
    onOpenChange(false);
    onSaved?.();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-sm shadow-elevated z-[60]">
          <Dialog.Title className="text-lg font-medium text-primary">
            DeepSeek API Key
          </Dialog.Title>
          <Dialog.Description className="text-sm text-text-primary mt-2">
            用于试运行提示词。仅保存在当前浏览器标签的内存中，关闭后清空。
          </Dialog.Description>
          <form onSubmit={handleSave} className="mt-4">
            <input
              autoFocus
              type="password"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder="sk-..."
              className="input-field font-mono"
            />
            {error && <p className="text-error text-xs mt-2">{error}</p>}
            <p className="text-xs text-text-primary/70 mt-2">
              在{" "}
              <a
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary"
              >
                DeepSeek 控制台
              </a>{" "}
              获取
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="btn-secondary"
              >
                取消
              </button>
              <button type="submit" className="btn-primary">
                保存
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
