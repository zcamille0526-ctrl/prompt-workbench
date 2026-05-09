import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser-side Supabase client used ONLY for:
 *  - parsing the invite access_token / refresh_token from /auth/callback
 *    fragments via setSession()
 *  - clearing the local invite session after setup-account completes
 *
 * After login the client never talks to Supabase directly; business calls go
 * through /api/* with a Bearer access_token.
 *
 * Configuration is per spec §4.3 / §4.4:
 *
 *  - storage: window.sessionStorage — keeps tokens out of localStorage so
 *    closing the tab fully clears auth state. The default would be
 *    localStorage, which silently breaks the "tab close = logout" semantic.
 *  - persistSession: true — within one tab, refresh on reload.
 *  - autoRefreshToken: true — supabase-js handles its own refresh timer
 *    while the tab is open. Business 401s still trigger /api/auth/refresh
 *    in our HTTP layer.
 *  - detectSessionInUrl: false — AuthCallback does the URL-fragment parsing
 *    itself and replaceState's the URL clean immediately (§4.4.1). If we
 *    let supabase-js auto-detect, we lose control over when the token is
 *    scrubbed from history.
 *  - flowType: 'implicit' — locks the email-link flow to fragment tokens.
 *    PKCE links (?code=...) are explicitly rejected by AuthCallback with a
 *    user-facing error, see §4.4.
 */

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON_KEY) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — check .env"
  );
}

let cached: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(URL, ANON_KEY, {
    auth: {
      storage: window.sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "implicit",
    },
  });
  return cached;
}
