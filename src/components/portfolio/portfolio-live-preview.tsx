"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-fetch";
import { btnGhost } from "@/lib/ui";
import { useModalFocus } from "@/hooks/use-modal-focus";
import type { PortfolioExportOptions } from "@/lib/portfolio-types";

export function PortfolioLivePreview({ options }: { options: PortfolioExportOptions | null }) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [renderedOptions, setRenderedOptions] = useState<PortfolioExportOptions | null>(null);
  const [viewport, setViewport] = useState<"desktop" | "mobile">(() => typeof window !== "undefined" && window.innerWidth < 768 ? "mobile" : "desktop");
  const [expanded, setExpanded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [bounds, setBounds] = useState({ width: 0, height: 680 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const titleId = useId();
  const modalRef = useModalFocus(expanded, () => setExpanded(false));

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source === iframeRef.current?.contentWindow && event.data?.type === "resume-preview-escape") setExpanded(false);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!options) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await apiFetch("/api/portfolio/preview", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options), signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "预览生成失败");
        if (controller.signal.aborted) return;
        const document = new DOMParser().parseFromString(data.html, "text/html");
        const resumeJson = JSON.stringify(data.resumeHtml).replace(/</g, "\\u003c");
        const escapeScript = document.createElement("script");
        // Blob 必须由隔离 iframe 自己创建，跨来源的父窗口 Blob 无法在其中打开。
        escapeScript.textContent = `(function(){
          var resumeUrl=URL.createObjectURL(new Blob([${resumeJson}],{type:'text/html;charset=utf-8'}));
          document.querySelectorAll('a[href="resume.html"]').forEach(function(a){a.href=resumeUrl});
          window.addEventListener('pagehide',function(){URL.revokeObjectURL(resumeUrl)});
          document.addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage({type:'resume-preview-escape'},'*')});
        })();`;
        document.body.appendChild(escapeScript);
        setHtml(`<!DOCTYPE html>\n${document.documentElement.outerHTML}`);
        setRenderedOptions(options);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "预览生成失败");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 350);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [options, attempt]);

  const width = viewport === "mobile" ? 390 : 1280;
  const scale = Math.min(1, bounds.width / width);

  return (
    <div ref={modalRef} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined}
      aria-labelledby={expanded ? titleId : undefined} tabIndex={expanded ? -1 : undefined}
      className={expanded ? "fixed inset-0 z-50 flex flex-col bg-bg p-3 outline-none sm:p-5" : "flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-card"}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-card px-4 py-3">
        <div className="flex items-center gap-2"><h2 id={titleId} className="text-sm font-semibold">真实页面预览</h2><span role="status" className="text-xs text-muted">{error ? "预览失败" : options && (loading || options !== renderedOptions) ? "同步中…" : html && options ? "已同步" : ""}</span></div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="预览设备" className="flex rounded-lg border border-line p-0.5">
            {(["desktop", "mobile"] as const).map((mode) => <button key={mode} type="button" aria-pressed={viewport === mode} onClick={() => setViewport(mode)} className={`min-h-8 rounded px-3 text-xs focus-visible:outline-2 focus-visible:outline-primary ${viewport === mode ? "bg-primary-soft text-primary" : "text-muted"}`}>{mode === "desktop" ? "桌面" : "手机"}</button>)}
          </div>
          <button type="button" className={`${btnGhost} !min-h-8 !px-2`} title="重新播放" aria-label="重新播放" onClick={() => setAttempt((value) => value + 1)}>↻</button>
          <button type="button" className={`${btnGhost} !min-h-8 !px-2`} title={expanded ? "退出全屏" : "全屏预览"} aria-label={expanded ? "退出全屏" : "全屏预览"} onClick={() => setExpanded(!expanded)}>{expanded ? "×" : "⛶"}</button>
        </div>
      </div>
      <div ref={viewportRef} className={`relative flex min-w-0 justify-center overflow-hidden bg-surface ${expanded ? "min-h-0 flex-1" : "h-[720px] max-h-[80dvh] min-h-[500px]"}`}>
        {options && html && !error ? <iframe key={attempt} ref={iframeRef} title="动态简历真实页面" srcDoc={html} tabIndex={0}
          sandbox="allow-scripts allow-popups" className="absolute top-0 border-0 bg-card"
          style={{ width, height: scale ? bounds.height / scale : bounds.height, transform: `scale(${scale})`, transformOrigin: "top center", visibility: scale ? "visible" : "hidden" }} />
          : <div className="flex max-w-sm flex-col items-center justify-center gap-4 px-6 text-center text-sm text-muted" role={error ? "alert" : undefined}>
            <p>{error || (options ? "正在生成真实页面…" : "选择一份简历，开始制作个人主页。")}</p>
            {error && <button type="button" className={btnGhost} onClick={() => setAttempt((value) => value + 1)}>重试预览</button>}
          </div>}
      </div>
    </div>
  );
}
