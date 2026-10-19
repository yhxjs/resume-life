import { btnGhost, btnPrimary, inputCls, labelCls } from "@/lib/ui";
import type { ProxyCandidate, Settings, SettingsFeedback, SettingsFieldSetter } from "./settings-form-types";

export function ProxySettingsSection({
  settings,
  proxyCandidates,
  detectingProxy,
  testingProxy,
  saving,
  proxyMessage,
  onChange,
  onDetectProxy,
  onApplyCandidate,
  onTestProxy,
  onSaveProxy,
}: {
  settings: Settings;
  proxyCandidates: ProxyCandidate[];
  detectingProxy: boolean;
  testingProxy: boolean;
  saving: boolean;
  proxyMessage: SettingsFeedback | null;
  onChange: SettingsFieldSetter;
  onDetectProxy: () => void;
  onApplyCandidate: (candidate: ProxyCandidate) => void;
  onTestProxy: () => void;
  onSaveProxy: (enabled: boolean) => void;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-serif font-bold text-ink block">网络代理</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                settings.proxy_enabled
                  ? "bg-primary/10 text-primary"
                  : "bg-surface text-faint"
              }`}
            >
              {settings.proxy_enabled ? "已启用" : "未启用"}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-faint leading-relaxed">
            代理用于 AI 请求、模型列表和连接测试，不会修改系统代理设置。
          </p>
        </div>
        <button className={btnGhost} onClick={onDetectProxy} disabled={detectingProxy}>
          {detectingProxy ? "嗅探中…" : "嗅探本机代理"}
        </button>
      </div>

      {proxyCandidates.length > 0 && (
        <div className="space-y-2 rounded-xl border border-line bg-surface/45 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted">发现的代理候选</span>
            <span className="text-[10px] text-faint">点击“使用”填入表单</span>
          </div>
          <div className="space-y-1.5">
            {proxyCandidates.map((candidate) => {
              const sourceLabel = candidate.source === "environment"
                ? "环境变量"
                : candidate.source === "windows"
                  ? "Windows 系统"
                  : "本机端口";
              return (
                <div
                  key={`${candidate.source}:${candidate.url}:${candidate.username ?? ""}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {candidate.protocol.toUpperCase()}
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">
                        {sourceLabel}
                      </span>
                    </div>
                    <code className="mt-1 block truncate text-[11px] text-ink" title={candidate.url}>
                      {candidate.url}
                    </code>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary-soft"
                    onClick={() => onApplyCandidate(candidate)}
                  >
                    使用
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-4">
        <label className="block">
          <span className={labelCls}>代理地址</span>
          <div className="relative mt-1">
            <input
              className={`${inputCls} pr-8 font-mono text-xs`}
              value={settings.proxy_url}
              onChange={(e) => onChange("proxy_url", e.target.value)}
              placeholder="socks5://127.0.0.1:10808"
              spellCheck={false}
            />
            {settings.proxy_url && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() => onChange("proxy_url", "")}
                aria-label="清除代理地址"
                title="清除代理地址"
              >
                ×
              </button>
            )}
          </div>
          <span className="mt-1 block text-[11px] text-faint leading-relaxed">
            支持 HTTP、HTTPS 和 SOCKS5，例如 <span className="font-mono">http://127.0.0.1:7890</span>。
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className={labelCls}>用户名（可选）</span>
            <div className="relative mt-1">
              <input
                className={`${inputCls} pr-8 text-xs`}
                value={settings.proxy_username}
                onChange={(e) => onChange("proxy_username", e.target.value)}
                autoComplete="off"
              />
              {settings.proxy_username && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
                  onClick={() => onChange("proxy_username", "")}
                  aria-label="清除代理用户名"
                  title="清除代理用户名"
                >
                  ×
                </button>
              )}
            </div>
          </label>
          <label className="block">
            <span className={labelCls}>密码（可选，保存后脱敏）</span>
            <div className="relative mt-1">
              <input
                className={`${inputCls} pr-8 text-xs`}
                type="password"
                value={settings.proxy_password}
                onChange={(e) => onChange("proxy_password", e.target.value)}
                autoComplete="new-password"
              />
              {settings.proxy_password && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
                  onClick={() => onChange("proxy_password", "")}
                  aria-label="清除代理密码"
                  title="清除代理密码"
                >
                  ×
                </button>
              )}
            </div>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button className={btnGhost} onClick={onTestProxy} disabled={testingProxy || !settings.proxy_url.trim()}>
          {testingProxy ? "测试中…" : "测试代理"}
        </button>
        <button className={btnPrimary} onClick={() => onSaveProxy(true)} disabled={saving}>
          {saving ? "正在保存…" : "保存并启用"}
        </button>
        {settings.proxy_enabled && (
          <button className={btnGhost} onClick={() => onSaveProxy(false)} disabled={saving}>
            关闭代理
          </button>
        )}
        {proxyMessage && (
          <div
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
              proxyMessage.kind === "ok"
                ? "border border-primary/20 bg-primary-soft text-primary"
                : proxyMessage.kind === "err"
                  ? "border border-danger/20 bg-danger-wash text-danger"
                  : "border border-line bg-surface text-muted"
            }`}
          >
            {proxyMessage.text}
          </div>
        )}
      </div>
    </div>
  );
}
