import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { getServiceRoleClient } from "../lib/supabase.js";
import { authenticate, extractBearerToken } from "../lib/auth.js";
import { safeLog } from "../lib/log.js";

/**
 * Merged session handler — Vercel Hobby plan caps deployments at 12 serverless
 * functions, so three small auth endpoints (me / logout / refresh) share one
 * file. `vercel.json` rewrites forward the original URLs:
 *
 *   GET  /api/auth/me      → /api/auth/session?action=me
 *   POST /api/auth/logout  → /api/auth/session?action=logout
 *   POST /api/auth/refresh → /api/auth/session?action=refresh
 *
 * Frontend code calls the original URLs unchanged.
 */

const RefreshSchema = z
  .object({
    refresh_token: z.string().min(1).max(2048),
  })
  .strict();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = req.query.action as string | undefined;

  if (action === "me") return handleMe(req, res);
  if (action === "logout") return handleLogout(req, res);
  if (action === "refresh") return handleRefresh(req, res);

  safeLog({ endpoint: "/api/auth/session", method: req.method, status: 400, errorCode: "UNKNOWN_ACTION" });
  return res.status(400).json({ error: "Unknown action" });
}

// --- /api/auth/me ---
async function handleMe(req: VercelRequest, res: VercelResponse) {
  const ENDPOINT = "/api/auth/me";
  if (req.method !== "GET") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: "GET", status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  safeLog({ endpoint: ENDPOINT, method: "GET", status: 200 });
  return res.status(200).json(user);
}

// --- /api/auth/logout ---
//
// Logout: revoke this session's refresh token via service-role
// admin.signOut(jwt, 'local').
//
// The endpoint takes NO request body. Revocation is driven purely by the
// Authorization: Bearer <access_token> header — Supabase's admin.signOut
// accepts a JWT (not a refresh_token) as its first argument.
//
// scope='local' invalidates only this session's refresh token. Spec §13
// "multi-device login: logging out one place does not affect others".
async function handleLogout(req: VercelRequest, res: VercelResponse) {
  const ENDPOINT = "/api/auth/logout";
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const accessToken = extractBearerToken(req);
  const supabase = getServiceRoleClient();

  if (accessToken) {
    try {
      await supabase.auth.admin.signOut(accessToken, "local");
    } catch {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "SIGNOUT_FAILED" });
    }
  }

  safeLog({ endpoint: ENDPOINT, method: "POST", status: 200 });
  return res.status(200).json({ success: true });
}

// --- /api/auth/refresh ---
async function handleRefresh(req: VercelRequest, res: VercelResponse) {
  const ENDPOINT = "/api/auth/refresh";
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
    return res.status(400).json({
      error: "Invalid payload",
      details: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      ),
    });
  }

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: parsed.data.refresh_token,
  });

  if (error || !data?.session) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 401, errorCode: "REFRESH_FAILED" });
    return res.status(401).json({ error: "REFRESH_FAILED" });
  }

  safeLog({ endpoint: ENDPOINT, method: "POST", status: 200 });
  return res.status(200).json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in: data.session.expires_in,
  });
}
