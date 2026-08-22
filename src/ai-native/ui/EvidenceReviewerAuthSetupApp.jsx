import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  LockKeyhole,
  LogOut,
  QrCode,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import {
  createReviewerSupabaseClient,
  enrollReviewerTotp,
  readReviewerAuthState,
  signInReviewer,
  signOutReviewer,
  updateReviewerPassword,
  verifyReviewerTotp,
} from "../evidence/reviewerAuthClient.js";

function resolveClient() {
  try {
    return {
      client: createReviewerSupabaseClient({
        projectUrl: import.meta.env.VITE_QL_SUPABASE_PROJECT_URL,
        publishableKey: import.meta.env.VITE_QL_SUPABASE_PUBLISHABLE_KEY,
      }),
      error: null,
    };
  } catch {
    return { client: null, error: "REVIEWER_AUTH_CONFIG_MISSING" };
  }
}

function messageFor(error) {
  const code = typeof error === "string" ? error : error?.message ?? "REVIEWER_AUTH_FAILED";
  const messages = {
    REVIEWER_AUTH_CONFIG_MISSING: "本地尚未配置 Supabase Project URL 与 publishable key。",
    REVIEWER_AUTH_CREDENTIALS_INVALID: "请填写有效邮箱和密码。",
    REVIEWER_AUTH_SIGN_IN_FAILED: "登录失败。请检查账号、密码和邀请状态。",
    REVIEWER_AUTH_PASSWORD_INVALID: "新密码至少需要 12 个字符。",
    REVIEWER_AUTH_PASSWORD_UPDATE_FAILED: "密码设置失败，请重新打开邀请链接后再试。",
    REVIEWER_AUTH_TOTP_INVALID: "请输入验证器显示的 6 位数字。",
    REVIEWER_AUTH_ENROLL_FAILED: "无法创建 TOTP 绑定，请退出后重试。",
    REVIEWER_AUTH_CHALLENGE_FAILED: "无法创建 MFA 验证挑战，请重试。",
    REVIEWER_AUTH_VERIFY_FAILED: "验证码无效或已过期，请输入验证器中的新代码。",
  };
  return messages[code] ?? "认证状态无法验证；没有获得审核权限。";
}

function AuthShell({ children }) {
  return (
    <div className="theme-root" data-theme="light">
      <main className="review-auth-shell">
        <header><a href="/"><ArrowLeft aria-hidden="true" />返回 QuietLens</a><span><LockKeyhole aria-hidden="true" />localhost · reviewer bootstrap</span></header>
        {children}
      </main>
    </div>
  );
}

export function EvidenceReviewerAuthSetupApp() {
  const [{ client, error: configError }] = useState(resolveClient);
  const [authState, setAuthState] = useState({ status: "loading" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [pendingFactor, setPendingFactor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(configError);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setAuthState(await readReviewerAuthState(client));
      setError(null);
    } catch (caught) {
      setError(caught);
      setAuthState({ status: "blocked" });
    }
  }, [client]);

  useEffect(() => {
    if (!client) return undefined;
    void refresh();
    const { data } = client.auth.onAuthStateChange(() => { setTimeout(() => { void refresh(); }, 0); });
    return () => data.subscription.unsubscribe();
  }, [client, refresh]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  function submitLogin(event) {
    event.preventDefault();
    const submittedPassword = password;
    setPassword("");
    void run(async () => setAuthState(await signInReviewer(client, { email, password: submittedPassword })));
  }

  function submitPassword(event) {
    event.preventDefault();
    const submittedPassword = newPassword;
    setNewPassword("");
    void run(async () => {
      await updateReviewerPassword(client, submittedPassword);
      await refresh();
    });
  }

  function beginEnrollment() {
    void run(async () => {
      setPendingFactor(await enrollReviewerTotp(client));
      setTotpCode("");
    });
  }

  function submitTotp(event) {
    event.preventDefault();
    const factorId = pendingFactor?.factor_id ?? authState.factor_id;
    const submittedCode = totpCode;
    setTotpCode("");
    void run(async () => {
      setAuthState(await verifyReviewerTotp(client, { factorId, code: submittedCode }));
      setPendingFactor(null);
    });
  }

  function logout() {
    void run(async () => {
      setAuthState(await signOutReviewer(client));
      setPendingFactor(null);
      setEmail("");
    });
  }

  if (!client) {
    return <AuthShell><section className="review-auth-card"><TriangleAlert aria-hidden="true" /><h1>先完成本地公开配置</h1><p>{messageFor(configError)}</p><code>VITE_QL_SUPABASE_PROJECT_URL</code><code>VITE_QL_SUPABASE_PUBLISHABLE_KEY</code><small>只能使用 publishable/anon key；Service Role Key 永远不能进入 VITE_ 变量。</small></section></AuthShell>;
  }

  return (
    <AuthShell>
      <section className="review-auth-card">
        <div className="review-auth-heading"><ShieldCheck aria-hidden="true" /><div><span>Stage 2 · S2-T02</span><h1>审核员安全启动</h1><p>这里只建立 Supabase 登录与 TOTP AAL2。通过后仍不会自动获得 grant、审核或发布权限。</p></div></div>

        {error && <div className="review-auth-error"><TriangleAlert aria-hidden="true" />{messageFor(error)}</div>}

        {authState.status === "loading" && <p className="review-auth-wait">正在确认本地 session…</p>}

        {authState.status === "signed_out" && (
          <form onSubmit={submitLogin}>
            <label>审核账号邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            <button type="submit" disabled={busy}><KeyRound aria-hidden="true" />登录并检查 MFA</button>
          </form>
        )}

        {["enrollment_required", "challenge_required"].includes(authState.status) && (
          <>
            {authState.status === "enrollment_required" && (
              <form onSubmit={submitPassword}>
                <label>首次设置或更新密码<input type="password" autoComplete="new-password" minLength="12" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
                <button type="submit" disabled={busy}><KeyRound aria-hidden="true" />保存密码</button>
              </form>
            )}

            {authState.status === "enrollment_required" && !pendingFactor && <button className="review-auth-secondary" type="button" onClick={beginEnrollment} disabled={busy}><QrCode aria-hidden="true" />生成一次性 TOTP 二维码</button>}

            {pendingFactor?.qr_code && <div className="review-auth-qr"><img src={pendingFactor.qr_code} alt="QuietLens 审核账号 TOTP 二维码" /><p>只用你手机里的验证器扫描。不要截图、上传或发给 AI。</p></div>}

            {(pendingFactor || authState.status === "challenge_required") && (
              <form onSubmit={submitTotp}>
                <label>6 位验证码<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} required /></label>
                <button type="submit" disabled={busy}><ShieldCheck aria-hidden="true" />验证并达到 AAL2</button>
              </form>
            )}
          </>
        )}

        {authState.status === "ready_aal2" && <div className="review-auth-success"><CheckCircle2 aria-hidden="true" /><div><strong>MFA 已通过，当前 session 为 AAL2</strong><p>审核 API 仍关闭；还需要服务端 reviewer/auditor grant 才能进入真实工作台。</p></div></div>}

        {authState.status !== "signed_out" && authState.status !== "loading" && <button className="review-auth-logout" type="button" onClick={logout} disabled={busy}><LogOut aria-hidden="true" />退出审核账号</button>}
      </section>
    </AuthShell>
  );
}
