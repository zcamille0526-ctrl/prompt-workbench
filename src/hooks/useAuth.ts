import { useState, useCallback } from "react";
import { api } from "../lib/api";

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => !!api.getToken()
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const success = await api.verify(password);
      if (success) {
        setIsAuthenticated(true);
      } else {
        setError("密码错误");
      }
    } catch {
      setError("验证失败，请重试");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    api.clearToken();
    setIsAuthenticated(false);
  }, []);

  return { isAuthenticated, isLoading, error, login, logout };
}
