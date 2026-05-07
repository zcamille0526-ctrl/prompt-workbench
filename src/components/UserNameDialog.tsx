import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { isValidUserName } from "../lib/userName";

interface Props {
  open: boolean;
  onSubmit: (name: string) => void;
}

export function UserNameDialog({ open, onSubmit }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!isValidUserName(trimmed)) {
      setError("名字需为 1-32 个中文/英文/数字/空格/_-");
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <Dialog.Root open={open} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface rounded-xl p-6 w-full max-w-sm shadow-elevated z-[60]"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-lg font-medium text-primary">
            请输入你的名字
          </Dialog.Title>
          <Dialog.Description className="text-sm text-text-primary mt-2">
            用于标识你创建/拥有的草稿提示词。同事之间能区分草稿归属。
          </Dialog.Description>
          <form onSubmit={handleSubmit} className="mt-4">
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="例如：camille"
              className="input-field"
              maxLength={32}
            />
            {error && <p className="text-error text-xs mt-2">{error}</p>}
            <div className="flex justify-end mt-4">
              <button type="submit" className="btn-primary">
                确认
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
