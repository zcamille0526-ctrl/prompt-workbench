import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { getUserName, setUserName, isValidUserName } from "../lib/userName";
import type { Prompt } from "../lib/schemas";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompts: Prompt[];
  onNameChange: () => void;
}

export function SettingsDialog({ open, onOpenChange, prompts, onNameChange }: Props) {
  const currentName = getUserName();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [confirmStep, setConfirmStep] = useState(false);

  const draftCount = prompts.filter(
    (p) => p.is_draft && p.created_by === currentName
  ).length;

  const handleSave = () => {
    const trimmed = name.trim();
    if (!isValidUserName(trimmed)) {
      setError("名字需为 1-32 个中文/英文/数字/空格/_-");
      return;
    }
    if (trimmed === currentName) {
      onOpenChange(false);
      return;
    }
    if (draftCount > 0 && !confirmStep) {
      setConfirmStep(true);
      return;
    }
    setUserName(trimmed);
    setConfirmStep(false);
    onOpenChange(false);
    onNameChange();
  };

  const handleCancel = () => {
    setName(currentName);
    setError(null);
    setConfirmStep(false);
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
            <label className="text-sm font-medium text-text-primary">我的名字</label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
                setConfirmStep(false);
              }}
              className="input-field mt-1"
              maxLength={32}
            />
            {error && <p className="text-error text-xs mt-2">{error}</p>}
            {confirmStep && (
              <p className="text-amber-600 text-xs mt-2">
                改名后你将无法访问当前 {draftCount} 个草稿提示词，需用旧名字才能再次访问。确认改名？
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-6">
            <button onClick={handleCancel} className="btn-secondary">
              取消
            </button>
            <button onClick={handleSave} className="btn-primary">
              {confirmStep ? "确认改名" : "保存"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
