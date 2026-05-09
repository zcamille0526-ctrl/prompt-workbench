import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Singleton across one Vercel function invocation
 * to avoid recreating per-request. Auth helpers and the new auth/* endpoints
 * use this; legacy endpoints (prompts, examples, etc.) keep their own clients
 * until Step 2 of Phase 2 migrates them off the shared-password path.
 */
export function getServiceRoleClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  cached = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cached;
}

// Test-only: drop the cached client so tests can swap mocks per case.
export function __resetServiceRoleClientForTests(): void {
  cached = null;
}
