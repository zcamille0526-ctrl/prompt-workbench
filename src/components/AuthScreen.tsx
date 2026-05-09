import { useState } from "react";
import {
  signup,
  login,
  resendInvite,
  AuthError,
  type LoginResponse,
} from "../lib/authClient";

type Tab = "login" | "signup";

interface Props {
  onLoggedIn: (data: LoginResponse) => void;
}

/**
 * Login + signup gate. Replaces PasswordGate post-Phase-2.
 *
 * Three flows:
 *  - Login: email + password → /api/auth/login. EMAIL_NOT_VERIFIED surfaces
 *    a "重发邀请邮件" button.
 *  - Signup: email + display_name + team_password → /api/auth/signup.
 *    Success state tells the user to check their inbox and click the
 *    invite link (which lands on /auth/callback).
 *  - Resend invite: email + team_password → /api/auth/resend-invite.
 *    Always shows the same opaque success message regardless of whether
 *    the email exists.
 *
 * Wiring into App.tsx is deferred to Step 2 (business endpoints still
 * expect the legacy verify-token at this point). For Step 1 this component
 * renders standalone and is exercisable from a future /auth-test route or
 * by editing App.tsx temporarily.
 */
export function AuthScreen({ onLoggedIn }: Props) {
  const [tab, setTab] = useState<Tab>("login");

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="bg-surface p-8 rounded-xl shadow-elevated w-full max-w-sm">
        <h1 className="text-xl font-medium text-primary mb-6 text-center">
          提示词工作台
        </h1>

        <div className="flex border-b border-gray-200 mb-6">
          <TabButton active={tab === "login"} onClick={() => setTab("login")}>
            登录
          </TabButton>
          <TabButton active={tab === "signup"} onClick={() => setTab("signup")}>
            注册
          </TabButton>
        </div>

        {tab === "login" ? (
          <LoginForm onLoggedIn={onLoggedIn} />
        ) : (
          <SignupForm />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex-1 py-2 text-sm font-medium transition-colors " +
        (active
          ? "text-primary border-b-2 border-primary -mb-px"
          : "text-text-primary hover:text-primary")
      }
    >
      {children}
    </button>
  );
}

function LoginForm({ onLoggedIn }: { onLoggedIn: (d: LoginResponse) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setUnverifiedEmail(null);
    setPending(true);
    try {
      const data = await login({ email, password });
      onLoggedIn(data);
    } catch (err) {
      const ae = err as AuthError;
      if (ae.code === "EMAIL_NOT_VERIFIED") {
        setError("邮箱尚未验证，请到邮箱点击邀请链接完成注册。");
        setUnverifiedEmail(email);
      } else if (ae.code === "INVALID_CREDENTIALS") {
        setError("邮箱或密码错误。");
      } else {
        setError("登录失败，请稍后再试。");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="邮箱"
        className="input-field"
        autoComplete="email"
        required
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="密码"
        className="input-field"
        autoComplete="current-password"
        required
      />
      {error && <p className="text-error text-sm">{error}</p>}
      <button
        type="submit"
        disabled={pending || !email.trim() || !password}
        className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? "登录中..." : "登录"}
      </button>
      {unverifiedEmail && <ResendInvite email={unverifiedEmail} />}
    </form>
  );
}

function SignupForm() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [teamPassword, setTeamPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPendingEmail(null);
    setPending(true);
    try {
      await signup({
        email,
        display_name: displayName,
        team_password: teamPassword,
      });
      setSuccess(true);
    } catch (err) {
      const ae = err as AuthError;
      if (ae.code === "WRONG_TEAM_PASSWORD") {
        setError("团队密码错误，请向管理员确认。");
      } else if (ae.code === "EMAIL_TAKEN") {
        setError("该邮箱已注册，请直接登录。");
      } else if (ae.code === "EMAIL_PENDING") {
        setError("该邮箱已发出邀请，请去邮箱查收，或点击下方按钮重发。");
        setPendingEmail(email);
      } else {
        setError("注册失败，请稍后再试。");
      }
    } finally {
      setPending(false);
    }
  };

  if (success) {
    return (
      <p className="text-text-primary text-sm leading-relaxed">
        我们已向 <span className="font-medium">{email}</span> 发送邀请邮件。
        请到邮箱点击链接完成注册并设置密码。
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="邮箱"
        className="input-field"
        autoComplete="email"
        required
      />
      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="显示名"
        className="input-field"
        maxLength={64}
        required
      />
      <input
        type="password"
        value={teamPassword}
        onChange={(e) => setTeamPassword(e.target.value)}
        placeholder="团队密码"
        className="input-field"
        autoComplete="off"
        required
      />
      {error && <p className="text-error text-sm">{error}</p>}
      <button
        type="submit"
        disabled={pending || !email.trim() || !displayName.trim() || !teamPassword}
        className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? "提交中..." : "发送邀请邮件"}
      </button>
      {pendingEmail && (
        <ResendInvite email={pendingEmail} teamPasswordHint={teamPassword} />
      )}
    </form>
  );
}

function ResendInvite({
  email,
  teamPasswordHint,
}: {
  email: string;
  teamPasswordHint?: string;
}) {
  // The resend endpoint requires team_password too — for the login flow we
  // don't have it (user only typed account password), so we surface a small
  // input. For the signup flow the user already typed it, so we prefill.
  const [teamPassword, setTeamPassword] = useState(teamPasswordHint ?? "");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await resendInvite({ email, team_password: teamPassword });
      setDone(true);
    } catch (err) {
      const ae = err as AuthError;
      if (ae.code === "WRONG_TEAM_PASSWORD") {
        setError("团队密码错误。");
      } else if (ae.code === "THROTTLED") {
        setError("请求过于频繁，请稍后再试。");
      } else {
        setError("发送失败，请稍后再试。");
      }
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <p className="text-text-primary text-sm">
        如果该邮箱可重发，我们已发送邀请邮件。
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 pt-2 border-t border-gray-200">
      <p className="text-xs text-text-primary">重新发送邀请邮件</p>
      {!teamPasswordHint && (
        <input
          type="password"
          value={teamPassword}
          onChange={(e) => setTeamPassword(e.target.value)}
          placeholder="团队密码"
          className="input-field"
          autoComplete="off"
          required
        />
      )}
      {error && <p className="text-error text-sm">{error}</p>}
      <button
        type="submit"
        disabled={pending || !teamPassword}
        className="w-full btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {pending ? "发送中..." : "重发邀请"}
      </button>
    </form>
  );
}
