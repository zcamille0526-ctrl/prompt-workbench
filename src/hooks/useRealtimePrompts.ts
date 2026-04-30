import { useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";

export function useRealtimePrompts(onUpdate: () => void) {
  const callbackRef = useRef(onUpdate);
  callbackRef.current = onUpdate;

  useEffect(() => {
    if (!supabase) return;

    const channel = supabase
      .channel("prompts-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prompts" },
        () => {
          callbackRef.current();
        }
      )
      .subscribe();

    return () => {
      supabase!.removeChannel(channel);
    };
  }, []);
}
