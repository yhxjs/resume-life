"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary } from "@/lib/ui";
import { resolveUsageRange } from "@/lib/llm-usage-range";
import { BackupManager, type BackupManagerHandle } from "@/components/settings/backup-manager";
import { LocalDataCleanup } from "@/components/settings/local-data-cleanup";
import { errorMessage } from "@/lib/error-message";
import { ModelSettingsSection, OcrSettingsSection } from "@/components/settings/model-settings-section";
import { ProxySettingsSection } from "@/components/settings/proxy-settings-section";
import type { ProxyCandidate, Settings, SettingsFeedback } from "@/components/settings/settings-form-types";

const EMPTY: Settings = {
  base_url: "",
  api_key: "",
  api_format: "openai_chat",
  model_parse: "",
  model_summary: "",
  model_question: "",
  model_evaluate: "",
  max_output_tokens: "8192",
  ocr_mode: "auto",
  proxy_enabled: false,
  proxy_url: "",
  proxy_username: "",
  proxy_password: "",
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const connectionTestRef = useRef<AbortController | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [proxyCandidates, setProxyCandidates] = useState<ProxyCandidate[]>([]);
  const [detectingProxy, setDetectingProxy] = useState(false);
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyMessage, setProxyMessage] = useState<SettingsFeedback | null>(null);
  const [monthCalls, setMonthCalls] = useState<number | null>(null);
  const [message, setMessage] = useState<SettingsFeedback | null>(null);
  const backupRef = useRef<BackupManagerHandle>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => () => {
    const pending = connectionTestRef.current;
    connectionTestRef.current = null;
    pending?.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<Settings>("/api/settings")
      .then((data) => {
        if (cancelled) return;
        setSettings({ ...EMPTY, ...data });
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(`加载设置失败：${errorMessage(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // 入口卡片展示本月调用次数；请求失败时静默降级为不显示计数，不影响设置页本身。
    const range = resolveUsageRange("month", new Date());
    const params = new URLSearchParams();
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    jsonFetch<{ calls: number }>(`/api/settings/llm-usage?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setMonthCalls(data.calls);
      })
      .catch(() => {
        if (cancelled) return;
        setMonthCalls(null);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  function set(key: Exclude<keyof Settings, "proxy_enabled">, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function save(nextSettings: Settings = settings) {
    setSaving(true);
    setMessage(null);
    try {
      const { baseUrlWarning, ...saved } = await jsonFetch<Settings & { baseUrlWarning: string | null }>(
        "/api/settings",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(nextSettings),
        }
      );
      setSettings({ ...EMPTY, ...saved });
      setMessage(baseUrlWarning ? { kind: "info", text: `已保存。${baseUrlWarning}` } : { kind: "ok", text: "已保存" });
      backupRef.current?.refreshStats();
    } catch (err) {
      setMessage({ kind: "err", text: `保存失败：${errorMessage(err)}` });
    } finally {
      setSaving(false);
    }
  }

  async function fetchModels() {
    setFetchingModels(true);
    setMessage({ kind: "info", text: "获取模型列表中…" });
    try {
      const data = await jsonFetch<{ ok: boolean; models?: string[]; error?: string }>(
        "/api/settings/models",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base_url: settings.base_url,
            api_key: settings.api_key,
            api_format: settings.api_format,
            proxy_enabled: settings.proxy_enabled,
            proxy_url: settings.proxy_url,
            proxy_username: settings.proxy_username,
            proxy_password: settings.proxy_password,
          }),
        }
      );
      if (!data.ok) throw new Error(data.error ?? "未知错误");
      setModels(data.models ?? []);
      setMessage({ kind: "ok", text: `已获取 ${data.models?.length ?? 0} 个模型，可在下方输入框直接选择` });
    } catch (err) {
      setMessage({ kind: "err", text: `获取模型失败：${errorMessage(err)}` });
    } finally {
      setFetchingModels(false);
    }
  }

  async function detectProxy() {
    setDetectingProxy(true);
    setProxyMessage({ kind: "info", text: "正在嗅探本机代理…" });
    try {
      const data = await jsonFetch<{ ok: boolean; candidates?: ProxyCandidate[]; error?: string }>(
        "/api/settings/proxy/detect",
      );
      if (!data.ok) throw new Error(data.error ?? "未找到可用代理");
      setProxyCandidates(data.candidates ?? []);
      setProxyMessage({
        kind: data.candidates?.length ? "ok" : "info",
        text: data.candidates?.length ? `发现 ${data.candidates.length} 个代理候选` : "未发现可用候选，可手动填写代理地址",
      });
    } catch (err) {
      setProxyMessage({ kind: "err", text: `嗅探失败：${errorMessage(err)}` });
    } finally {
      setDetectingProxy(false);
    }
  }

  function applyProxyCandidate(candidate: ProxyCandidate) {
    setSettings((prev) => ({
      ...prev,
      proxy_url: candidate.url,
      proxy_username: candidate.username ?? "",
      proxy_password: "",
    }));
    setProxyMessage({ kind: "info", text: "候选已填入，请按需补充认证信息后测试" });
  }

  async function testProxy() {
    setTestingProxy(true);
    setProxyMessage({ kind: "info", text: "正在测试代理…" });
    try {
      const data = await jsonFetch<{ ok: boolean; protocol?: string; host?: string; port?: number; error?: string }>(
        "/api/settings/proxy/test",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proxy_enabled: true,
            proxy_url: settings.proxy_url,
            proxy_username: settings.proxy_username,
            proxy_password: settings.proxy_password,
          }),
        },
      );
      if (!data.ok) throw new Error(data.error ?? "代理测试失败");
      setProxyMessage({ kind: "ok", text: `代理可用：${data.protocol}://${data.host}:${data.port}` });
    } catch (err) {
      setProxyMessage({ kind: "err", text: `代理测试失败：${errorMessage(err)}` });
    } finally {
      setTestingProxy(false);
    }
  }

  async function saveProxy(enabled: boolean) {
    await save({ ...settings, proxy_enabled: enabled });
  }

  async function testConnection() {
    if (connectionTestRef.current) return;
    const controller = new AbortController();
    connectionTestRef.current = controller;
    setTestingConnection(true);
    setMessage({ kind: "info", text: "测试中…" });
    try {
      const data = await jsonFetch<{ ok: boolean; reply?: string; error?: string }>("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
          body: JSON.stringify({
            base_url: settings.base_url,
            api_key: settings.api_key,
            api_format: settings.api_format,
            model: (settings.model_parse || settings.model_summary || settings.model_question || settings.model_evaluate || "").trim(),
            proxy_enabled: settings.proxy_enabled,
            proxy_url: settings.proxy_url,
            proxy_username: settings.proxy_username,
            proxy_password: settings.proxy_password,
          }),
      });
      if (controller.signal.aborted) return;
      setMessage(
        data.ok
          ? { kind: "ok", text: `连接成功，模型回复：${data.reply || "(空)"}` }
          : { kind: "err", text: `连接失败：${data.error ?? "未知错误"}` }
      );
    } catch (err) {
      if (!controller.signal.aborted) setMessage({ kind: "err", text: `测试失败：${errorMessage(err)}` });
    } finally {
      if (connectionTestRef.current === controller) {
        connectionTestRef.current = null;
        setTestingConnection(false);
      }
    }
  }

  if (loading) return <Loading />;
  if (loadError) return <LoadError message={loadError} onRetry={() => {
    setLoadError(""); setLoading(true); setLoadAttempt((attempt) => attempt + 1);
  }} />;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            系统设置
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            配置 AI 模型服务凭证，或进行系统全量数据的一键打包备份与覆盖恢复。
          </p>
        </div>
      </div>

      {/* 用量统计入口 */}
      <Link
        href="/settings/usage"
        className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-card p-5 shadow-card-subtle transition-colors hover:bg-surface"
      >
        <div>
          <span className="text-xs font-serif font-bold text-ink block">用量统计</span>
          <span className="mt-1 block text-xs text-muted leading-relaxed">
            {monthCalls === null
              ? "查看 AI 调用的 token 计量、来源追踪与缓存命中率"
              : `本月调用 ${monthCalls} 次 · 查看 token 计量、来源追踪与缓存命中率`}
          </span>
        </div>
        <span className="shrink-0 text-sm font-medium text-primary">查看 →</span>
      </Link>

      {/* AI 模型与服务设置 */}
      <div className="space-y-6">
        <ModelSettingsSection
          settings={settings}
          models={models}
          fetchingModels={fetchingModels}
          onChange={set}
          onFetchModels={fetchModels}
        />

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button className={btnPrimary} onClick={() => save()} disabled={saving}>
            {saving ? "正在保存…" : "保存配置"}
          </button>
          <button className={btnGhost} onClick={testConnection} disabled={testingConnection} aria-busy={testingConnection}>
            {testingConnection ? "测试中…" : "测试连接"}
          </button>
          {message && (
            <div
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                message.kind === "ok"
                  ? "border border-primary/20 bg-primary-soft text-primary"
                  : message.kind === "err"
                    ? "border border-danger/20 bg-danger-wash text-danger"
                    : "border border-line bg-surface text-muted"
              }`}
            >
              {message.text}
            </div>
          )}
        </div>

        <ProxySettingsSection
          settings={settings}
          proxyCandidates={proxyCandidates}
          detectingProxy={detectingProxy}
          testingProxy={testingProxy}
          saving={saving}
          proxyMessage={proxyMessage}
          onChange={set}
          onDetectProxy={detectProxy}
          onApplyCandidate={applyProxyCandidate}
          onTestProxy={testProxy}
          onSaveProxy={saveProxy}
        />
        <OcrSettingsSection value={settings.ocr_mode} onChange={(value) => set("ocr_mode", value)} />
      </div>

      {/* 数据管理与灾备恢复组件 */}
      <BackupManager ref={backupRef} />
      <LocalDataCleanup />
    </div>
  );
}
