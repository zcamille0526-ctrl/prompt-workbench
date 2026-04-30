import { useState } from "react";

interface Props {
  onLogin: (password: string) => Promise<void>;
  isLoading: boolean;
  error: string | null;
}

export function PasswordGate({ onLogin, isLoading, error }: Props) {
  const [password, setPassword] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.trim()) {
      onLogin(password);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <form
        onSubmit={handleSubmit}
        className="bg-surface p-8 rounded-xl shadow-elevated w-full max-w-sm"
      >
        <h1 className="text-xl font-medium text-primary mb-6 text-center">
          提示词工作台
        </h1>
        <label className="sr-only" htmlFor="password-input">访问密码</label>
        <input
          id="password-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入访问密码"
          className="input-field mb-4"
          autoFocus
        />
        {error && (
          <p className="text-error text-sm mb-4">{error}</p>
        )}
        <button
          type="submit"
          disabled={isLoading || !password.trim()}
          className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "验证中..." : "进入"}
        </button>
      </form>
    </div>
  );
}
