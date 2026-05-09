import { useEffect, useState } from "react";
import { getSupabaseClient } from "../lib/supabaseClient";
import {
  setupAccount,
  getInviteAccessToken,
  AuthError,
  type UserSummary,
} from "../lib/authClient";

type Phase =
  | { kind: "loading" }
  | { kind: "set-password"; userEmail: string }
  | { kind: "submitting" }
  | { kind: "success-relogin"; userEmail: string }
  | { kind: "success-direct"; user: UserSummary }
  | { kind: "error"; message: string };

interface Props {
  /** Called when self-heal path lands the user directly in the app. */
  onAuthenticated: (user: UserSummary) => void;
  /** Called after successful first-setup → user must log in with the new password. */
  onRequireLogin: (email: string) => void;
}

/**
 * Handles the /auth/callback route. Per spec §4.4 / §4.4.1 / §4.1.2:
 *
 *  1. Parse fragment tokens BEFORE anything else.
 *  2. replaceState to clear them from the URL bar IMMEDIATELY — even if
 *     setSession later fails. Tokens are otherwise visible in browser
 *     history, screenshots, dev-tools, or shared screens.
 *  3. PKCE-style ?code=... links are explicitly rejected with a friendly
 *     error so a Supabase config drift to PKCE doesn't crash silently.
 *  4. After setSession, render the password form. setup-account POST goes
 *     out with the invite access_token in the Authorization header — the
 *     server uses that exact JWT for admin.signOut(jwt, 'global') in the
 *     first-setup branch.
 *  5. requires_relogin=true → call supabase.signOut() locally to clear the
 *     invite session and route to login. requires_relogin=false (self-heal)
 *     → continue to the main app with the existing session (authClient has
 *     already seeded pw.* from the supabase session).
 */
export function AuthCallback({ onAuthenticated, onRequireLogin }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const hash = window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.hash;
      const search = window.location.search;

      const params = new URLSearchParams(hash);
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");

      // Spec §4.4.1: scrub the URL FIRST, regardless of what happens next.
      // The pathname (/auth/callback) is preserved so reloading still hits
      // this component instead of crashing the SPA fallback.
      try {
        window.history.replaceState({}, "", window.location.pathname);
      } catch {
        /* noop */
      }

      // PKCE-style links — Supabase default is implicit, but a config
      // change could send us here with ?code=... instead.
      if (!accessToken && search.includes("code=")) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message:
              "邀请链接格式不识别（PKCE flow），请联系管理员重发邀请邮件。",
          });
        }
        return;
      }

      if (!accessToken || !refreshToken) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: "邀请链接无效或已被使用，请重新登录或重发邀请。",
          });
        }
        return;
      }

      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (error || !data?.user) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: "邀请链接已过期或无效，请联系管理员重发。",
          });
        }
        return;
      }

      // user_metadata.password_set drives whether we render the set-password
      // form or treat this as a returning-user invite.
      const passwordSet = data.user.user_metadata?.password_set === true;
      if (!passwordSet) {
        if (!cancelled) {
          setPhase({ kind: "set-password", userEmail: data.user.email ?? "" });
        }
        return;
      }

      // Returning click on a still-valid invite link, password already set:
      // server's setup-account would 409 ALREADY_SETUP. Send the user back
      // to the login screen rather than landing them in some half state.
      if (!cancelled) {
        setPhase({
          kind: "success-relogin",
          userEmail: data.user.email ?? "",
        });
      }
      try {
        await supabase.auth.signOut();
      } catch {
        /* noop */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (password.length < 8) {
      setSubmitError("密码至少 8 位。");
      return;
    }
    if (password !== confirm) {
      setSubmitError("两次输入的密码不一致。");
      return;
    }

    const inviteToken = await getInviteAccessToken();
    if (!inviteToken) {
      setSubmitError("邀请会话已失效，请重新点击邀请链接。");
      return;
    }

    if (phase.kind !== "set-password") return;
    const userEmail = phase.userEmail;

    setPhase({ kind: "submitting" });
    try {
      const result = await setupAccount(password, inviteToken);
      if (result.requires_relogin) {
        // First-setup path: server revoked refresh tokens via admin.signOut.
        // Clear the local supabase session so business calls don't keep
        // using the dead invite access_token (TTL up to 1h) by accident.
        try {
          await getSupabaseClient().auth.signOut();
        } catch {
          /* noop */
        }
        setPhase({ kind: "success-relogin", userEmail });
      } else {
        // Self-heal path: server kept the session alive on purpose.
        // authClient.setupAccount already seeded pw.* from supabase.
        setPhase({ kind: "success-direct", user: result.user_summary });
      }
    } catch (err) {
      const ae = err as AuthError;
      if (ae.code === "ALREADY_SETUP") {
        setPhase({ kind: "success-relogin", userEmail });
      } else if (ae.code === "BYPASS_ATTEMPT") {
        setSubmitError(
          "邀请验证失败。请联系管理员重发邀请邮件，或在登录页点击「重发邀请」。"
        );
        setPhase({ kind: "set-password", userEmail });
      } else {
        setSubmitError("设置密码失败，请稍后再试。");
        setPhase({ kind: "set-password", userEmail });
      }
    }
  };

  // Effects that fire from terminal phases — kept out of render to satisfy
  // React's rules and to make the side effects explicit.
  useEffect(() => {
    if (phase.kind === "success-relogin") {
      onRequireLogin(phase.userEmail);
    } else if (phase.kind === "success-direct") {
      onAuthenticated(phase.user);
    }
  }, [phase, onAuthenticated, onRequireLogin]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="bg-surface p-8 rounded-xl shadow-elevated w-full max-w-sm">
        <h1 className="text-xl font-medium text-primary mb-6 text-center">
          完成账号设置
        </h1>

        {phase.kind === "loading" && (
          <p className="text-text-primary text-sm text-center">验证邀请中...</p>
        )}

        {phase.kind === "error" && (
          <p className="text-error text-sm">{phase.message}</p>
        )}

        {phase.kind === "success-relogin" && (
          <p className="text-text-primary text-sm">
            账号已设置完成，请用新密码登录。
          </p>
        )}

        {phase.kind === "success-direct" && (
          <p className="text-text-primary text-sm">
            正在进入主界面...
          </p>
        )}

        {(phase.kind === "set-password" || phase.kind === "submitting") && (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-text-primary text-sm">
              邮箱：
              <span className="font-medium">
                {phase.kind === "set-password"
                  ? phase.userEmail
                  : ""}
              </span>
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="新密码（至少 8 位）"
              className="input-field"
              autoComplete="new-password"
              required
              minLength={8}
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              className="input-field"
              autoComplete="new-password"
              required
              minLength={8}
            />
            {submitError && <p className="text-error text-sm">{submitError}</p>}
            <button
              type="submit"
              disabled={phase.kind === "submitting" || !password || !confirm}
              className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {phase.kind === "submitting" ? "提交中..." : "设置密码"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
