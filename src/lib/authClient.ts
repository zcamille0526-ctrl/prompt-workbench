import { API_BASE_URL } from "./constants";
import { getSupabaseClient } from "./supabaseClient";

/**
 * High-level wrappers around the /api/auth/* endpoints + Supabase session.
 *
 * Responsibilities split:
 *  - supabaseClient.ts holds the @supabase/supabase-js singleton (used only
 *    for invite-callback session bootstrap and signOut).
 *  - This module is the single source of truth the rest of the app uses for
 *    "give me a valid access token" and "sign out cleanly". It hides the
 *    fact that two separate refresh paths exist (supabase-js auto-refresh
 *    while the tab is open, plus our own 401 → /api/auth/refresh fallback
 *    once we wire it into api.ts in Step 2).
 *
 * Intentional non-goals for Step 1:
 *  - This module does NOT yet plumb the access token into the existing
 *    api.ts client. That swap happens in Step 2 alongside the viewer-param
 *    removal in prompts/examples/chat. Until then api.ts keeps using its
 *    own legacy verify-based token; the two coexist on disjoint endpoints.
 */

export type UserSummary = {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
};

export type LoginResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_summary: UserSummary;
};

export type AuthErrorCode =
  | "WRONG_TEAM_PASSWORD"
  | "EMAIL_TAKEN"
  | "EMAIL_PENDING"
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_CREDENTIALS"
  | "REFRESH_FAILED"
  | "ALREADY_SETUP"
  | "BYPASS_ATTEMPT"
  | "THROTTLED"
  | "SETUP_FAILED"
  | "INVITE_FAILED"
  | "RESEND_FAILED"
  | "SIGNUP_LOOKUP_FAILED"
  | "SIGNUP_RACE"
  | "OTHER";

export class AuthError extends Error {
  code: AuthErrorCode;
  status: number;

  constructor(code: AuthErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "AuthError";
  }
}

async function postJson<T>(
  path: string,
  body: unknown,
  init: { authorization?: string } = {}
): Promise<T> {
  return sendJson<T>(path, "POST", body, init);
}

async function sendJson<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
  init: { authorization?: string } = {}
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(init.authorization
        ? { authorization: `Bearer ${init.authorization}` }
        : {}),
    },
    body: JSON.stringify(body),
  });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = {};
  }
  if (!res.ok) {
    const code = (payload?.error as AuthErrorCode) ?? "OTHER";
    throw new AuthError(code, payload?.error ?? "请求失败", res.status);
  }
  return payload as T;
}

// ---------- Token storage ----------
//
// Spec §4.3: tokens live in window.sessionStorage so closing the tab clears
// them. supabase-js owns its own sb-* keys (configured in supabaseClient.ts);
// our /api/auth/login response also lands here under our own keys so the
// two paths stay independent — the "I just logged in via /api/auth/login"
// session and the "I just clicked an invite link" supabase-js session don't
// overwrite each other.

const ACCESS_KEY = "pw.access_token";
const REFRESH_KEY = "pw.refresh_token";

function storeTokens(t: { access_token: string; refresh_token: string }) {
  window.sessionStorage.setItem(ACCESS_KEY, t.access_token);
  window.sessionStorage.setItem(REFRESH_KEY, t.refresh_token);
}

function readAccess(): string | null {
  return window.sessionStorage.getItem(ACCESS_KEY);
}

function readRefresh(): string | null {
  return window.sessionStorage.getItem(REFRESH_KEY);
}

function clearTokens() {
  window.sessionStorage.removeItem(ACCESS_KEY);
  window.sessionStorage.removeItem(REFRESH_KEY);
}

/**
 * Return the current access token without any network round-trip.
 *
 * Step 2 will introduce a stricter `getValidAccessToken()` variant that
 * pre-checks expiry and proactively refreshes; for Step 1 this raw getter
 * is what AuthScreen/AuthCallback need to read whatever the user just
 * obtained.
 */
export function getAccessToken(): string | null {
  return readAccess();
}

