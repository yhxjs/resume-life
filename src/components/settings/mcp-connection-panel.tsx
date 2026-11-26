"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary, inputCls, textareaCls } from "@/lib/ui";
import type { McpConnectionConfig, McpConnectionFormat, McpConnectionPreset, McpConnectionReport } from "@/lib/mcp-connection-types";

export function McpConnectionPanel() {
  const [report, setReport] = useState<McpConnectionReport | null>(null);
  const [preset, setPreset] = useState<McpConnectionPreset>("readonly");
  const [format, setFormat] = useState<McpConnectionFormat>("json");
  const [config, setConfig] = useState<McpConnectionConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const diagnosis = useRef<AbortController | null>(null);
  const generation = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const copyOwner = useRef<number | null>(null);

  const invalidateConfig = useCallback(() => {
    revision.current++;
    generation.current?.abort(); generation.current = null;
    copyOwner.current = null;
    setConfig(null); setGenerating(false); setCopying(false); setNotice(""); setError("");
  }, []);

  const refresh = useCallback(async () => {
    if (!alive.current || diagnosis.current) return;
    invalidateConfig();
    const controller = new AbortController(); diagnosis.current = controller;
    setLoading(true); setReport(null);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await jsonFetch<McpConnectionReport>("/api/settings/mcp", { signal: controller.signal });
      if (alive.current && diagnosis.current === controller && !controller.signal.aborted) setReport(result);
    } catch {
      if (alive.current && diagnosis.current === controller) setError("诊断未完成，请检查应用状态后重试。");
    } finally {
      clearTimeout(timer);
      if (alive.current && diagnosis.current === controller) { diagnosis.current = null; setLoading(false); }
    }
  }, [invalidateConfig]);

  useEffect(() => {
    alive.current = true;
    // Let the settings form paint before starting local environment probes.
    const timer = setTimeout(() => { void refresh(); }, 0);
    const ownedRevision = revision;
    return () => {
      clearTimeout(timer);
      alive.current = false; ownedRevision.current++; copyOwner.current = null;
      diagnosis.current?.abort(); diagnosis.current = null;
      generation.current?.abort(); generation.current = null;
    };
  }, [refresh]);

  async function generate() {
    if (!alive.current || diagnosis.current || generation.current || !report?.canGenerate) return;
    invalidateConfig();
    const controller = new AbortController(); generation.current = controller;
    setGenerating(true);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await jsonFetch<McpConnectionConfig>("/api/settings/mcp", {
        method: "POST", body: JSON.stringify({ preset, format }), signal: controller.signal,
      });
      if (alive.current && generation.current === controller && !controller.signal.aborted) setConfig(result);
    } catch {
      if (alive.current && generation.current === controller) setError("配置生成失败，请刷新诊断后重试。");
    } finally {
      clearTimeout(timer);
      if (alive.current && generation.current === controller) { generation.current = null; setGenerating(false); }
    }
  }

  async function copy() {
    if (!alive.current || !config || copyOwner.current !== null) return;
    const owner = revision.current; copyOwner.current = owner;
    setCopying(true); setNotice(""); setError("");
    try {
      await navigator.clipboard.writeText(config.text);
      if (alive.current && owner === revision.current) setNotice("已复制配置。请在 Host 中手动导入并重启 MCP 服务。");
    } catch {
      if (alive.current && owner === revision.current) setError("无法访问剪贴板，请选中下方配置手动复制。");
    } finally {
      if (alive.current && copyOwner.current === owner) { copyOwner.current = null; setCopying(false); }
    }
  }

  return <section aria-labelledby="mcp-connection-title" className="space-y-4 rounded-2xl border border-line bg-card p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="mcp-connection-title" className="font-serif text-lg font-bold text-ink">MCP 接入向导</h2>
      <button type="button" className={btnGhost} onClick={() => void refresh()} disabled={loading} aria-busy={loading}>{loading ? "诊断中…" : "刷新诊断"}</button>
    </div>
    <p className="text-sm text-muted">在同一台电脑、同一操作系统中通过 stdio 连接外部 Agent。此处生成配置供你手动导入，不会修改 Host 设置。外部 Host 连接状态：未验证。</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {report && <>
      <h3 className="font-medium text-ink">1. 检查本机环境</h3>
      <dl className="grid gap-2 text-sm break-all">
        <div><dt className="text-muted">Node（{report.node}）</dt><dd>{report.nodePath}</dd></div>
        <div><dt className="text-muted">项目目录</dt><dd>{report.projectRoot}</dd></div>
        <div><dt className="text-muted">数据目录</dt><dd>{report.dataDirectory}</dd></div>
        <div><dt className="text-muted">仓库访问范围</dt><dd>{report.repositoryRoots.length ? report.repositoryRoots.join("\n") : "未配置仓库白名单，仓库采集不可用。请在启动环境配置 RESUME_LIFE_MCP_REPO_ROOTS 后重启应用。"}</dd></div>
      </dl>
      <ul className="space-y-2 text-sm" aria-label="MCP 环境诊断">
        {report.checks.map(check => <li key={check.id} className="rounded-lg border border-line p-3">
          <p className="font-medium">{check.label} · {check.state === "pass" ? "检查通过" : check.state === "warning" ? "可选能力待确认" : "需要修复"}</p>
          <p className="mt-1 text-muted">{check.detail}</p>
          {check.repair && <p className="mt-1 text-muted">建议：{check.repair}</p>}
        </li>)}
      </ul>
      {report.status && <p className="text-xs text-muted">当前应用摘要：数据库 v{report.status.databaseVersion}，草稿 {report.status.drafts.available} 个，待处理生成请求 {report.status.generationRequests.pending} 个，操作日志 {report.status.operationLogCount} 条。此摘要不代表外部 Host 已连接。</p>}
      {report.status?.jobs && <p className="text-sm text-muted" role="status">后台任务：运行中 {report.status.jobs.running}，其中等待资源 {report.status.jobs.waiting}；中断 {report.status.jobs.interrupted}，失败 {report.status.jobs.failed}，成功 {report.status.jobs.succeeded}，取消 {report.status.jobs.cancelled}，恢复后失效 {report.status.jobs.invalidated}。</p>}
      {report.status?.leases && <p className="text-xs text-muted">正在占用：渲染 {report.status.leases.find(item => item.resource === "render")?.active ?? 0}，仓库采集 {report.status.leases.find(item => item.resource === "capture")?.active ?? 0}，文件解析 {report.status.leases.find(item => item.resource === "parse")?.active ?? 0}。</p>}
      {report.status?.cache && <p className="text-xs text-muted">临时缓存：{(report.status.cache.totalBytes / 1024 / 1024).toFixed(1)} / {(report.status.cache.maxBytes / 1024 / 1024).toFixed(1)} MiB，保留 {report.status.cache.ttlHours} 小时。点击刷新诊断更新任务和缓存状态。</p>}
      {report.status?.workspaceBinding && <details className="text-xs text-muted"><summary className="cursor-pointer">核对当前数据实例</summary><p className="mt-2 break-all"><code>{report.status.workspaceBinding}</code></p><p className="mt-1">首次调用 get_mcp_status 后核对 workspaceBinding 是否一致。此标识仅用于区分数据实例，不是访问凭证。</p></details>}
      <h3 className="font-medium text-ink">2. 选择权限并生成配置</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">权限预设<select className={inputCls} value={preset} onChange={event => { invalidateConfig(); setPreset(event.target.value as McpConnectionPreset); }}>
          {report.presets.map(item => <option key={item.name} value={item.name}>{item.label}（{item.name}）</option>)}
        </select></label>
        <label className="space-y-1 text-sm">配置格式<select className={inputCls} value={format} onChange={event => { invalidateConfig(); setFormat(event.target.value as McpConnectionFormat); }}>
          <option value="json">JSON</option><option value="codex">Codex TOML</option>
        </select></label>
      </div>
      <p className="text-sm text-muted">{report.presets.find(item => item.name === preset)?.description} 实际工具范围会与现有白名单取交集。所有预设均关闭服务端模型调用。</p>
      <button type="button" className={btnPrimary} onClick={() => void generate()} disabled={!report.canGenerate || generating || loading} aria-busy={generating}>{generating ? "生成中…" : "生成 MCP 配置"}</button>
      {!report.canGenerate && <p className="text-sm text-danger">请先修复上方必需项，再刷新诊断。</p>}
      {config && <div className="space-y-3">
        <p className="text-sm">配置包含 {config.toolCount} 个工具，{config.writeEnabled ? "允许预设内写入" : "只读"}。配置含本机路径，不含模型密钥。{config.toolCount === 0 ? "当前白名单交集为空，Host 无可用工具。" : ""}</p>
        <label className="block space-y-1 text-sm">生成的 MCP 配置<textarea readOnly spellCheck={false} className={`${textareaCls} font-mono text-xs`} value={config.text} onFocus={event => event.currentTarget.select()} /></label>
        <button type="button" className={btnGhost} onClick={() => void copy()} disabled={copying}>{copying ? "复制中…" : "复制 MCP 配置"}</button>
        {!config.firstCallAvailable && <p className="text-sm text-muted">当前白名单未开放 get_mcp_status。请先在服务端白名单中允许该工具，再完成首次调用验收。</p>}
      </div>}
      <h3 className="font-medium text-ink">3. 连接与首次调用验收</h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
        <li>首次接入建议选择只读。JSON 合并到 Host 的 mcpServers；Codex TOML 合并到本机配置的 mcp_servers.resume-life，避免重复配置同名服务。</li>
        <li>重启 Host 的 MCP 服务，确认工具列表出现。使用与上方相同的 Node、数据目录和操作系统账户；Windows 与 WSL 的配置路径不可混用。</li>
        <li>让 Agent 调用 get_mcp_status，参数为 {"{}"}，确认返回数据库摘要且无工具错误。仅看到工具列表或复制成功不能证明调用成功。</li>
        <li>如连接失败，在项目目录运行 <code>node scripts/mcp.mjs doctor</code>。此命令只检查本机启动条件，不验证外部 Host。</li>
      </ol>
      <details className="text-sm text-muted"><summary className="cursor-pointer">本机隔离验收（不使用个人资料）</summary>
        <p className="mt-2">在完整项目目录运行 <code>npx vitest run src/mcp/mcp-connection.integration.test.ts</code>。测试使用临时数据目录启动独立 stdio 客户端，验证配置与首次只读调用，结束后清理测试目录；不会更改外部 Host 配置。</p>
      </details>
    </>}
  </section>;
}
