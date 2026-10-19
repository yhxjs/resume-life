"use client";

import { useEffect, useState, type FormEvent } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { safeLoginReturnPath } from "@/lib/login-return-path";
import { btnPrimary, cardCls, inputCls, labelCls } from "@/lib/ui";

type AuthStatusResponse = {
  initialized: boolean;
  allowReinit: boolean;
};

type Mode = "login" | "init" | "reinit";

/** 只接受站内相对路径，防开放重定向；非法值一律回首页 */
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next") ?? "/";
  return safeLoginReturnPath(next, window.location.origin);
}

const MODE_TITLE: Record<Mode, string> = {
  login: "登录以继续",
  init: "设置用户名和密码",
  reinit: "重新初始化用户名和密码",
};

const MODE_DESC: Record<Mode, string> = {
  login: "首次使用请先完成初始化；登录状态保留 7 天，期间访问会自动续期",
  init: "首次启动：设置一组本地登录凭证，用于之后访问本应用",
  reinit: "检测到 RESUME_LIFE_AUTH_REINIT 已开启：提交后将覆写现有用户名和密码，其他数据不变",
};

function LoginForm({ mode }: { mode: Mode }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode !== "login" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/init";
      await jsonFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      window.location.assign(safeNext());
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
      <div className="space-y-2">
        <label className={labelCls} htmlFor="login-username">用户名</label>
        <input
          id="login-username"
          className={inputCls}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />
      </div>
      <div className="space-y-2">
        <label className={labelCls} htmlFor="login-password">密码</label>
        <input
          id="login-password"
          type="password"
          className={inputCls}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
        />
      </div>
      {mode !== "login" && (
        <div className="space-y-2">
          <label className={labelCls} htmlFor="login-confirm">确认密码</label>
          <input
            id="login-confirm"
            type="password"
            className={inputCls}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={submitting} className={`${btnPrimary} w-full`}>
        {submitting ? "请稍候…" : mode === "login" ? "登录" : "保存并进入"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    jsonFetch<AuthStatusResponse>("/api/auth/status")
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "无法连接服务器");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: Mode | null = status === null
    ? null
    : !status.initialized
      ? "init"
      : status.allowReinit
        ? "reinit"
        : "login";

  return (
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center py-10">
      <div className={`${cardCls} w-full max-w-md p-6 sm:p-8`}>
        <div className="mb-6 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="简历奕生 Logo"
            width={44}
            height={44}
            className="rounded-xl object-cover shadow-xs ring-1 ring-line"
          />
          <div>
            <h1 className="font-serif text-xl font-bold text-ink leading-tight">简历奕生</h1>
            <p className="mt-0.5 text-sm text-muted">{mode ? MODE_TITLE[mode] : "正在连接服务器…"}</p>
          </div>
        </div>

        {mode && (
          <p className="mb-5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
            {MODE_DESC[mode]}
          </p>
        )}

        {loadError && <p className="mb-4 text-sm text-danger">{loadError}</p>}
        {mode ? (
          <LoginForm mode={mode} />
        ) : (
          !loadError && <div className="h-40 animate-pulse rounded-lg bg-surface-2" data-testid="login-loading" />
        )}
      </div>
    </div>
  );
}
