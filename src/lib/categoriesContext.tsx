import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import type { Category } from "./schemas";

type CategoriesCtx = {
  categories: Category[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const Ctx = createContext<CategoriesCtx | null>(null);

export function CategoriesProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listCategories();
      setCategories(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载分类失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Ctx.Provider value={{ categories, loading, error, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCategories(): CategoriesCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCategories must be used within CategoriesProvider");
  return v;
}
