import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { z } from "zod";
import { getServiceRoleClient } from "../lib/supabase.js";
import { getCallbackUrl } from "../lib/site-url.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/signup";

const SignupSchema = z
  .object({
    email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
    display_name: z.string().min(1).max(64).trim(),
    team_password: z.string().min(1).max(256),
  })
  .strict();

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

type ExistingUserStatus =
  | { kind: "absent" }
  | { kind: "completed" } // password_set === true → EMAIL_TAKEN
  | { kind: "pending" }; // password_set !== true → EMAIL_PENDING (orphan or normal)

async function lookupExistingStatus(email: string): Promise<ExistingUserStatus> {
  const supabase = getServiceRoleClient();
  // supabase-js v2 doesn't expose an email filter on admin.listUsers — we
  // pull a page and scan client-side. For a 10-person team a single page is
  // sufficient; if the team grows, the second page exists in `data.nextPage`.
  // We deliberately keep this simple rather than paginating: a 50+ team is
  // out of v1 scope.
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) throw error;
  const user = data?.users?.find((u) => u.email?.toLowerCase() === email);
  if (!user) return { kind: "absent" };
  const passwordSet = user.user_metadata?.password_set === true;
  return passwordSet ? { kind: "completed" } : { kind: "pending" };
}

/**
 * Map a duplicate-user error from inviteUserByEmail to the right §4.1.1 state.
 *
 * supabase-js v2 raises an AuthApiError with code 'email_exists' (status 422)
 * when the email already exists. The implementer must verify the exact error
 * shape against the locked supabase-js version (currently ^2.105.1) before
 * relying on this string match.
 */
function isDuplicateUserError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; status?: number; message?: string };
  if (e.code === "email_exists") return true;
  if (e.status === 422 && /already (?:registered|exists)/i.test(e.message ?? "")) {
    return true;
  }
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = SignupSchema.safeParse(req.body);
  if (!parsed.success) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
    return res.status(400).json({
      error: "Invalid payload",
      details: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      ),
    });
  }

  const expected = process.env.SHARED_PASSWORD;
  if (!expected) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "NO_SHARED_PASSWORD" });
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const { email, display_name, team_password } = parsed.data;

  if (!timingSafeEqualString(team_password, expected)) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "WRONG_TEAM_PASSWORD" });
    return res.status(400).json({ error: "WRONG_TEAM_PASSWORD" });
  }

  const supabase = getServiceRoleClient();

  // §4.1.1 state machine: pre-check before invite.
  let status: ExistingUserStatus;
  try {
    status = await lookupExistingStatus(email);
  } catch (err) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "LIST_USERS_FAILED" });
    return res.status(500).json({ error: "SIGNUP_LOOKUP_FAILED" });
  }

  if (status.kind === "completed") {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "EMAIL_TAKEN" });
    return res.status(400).json({ error: "EMAIL_TAKEN" });
  }
  if (status.kind === "pending") {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "EMAIL_PENDING" });
    return res.status(400).json({ error: "EMAIL_PENDING" });
  }

  // status.kind === "absent" — invite path.
  const callback = getCallbackUrl();
  const inviteResp = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { display_name },
    redirectTo: callback,
  });

  if (inviteResp.error) {
    // §5.1 TOCTOU fallback: if duplicate-user, re-resolve via listUsers and
    // map back into the state machine instead of returning 500.
    if (isDuplicateUserError(inviteResp.error)) {
      let recovered: ExistingUserStatus;
      try {
        recovered = await lookupExistingStatus(email);
      } catch {
        safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "SIGNUP_RACE" });
        return res.status(500).json({ error: "SIGNUP_RACE" });
      }
      if (recovered.kind === "completed") {
        safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "EMAIL_TAKEN_RACE" });
        return res.status(400).json({ error: "EMAIL_TAKEN" });
      }
      if (recovered.kind === "pending") {
        safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "EMAIL_PENDING_RACE" });
        return res.status(400).json({ error: "EMAIL_PENDING" });
      }
      // recovered=absent contradicts the duplicate error: return SIGNUP_RACE
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "SIGNUP_RACE_CONTRADICTION" });
      return res.status(500).json({ error: "SIGNUP_RACE" });
    }
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "INVITE_FAILED" });
    return res.status(500).json({ error: "INVITE_FAILED" });
  }

  const newUser = inviteResp.data?.user;
  if (!newUser) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "INVITE_NO_USER" });
    return res.status(500).json({ error: "INVITE_FAILED" });
  }

  // Mark team_pass_verified — must succeed or we delete the orphan auth row.
  // (Spec §4.1 atomic compensation: an orphan account that lacks the flag
  // would fail every subsequent setup-account / resend-invite recovery path.)
  const { error: updErr } = await supabase.auth.admin.updateUserById(newUser.id, {
    app_metadata: { team_pass_verified: true },
  });

  if (updErr) {
    // Compensate: best-effort delete of the half-created user.
    await supabase.auth.admin.deleteUser(newUser.id).catch(() => undefined);
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "FLAG_WRITE_FAILED" });
    return res.status(500).json({ error: "INVITE_FAILED" });
  }

  safeLog({ endpoint: ENDPOINT, method: "POST", status: 200 });
  return res.status(200).json({
    message: "请到邮箱点击邀请链接以完成注册",
  });
}
