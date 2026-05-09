import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { getServiceRoleClient } from "../lib/supabase.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/login";

const LoginSchema = z
  .object({
    email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
    password: z.string().min(1).max(256),
  })
  .strict();

function isEmailNotConfirmed(err: { message?: string; code?: string }): boolean {
  if (err.code === "email_not_confirmed") return true;
  return /email\s*not\s*confirmed/i.test(err.message ?? "");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = LoginSchema.safeParse(req.body);
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
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    if (isEmailNotConfirmed(error)) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 401, errorCode: "EMAIL_NOT_VERIFIED" });
      return res.status(401).json({ error: "EMAIL_NOT_VERIFIED" });
    }
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 401, errorCode: "INVALID_CREDENTIALS" });
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  const { session, user } = data ?? {};
  if (!session || !user) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "NO_SESSION" });
    return res.status(500).json({ error: "LOGIN_FAILED" });
  }

  // Pull display_name + is_admin from profiles. authenticate() already
  // requires the row exists; if missing here it means the user finished
  // signup but not setup-account, which we surface as EMAIL_NOT_VERIFIED to
  // nudge them back to the invite link.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("display_name, is_admin")
    .eq("id", user.id)
    .single();
  if (profileErr || !profile) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 401, errorCode: "PROFILE_MISSING" });
    return res.status(401).json({ error: "EMAIL_NOT_VERIFIED" });
  }

  safeLog({ endpoint: ENDPOINT, method: "POST", status: 200 });
  return res.status(200).json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    user_summary: {
      id: user.id,
      email: user.email,
      display_name: profile.display_name,
      is_admin: profile.is_admin,
    },
  });
}
