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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form
        onSubmit={handleSubmit}
        className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm"
      >
        <h1 className="text-xl font-semibold text-gray-900 mb-6 text-center">
          提示词工作台
        </h1>
        <label className="sr-only" htmlFor="password-input">访问密码</label>
        <input
          id="password-input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入访问密码"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          autoFocus
        />
        {error && (
          <p className="text-red-500 text-sm mb-4">{error}</p>
        )}
        <button
          type="submit"
          disabled={isLoading || !password.trim()}
          className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "验证中..." : "进入"}
        </button>
      </form>
    </div>
  );
}