/**
 * Read the access token from the supabase-js client instead of sessionStorage.
 *
 * Used right after the invite callback — supabase.auth.setSession() drops
 * its own copy in storage under the sb-* prefix, and /api/auth/setup-account
 * needs that exact JWT in its Authorization header (so admin.signOut(jwt)
 * can revoke it).
 */
export async function getInviteAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

// ---------- /api/auth/* wrappers ----------

export async function signup(input: {
  email: string;
  display_name: string;
  team_password: string;
}): Promise<{ message: string }> {
  return postJson("/api/auth/signup", input);
}

export async function setupAccount(
  password: string,
  inviteAccessToken: string
): Promise<{ user_summary: UserSummary; requires_relogin: boolean }> {
  const data = await postJson<{
    user_summary: UserSummary;
    requires_relogin: boolean;
  }>(
    "/api/auth/setup-account",
    { password },
    { authorization: inviteAccessToken }
  );

  // Self-heal branch: server kept our session valid (didn't run signOut),
  // and the caller will route us straight into the main app without a
  // re-login. We need to seed pw.access_token / pw.refresh_token from
  // supabase-js so the rest of the app — which reads from pw.* — has a
  // working token. The first-setup branch deliberately skips this: the
  // caller will signOut, navigate to the login screen, and login() will
  // populate pw.* with a fresh password-login session.
  if (!data.requires_relogin) {
    const session = (await getSupabaseClient().auth.getSession()).data.session;
    if (session?.access_token && session?.refresh_token) {
      storeTokens({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });
    }
  }

  return data;
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<LoginResponse> {
  const data = await postJson<LoginResponse>("/api/auth/login", input);
  storeTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
  });
  return data;
}

export async function refresh(): Promise<{ access_token: string; refresh_token: string }> {
  const rt = readRefresh();
  if (!rt) throw new AuthError("REFRESH_FAILED", "No refresh token", 401);
  const data = await postJson<{ access_token: string; refresh_token: string }>(
    "/api/auth/refresh",
    { refresh_token: rt }
  );
  storeTokens(data);
  return data;
}

export async function resendInvite(input: {
  email: string;
  team_password: string;
}): Promise<{ message: string }> {
  return postJson("/api/auth/resend-invite", input);
}

/**
 * Logout cleans up everything in the right order:
 *
 *  1. POST /api/auth/logout with our access token. The server calls
 *     admin.signOut(jwt, 'local'), which revokes ONLY this session's
 *     refresh token — other devices stay logged in (spec §13).
 *  2. Clear our pw.* sessionStorage keys.
 *  3. supabase.auth.signOut() to clear any sb-* keys left over from the
 *     invite callback flow.
 *
 * Step (1) is best-effort: a failed network call must not block the user
 * from getting back to a clean state. Steps (2) and (3) always run.
 */
export async function logout(): Promise<void> {
  const at = readAccess();
  if (at) {
    try {
      await postJson("/api/auth/logout", {}, { authorization: at });
    } catch {
      // best-effort
    }
  }
  clearTokens();
  try {
    await getSupabaseClient().auth.signOut();
  } catch {
    // best-effort
  }
}

export async function fetchMe(): Promise<UserSummary> {
  const at = readAccess();
  if (!at) throw new AuthError("INVALID_CREDENTIALS", "Not authenticated", 401);
  const res = await fetch(`${API_BASE_URL}/api/auth/me`, {
    headers: { authorization: `Bearer ${at}` },
  });
  if (!res.ok) {
    let payload: any = null;
    try {
      payload = await res.json();
    } catch {
      /* noop */
    }
    throw new AuthError(
      (payload?.error as AuthErrorCode) ?? "OTHER",
      payload?.error ?? "请求失败",
      res.status
    );
  }
  return res.json();
}

/**
 * Rename the current user. Server enforces Zod .strict() on the body and
 * only writes display_name (api/profile/update.ts); the response is the
 * fresh user summary so callers can hand it straight to
 * currentUser.setUser().
 */
export async function updateProfile(input: {
  display_name: string;
}): Promise<UserSummary> {
  const at = readAccess();
  if (!at) throw new AuthError("INVALID_CREDENTIALS", "Not authenticated", 401);
  return sendJson<UserSummary>("/api/profile/update", "PATCH", input, {
    authorization: at,
  });
}
