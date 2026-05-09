import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { getServiceRoleClient } from "../lib/supabase.js";
import { extractBearerToken } from "../lib/auth.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/logout";

// Optional refresh_token in body — when present, we use it to fully invalidate
// the session via service-role admin.signOut. Tolerant of failures: the
// frontend is going to clear sessionStorage regardless.
const LogoutSchema = z
  .object({
    refresh_token: z.string().min(1).max(2048).optional(),
  })
  .strict();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = LogoutSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
    return res.status(400).json({ error: "Invalid payload" });
  }

  // Prefer the access token from Authorization header — admin.signOut(jwt)
  // is the canonical revocation API and works without the refresh token.
  const accessToken = extractBearerToken(req);
  const supabase = getServiceRoleClient();

  if (accessToken) {
    try {
      // scope='local' invalidates only this session's refresh token. spec
      // §13 "multi-device login: logging out one place does not affect
      // others" — a previous draft used 'global' which contradicted that.
      // setup-account is the only path that needs 'global' (revoking the
      // invite session everywhere).
      await supabase.auth.admin.signOut(accessToken, "local");
    } catch {
      // logged-only — frontend will still clear local session
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "SIGNOUT_FAILED" });
    }
  }

  safeLog({ endpoint: ENDPOINT, method: "POST", status: 200 });
  return res.status(200).json({ success: true });
}
