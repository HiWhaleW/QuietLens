import { useEffect, useState } from "react";
import { ArrowRight, KeyRound, LoaderCircle, RotateCcw } from "lucide-react";

const STATUS = Object.freeze({ checking: "checking", required: "required", allowed: "allowed", failed: "failed" });

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function BetaInviteGate({ children }) {
  const [status, setStatus] = useState(STATUS.checking);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function checkSession(signal) {
    setStatus(STATUS.checking);
    setMessage("");
    try {
      const response = await fetch("/api/beta-access/session", {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal,
      });
      const body = await readJson(response);
      if (!response.ok || !body?.data) throw new Error("BETA_SESSION_CHECK_FAILED");
      setStatus(body.data.enabled && !body.data.authenticated ? STATUS.required : STATUS.allowed);
    } catch (error) {
      if (error.name !== "AbortError") setStatus(STATUS.failed);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    checkSession(controller.signal);
    return () => controller.abort();
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/beta-access/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: code.trim() }),
      });
      const body = await readJson(response);
      setCode("");
      if (!response.ok || !body?.data?.authenticated) {
        setMessage(response.status === 401 ? "邀请码无效或已失效" : "暂时无法验证邀请码");
        return;
      }
      setStatus(STATUS.allowed);
    } catch {
      setMessage("暂时无法验证邀请码");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === STATUS.allowed) return children;

  if (status === STATUS.checking) {
    return (
      <main className="beta-gate beta-gate-loading" aria-live="polite">
        <LoaderCircle className="is-spinning" aria-hidden="true" />
        <span>正在确认试用资格</span>
      </main>
    );
  }

  if (status === STATUS.failed) {
    return (
      <main className="beta-gate">
        <section className="beta-gate-panel">
          <img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" />
          <p>试用入口暂时不可用</p>
          <button type="button" className="beta-gate-retry" onClick={() => checkSession()}>
            <RotateCcw aria-hidden="true" />重试
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="beta-gate">
      <section className="beta-gate-panel" aria-labelledby="beta-gate-title">
        <img src="/assets/brand/quietlens-mark-ui-v1.png" alt="" />
        <div className="beta-gate-title">
          <span>QuietLens</span>
          <h1 id="beta-gate-title">封闭试用</h1>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="beta-invite-code">专属邀请码</label>
          <div className="beta-gate-input">
            <KeyRound aria-hidden="true" />
            <input
              id="beta-invite-code"
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              minLength={16}
              maxLength={128}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
              disabled={submitting}
              autoFocus
            />
          </div>
          <button type="submit" disabled={submitting || !code.trim()}>
            {submitting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
            进入
          </button>
          <p className="beta-gate-message" aria-live="polite">{message}</p>
        </form>
      </section>
    </main>
  );
}
