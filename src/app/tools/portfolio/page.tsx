"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { Loading, LoadError, PageHeader, SectionTitle } from "@/components/common/ui-bits";
import { btnGhost, btnPrimary, inputCls, labelCls } from "@/lib/ui";
import type { PortfolioSourcesData, PortfolioExportOptions } from "@/lib/portfolio-types";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";
import { PortfolioLivePreview } from "@/components/portfolio/portfolio-live-preview";
import { PORTFOLIO_TEMPLATES, type PortfolioTemplateId } from "@/lib/portfolio-templates";

export default function PortfolioWorkspacePage() {
  const [sources, setSources] = useState<PortfolioSourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [resumeId, setResumeId] = useState<number | null>(null);
  const [versionId, setVersionId] = useState<number | null>(null);
  const [siteTitle, setSiteTitle] = useState("");
  const [siteSubtitle, setSiteSubtitle] = useState("");
  const [accentColor, setAccentColor] = useState("#b8ef67");
  const [themeMode, setThemeMode] = useState<"auto" | "light" | "dark">("dark");
  const [siteTemplate, setSiteTemplate] = useState<PortfolioTemplateId>("flow");

  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<PortfolioSourcesData>("/api/portfolio/sources", { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setSources(data);
        const first = data.resumes[0];
        if (first) { setResumeId(first.id); setVersionId(first.versions[0]?.id ?? null); }
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);

  const options = useMemo<PortfolioExportOptions | null>(() => resumeId ? {
    resumeId, versionId, siteTitle, siteSubtitle, accentColor, themeMode, siteTemplate,
    selectedProjects: [], anonymizeConfig: DEFAULT_ANONYMIZE_CONFIG,
  } : null, [resumeId, versionId, siteTitle, siteSubtitle, accentColor, themeMode, siteTemplate]);

  const download = async () => {
    if (!options || exporting) return;
    setError("");
    setExporting(true);
    try {
      const response = await apiFetch("/api/portfolio/export", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "导出失败，请重试");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `resume-site-${Date.now()}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setExporting(false); }
  };

  if (loading) return <Loading label="正在加载简历…" />;
  if (!sources && error) return <LoadError message={error} onRetry={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }} />;
  const currentResume = sources?.resumes.find((resume) => resume.id === resumeId);

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 pb-8">
      <nav aria-label="面包屑" className="flex items-center gap-2 text-xs text-muted"><Link href="/tools" className="hover:text-primary">求职工具箱</Link><span aria-hidden>/</span><span>个人主页</span></nav>
      <PageHeader title="个人作品集与静态主页工作台" desc="我的经历，我的下一程。" actions={
        <button type="button" className={btnPrimary} onClick={download} disabled={!options || exporting} aria-describedby="portfolio-privacy-note">{exporting ? "正在打包…" : "生成并下载作品集"}</button>
      } />
      {error && <LoadError message={error} />}
      <div className="grid items-start gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6 xl:sticky xl:top-20">
          <section className="space-y-4 border-b border-line pb-6" aria-label="简历来源">
            <SectionTitle>简历内容</SectionTitle>
            {!sources?.resumes.length ? <div className="space-y-3 text-sm text-muted"><p>还没有简历。</p><Link href="/resumes" className={btnGhost}>创建简历</Link></div> : <>
              <div className="space-y-1.5"><label htmlFor="portfolio-resume" className={labelCls}>选择简历</label>
                <select id="portfolio-resume" className={inputCls} value={resumeId ?? ""} onChange={(event) => {
                  const id = Number(event.target.value); setResumeId(id);
                  setVersionId(sources.resumes.find((resume) => resume.id === id)?.versions[0]?.id ?? null);
                }}>{sources.resumes.map((resume) => <option key={resume.id} value={resume.id}>{resume.title}</option>)}</select>
              </div>
              <div className="space-y-1.5"><label htmlFor="portfolio-version" className={labelCls}>选择版本快照</label>
                <select id="portfolio-version" className={inputCls} value={versionId ?? ""} onChange={(event) => setVersionId(event.target.value ? Number(event.target.value) : null)}>
                  <option value="">当前最新草稿</option>{currentResume?.versions.map((version) => <option key={version.id} value={version.id}>v{version.version} · {version.name}</option>)}
                </select>
              </div>
              <Link href={`/resumes/${resumeId}`} className={`${btnGhost} w-full`}>编辑简历内容 <span aria-hidden>↗</span></Link>
            </>}
          </section>
          <section className="space-y-4 border-b border-line pb-6" aria-label="主页外观">
            <SectionTitle>主页外观</SectionTitle>
            <div className="space-y-1.5"><label htmlFor="portfolio-template" className={labelCls}>主页模板</label>
              <select id="portfolio-template" className={inputCls} value={siteTemplate} onChange={(event) => setSiteTemplate(event.target.value as PortfolioTemplateId)}>
                {PORTFOLIO_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.name} · {template.description}</option>)}
              </select>
            </div>
            <div className="space-y-1.5"><label htmlFor="portfolio-title" className={labelCls}>网页标题</label><input id="portfolio-title" className={inputCls} value={siteTitle} onChange={(event) => setSiteTitle(event.target.value)} placeholder={currentResume?.title || "我的个人简历"} /></div>
            <div className="space-y-1.5"><label htmlFor="portfolio-subtitle" className={labelCls}>首屏介绍</label><input id="portfolio-subtitle" className={inputCls} value={siteSubtitle} onChange={(event) => setSiteSubtitle(event.target.value)} placeholder="留空使用简历中的个人简介" /></div>
            <div className="space-y-1.5"><div id="portfolio-theme-label" className={labelCls}>主题模式</div>
              <div role="group" aria-labelledby="portfolio-theme-label" className="flex rounded-lg border border-line p-1">
                {(["dark", "light", "auto"] as const).map((mode) => <button key={mode} type="button" aria-pressed={themeMode === mode} onClick={() => setThemeMode(mode)} className={`min-h-9 flex-1 rounded text-xs focus-visible:outline-2 focus-visible:outline-primary ${themeMode === mode ? "bg-primary-soft font-medium text-primary" : "text-muted hover:bg-surface"}`}>{mode === "auto" ? "跟随系统" : mode === "light" ? "浅色" : "深色"}</button>)}
              </div>
            </div>
            <div className="flex items-center justify-between gap-3"><label htmlFor="portfolio-accent" className={labelCls}>点缀色</label><div className="flex items-center gap-2"><span className="font-mono text-xs text-muted">{accentColor}</span><input id="portfolio-accent" type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} className="h-9 w-11 cursor-pointer rounded-lg border border-line bg-card p-1 focus-visible:outline-2 focus-visible:outline-primary" /></div></div>
          </section>
          <section id="portfolio-privacy" className="space-y-3 text-xs leading-relaxed text-muted">
            <h2 className="font-semibold text-ink">公开版本 · 基础信息脱敏</h2>
            <p id="portfolio-privacy-note">姓名和联系方式按默认规则遮盖；经历正文与其他敏感内容仍需人工核对。</p>
            <p>下载后先在本地解压，检查主页和简历中的姓名、公司信息及联系方式；确认后再公开部署。</p>
            <button type="button" className={`${btnGhost} w-full`} onClick={download} disabled={!options || exporting}>{exporting ? "正在打包…" : "下载静态简历 Zip"}</button>
          </section>
        </div>
        <PortfolioLivePreview options={options} />
      </div>
    </div>
  );
}
