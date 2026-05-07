import { useState, useCallback, useEffect } from "react";
import { api } from "../lib/api";
import { getUserName } from "../lib/userName";
import type { Example, ExampleCreateInput } from "../lib/schemas";

/**
 * Loads the examples attached to a single prompt and exposes create/delete.
 *
 * Re-fetches whenever promptId changes (parent should remount via key prop
 * when switching prompts; this also covers an in-place change).
 */
export function useExamples(promptId: string | null) {
  const [examples, setExamples] = useState<Example[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchExamples = useCallback(async () => {
    if (!promptId) return;
    setIsLoading(true);
    try {
      const data = (await api.listExamples(promptId, getUserName())) as Example[];
      setExamples(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch examples");
    } finally {
      setIsLoading(false);
    }
  }, [promptId]);

  useEffect(() => {
    void fetchExamples();
  }, [fetchExamples]);

  const createExample = useCallback(async (input: ExampleCreateInput) => {
    const created = (await api.createExample(input)) as Example;
    setExamples((prev) => [created, ...prev]);
    return created;
  }, []);

  const deleteExample = useCallback(async (id: string) => {
    await api.deleteExample(id, getUserName());
    setExamples((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return { examples, isLoading, error, fetchExamples, createExample, deleteExample };
}
