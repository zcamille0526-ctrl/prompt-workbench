import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { getServiceRoleClient } from "../lib/supabase.js";
import { extractBearerToken } from "../lib/auth.js";
import { isAdminEmail } from "../lib/admin-emails.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/setup-account";

const SetupSchema = z
  .object({
    password: z.string().min(8).max(72),
  })
  .strict();

type UserSummary = {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = extractBearerToken(req);
  if (!token) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 401, errorCode: "NO_TOKEN" });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = SetupSchema.safeParse(req.body);
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

  // 1) Resolve user from invite access token.
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 401, errorCode: "INVALID_TOKEN" });
    return res.status(401).json({ error: "Unauthorized" });
  }
  const user = userData.user;
  const email = user.email!;

  // 2) Enforce team_pass_verified flag — defense in depth against bypass paths
  //    that produced a user without going through /api/auth/signup.
  if (user.app_metadata?.team_pass_verified !== true) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 403, errorCode: "BYPASS_ATTEMPT" });
    return res.status(403).json({ error: "BYPASS_ATTEMPT" });
  }

  const passwordAlreadySet = user.user_metadata?.password_set === true;

  // 3) Check existing profile state — drives the early-return and the
  //    self-heal branches per spec §4.1 / §5.1.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("id, display_name, is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "PROFILE_LOOKUP_FAILED" });
    return res.status(500).json({ error: "SETUP_FAILED" });
  }

  // §5.1 / round-5 EARLY RETURN: account already fully set up. Critical: must
  // happen before any write and before admin.signOut to prevent an
  // account-level DoS where any holder of a valid token (including a
  // long-lived password-login session) could repeatedly hit this endpoint
  // and revoke all the user's refresh tokens.
  if (passwordAlreadySet && profile) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 409, errorCode: "ALREADY_SETUP" });
    return res.status(409).json({ error: "ALREADY_SETUP" });
  }

  // §5.1 boundary: the only self-heal path is
  //   team_pass_verified=true AND password_set=true AND profile missing.
  // If team_pass_verified were ever false we would have rejected at step 2.
  // So here passwordAlreadySet=true means "self-heal: only UPSERT profile".

  const display_name = (user.user_metadata?.display_name as string | undefined) ?? "";
  if (!display_name) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "MISSING_DISPLAY_NAME" });
    return res.status(500).json({ error: "SETUP_FAILED" });
  }

  // 4) Step A: UPSERT profile (always — covers both first-setup and self-heal).
  //    is_admin is derived from ADMIN_EMAILS at creation time only.
  const isAdmin = isAdminEmail(email);
  const { error: upsertErr } = await supabase.from("profiles").upsert(
    {
      id: user.id,
      email,
      display_name,
      is_admin: isAdmin,
    },
    { onConflict: "id", ignoreDuplicates: true }
  );
  if (upsertErr) {
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "PROFILE_UPSERT_FAILED" });
    return res.status(500).json({ error: "SETUP_FAILED" });
  }

  // 5) Step B: set password — only on first setup. Self-heal skips this.
  let didSetPassword = false;
  if (!passwordAlreadySet) {
    const existingMetadata = user.user_metadata ?? {};
    const { error: pwErr } = await supabase.auth.admin.updateUserById(user.id, {
      password: parsed.data.password,
      user_metadata: { ...existingMetadata, password_set: true },
    });
    if (pwErr) {
      // Profile was UPSERTed but password failed. The next setup-account
      // call will UPSERT-noop the profile (ON CONFLICT ignore) and retry the
      // password. authenticate() rejects this state because password_set is
      // still false, so no business endpoints are exposed to this half-done
      // account.
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "PASSWORD_SET_FAILED" });
      return res.status(500).json({ error: "SETUP_FAILED" });
    }
    didSetPassword = true;
  }

  // 6) Step C: revoke invite session — ONLY when we actually set the password.
  //    Spec §4.1.2 + round-6: the first arg of admin.signOut is the JWT, NOT
  //    user.id. Passing user.id silently no-ops (Supabase tries to parse it
  //    as a JWT and bails). Self-heal branch skips this entirely to avoid
  //    kicking the user out of legit password-login sessions on other
  //    devices. Failures are logged-only — best-effort revocation, max 1h
  //    residual window per access_token TTL.
  if (didSetPassword) {
    try {
      await supabase.auth.admin.signOut(token, "global");
    } catch (err) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 200, errorCode: "SIGNOUT_FAILED" });
    }
  }

  // Fetch the final profile so the response carries the resolved is_admin.
  const { data: finalProfile } = await supabase
    .from("profiles")
    .select("display_name, is_admin")
    .eq("id", user.id)
    .single();

  const summary: UserSummary = {
    id: user.id,
    email,
    display_name: (finalProfile?.display_name as string) ?? display_name,
    is_admin: (finalProfile?.is_admin as boolean) ?? isAdmin,
  };

  safeLog({
    endpoint: ENDPOINT,
    method: "POST",
    status: 200,
    errorCode: didSetPassword ? "FIRST_SETUP" : "PROFILE_HEAL",
  });
  return res.status(200).json({
    user_summary: summary,
    requires_relogin: didSetPassword,
  });
}
