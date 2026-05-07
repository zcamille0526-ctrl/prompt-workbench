import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import { getUserName } from "../lib/userName";
import type {
  Prompt,
  PromptCreateInput,
  PromptUpdateInput,
} from "../lib/schemas";

export function usePrompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    try {
      const viewer = getUserName();
      const query = viewer
        ? `/api/prompts?viewer=${encodeURIComponent(viewer)}`
        : "/api/prompts";
      const data = await api.request<Prompt[]>(query);
      setPrompts(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrompts();
  }, [fetchPrompts]);

  const createPrompt = useCallback(async (input: PromptCreateInput) => {
    const data = await api.request<Prompt>("/api/prompts", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setPrompts((prev) => [data, ...prev]);
    return data;
  }, []);

  const updatePrompt = useCallback(
    async (id: string, input: PromptUpdateInput) => {
      const viewer = getUserName();
      const qs = viewer ? `?id=${id}&viewer=${encodeURIComponent(viewer)}` : `?id=${id}`;
      const data = await api.request<Prompt>(`/api/prompts${qs}`, {
        method: "PUT",
        body: JSON.stringify(input),
      });
      setPrompts((prev) => prev.map((p) => (p.id === id ? data : p)));
      return data;
    },
    []
  );

  const deletePrompt = useCallback(async (id: string) => {
    const viewer = getUserName();
    const qs = viewer ? `?id=${id}&viewer=${encodeURIComponent(viewer)}` : `?id=${id}`;
    await api.request(`/api/prompts${qs}`, { method: "DELETE" });
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return {
    prompts,
    isLoading,
    error,
    fetchPrompts,
    createPrompt,
    updatePrompt,
    deletePrompt,
  };
}
