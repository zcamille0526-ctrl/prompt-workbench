import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { Prompt, PromptInput } from "../lib/schemas";

export function usePrompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    try {
      const data = await api.request<Prompt[]>("/api/prompts");
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

  const createPrompt = useCallback(async (input: PromptInput) => {
    const data = await api.request<Prompt>("/api/prompts", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setPrompts((prev) => [data, ...prev]);
    return data;
  }, []);

  const updatePrompt = useCallback(async (id: string, input: PromptInput) => {
    const data = await api.request<Prompt>(`/api/prompts?id=${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    setPrompts((prev) => prev.map((p) => (p.id === id ? data : p)));
    return data;
  }, []);

  const deletePrompt = useCallback(async (id: string) => {
    await api.request(`/api/prompts?id=${id}`, { method: "DELETE" });
    setPrompts((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { prompts, isLoading, error, fetchPrompts, createPrompt, updatePrompt, deletePrompt };
}
