import type { VercelRequest } from "@vercel/node";
import { getServiceRoleClient } from "./supabase.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
};

/**
 * Validate Bearer token and resolve the caller's profile.
 *
 * Returns null on any failure (no Authorization header, bad token, missing
 * profile, password not yet set). Spec §5.2 defines the security boundary:
 *
 *   1. supabase.auth.getUser(token) succeeds
 *   2. user_metadata.password_set === true
 *   3. profiles row exists
 *
 * (3) implies team_pass_verified === true (profile is only ever written by
 * setup-account, which enforces the flag), so authenticate does not check
 * team_pass_verified directly. (2) closes the reverse half-success window
 * where a profile exists but the password was never set.
 *
 * Returning null for any of these collapses to a uniform 401 in the caller —
 * we deliberately don't differentiate "no token" from "stale token" from
 * "incomplete setup" externally.
 */
export async function authenticate(
  req: VercelRequest
): Promise<AuthenticatedUser | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  if (data.user.user_metadata?.password_set !== true) return null;

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("display_name, is_admin")
    .eq("id", data.user.id)
    .single();
  if (profileErr || !profile) return null;

  return {
    id: data.user.id,
    email: data.user.email!,
    display_name: profile.display_name as string,
    is_admin: profile.is_admin as boolean,
  };
}

/**
 * Extract the raw Bearer token. Used by setup-account, which needs to pass
 * the invite JWT to admin.signOut(jwt, 'global') for refresh-token revocation
 * (spec §4.1.2 — historical bug: passing user.id silently no-ops).
 */
export function extractBearerToken(req: VercelRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}
