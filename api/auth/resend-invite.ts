import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { z } from "zod";
import { getServiceRoleClient } from "../lib/supabase.js";
import { getCallbackUrl } from "../lib/site-url.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/resend-invite";

// best-effort IP throttle: 10 requests / hour. Process-local only — see
// spec §4.7 + round-5: the email-level atomic cooldown (Postgres RPC) is
// the actual security boundary; this is just UX guard against a stuck
// front-end button.
const IP_LIMIT = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;
const ipBuckets = new Map<string, number[]>();

function ipKey(req: VercelRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd[0]) return fwd[0]!.split(",")[0]!.trim();
  return "unknown";
}

function checkIpThrottle(req: VercelRequest): boolean {
  const key = ipKey(req);
  const now = Date.now();
  const arr = ipBuckets.get(key) ?? [];
  const fresh = arr.filter((t) => now - t < IP_WINDOW_MS);
  if (fresh.length >= IP_LIMIT) {
    ipBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  ipBuckets.set(key, fresh);
  return true;
}

// Test-only: clear the in-process IP map between tests.
export function __resetIpThrottleForTests(): void {
  ipBuckets.clear();
}

const ResendSchema = z
  .object({
    email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
    team_password: z.string().min(1).max(256),
  })
  .strict();

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const OPAQUE_OK = { message: "如果该邮箱可重发，我们已发送邀请" };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = ResendSchema.safeParse(req.body);
  if (!parsed.success) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
    return res.status(400).json({ error: "Invalid payload" });
  }

  const expected = process.env.SHARED_PASSWORD;
  if (!expected) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "NO_SHARED_PASSWORD" });
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (!timingSafeEqualString(parsed.data.team_password, expected)) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "WRONG_TEAM_PASSWORD" });
    return res.status(400).json({ error: "WRONG_TEAM_PASSWORD" });
  }

  // Best-effort IP throttle FIRST (cheap, no DB call needed).
  if (!checkIpThrottle(req)) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 429, errorCode: "IP_THROTTLED" });
    return res.status(429).json({ error: "THROTTLED" });
  }

  const supabase = getServiceRoleClient();
  const { email } = parsed.data;

  // Atomic email-level cooldown (the real security boundary). Spec §4.7
  // round-4: a single SQL INSERT ... ON CONFLICT ... WHERE last_sent_at < ...
  // returning rows ensures concurrent calls cannot both pass.
  const { data: throttleOk, error: throttleErr } = await supabase.rpc(
    "try_consume_invite_throttle",
    { p_email: email }
  );
  if (throttleErr) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "RPC_FAILED" });
    return res.status(500).json({ error: "RESEND_FAILED" });
  }
  if (!throttleOk) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 429, errorCode: "EMAIL_THROTTLED" });
    return res.status(429).json({ error: "THROTTLED" });
  }

  // Look up the user (page 1 only — small team scope, see signup.ts).
  const { data: list, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "LIST_USERS_FAILED" });
    return res.status(500).json({ error: "RESEND_FAILED" });
  }

  const user = list?.users?.find((u) => u.email?.toLowerCase() === email);

  // Spec §4.7: opaque response for absent user / already-setup user. Internal
  // logging records which branch was hit so ops can spot probe attempts.
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "EMAIL_NOT_FOUND" });
    return res.status(200).json(OPAQUE_OK);
  }
  if (user.user_metadata?.password_set === true) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "ALREADY_SETUP_OPAQUE" });
    return res.status(200).json(OPAQUE_OK);
  }

  // Pull display_name from the EXISTING user_metadata — never accept it from
  // the client. Re-invite preserves whatever was set at signup.
  const displayName = (user.user_metadata?.display_name as string | undefined) ?? "";
  if (!displayName) {
    // Truly broken account; opaque to outside, log internally.
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "MISSING_DISPLAY_NAME" });
    return res.status(200).json(OPAQUE_OK);
  }

  const callback = getCallbackUrl();
  const inviteResp = await supabase.auth.admin.inviteUserByEmail(email, {
    data: { display_name: displayName },
    redirectTo: callback,
  });
  if (inviteResp.error) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "INVITE_FAILED" });
    return res.status(500).json({ error: "RESEND_FAILED" });
  }

  // Tag-along orphan repair: re-write team_pass_verified=true so a partially
  // failed signup gets healed via this same path (spec §4.1.1 row 3).
  const { error: flagErr } = await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: { ...(user.app_metadata ?? {}), team_pass_verified: true },
  });
  if (flagErr) {
    // Logged-only — the invite already went out. Next setup-account path
    // will see whatever flag state Supabase ended in; if the flag stayed
    // false, setup-account returns BYPASS_ATTEMPT and the user must resend
    // again, at which point we retry this update.
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "FLAG_REWRITE_FAILED" });
  } else {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "RESENT" });
  }

  return res.status(200).json(OPAQUE_OK);
}
