import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getServiceRoleClient } from "../lib/supabase.js";
import { extractBearerToken } from "../lib/auth.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/logout";

/**
 * Logout: revoke this session's refresh token via service-role
 * admin.signOut(jwt, 'local').
 *
 * The endpoint takes NO request body. Revocation is driven purely by the
 * Authorization: Bearer <access_token> header — Supabase's admin.signOut
 * accepts a JWT (not a refresh_token) as its first argument, so passing
 * the access token is sufficient.
 *
 * If the Authorization header is missing or signOut fails, the request still
 * returns 200; the frontend always clears its local sessionStorage on logout
 * regardless. The server-side revocation is best-effort hardening — without
 * a Bearer token, no server-side revocation happens, and the (now-orphaned)
 * refresh token will continue to work until it expires naturally.
 *
 * Anti-spoof note: a misbehaving client cannot trick this endpoint into
 * revoking another session's refresh token by supplying a value in the body,
 * because no body is read.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const accessToken = extractBearerToken(req);
  const supabase = getServiceRoleClient();

  if (accessToken) {
    try {
      // scope='local' invalidates only this session's refresh token. Spec
      // §13 "multi-device login: logging out one place does not affect
      // others" — a previous draft used 'global' which contradicted that.
      // setup-account is the only path that needs 'global' (revoking the
      // invite session everywhere).
      await supabase.auth.admin.signOut(accessToken, "local");
    } catch {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "SIGNOUT_FAILED" });
    }
  }

  safeLog({ endpoint: ENDPOINT, method: "POST", status: 200 });
  return res.status(200).json({ success: true });
}
