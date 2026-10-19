"use client";

import { prepare, ResumeDoc } from "@/components/resume/doc";
import { useStylePreview, useTemplateLibrary } from "@/hooks/use-template-library";
import { SAMPLE_MODULES } from "./sample-modules";
import { StyleInspector } from "./style-inspector";
import { BackToTop } from "@/components/common/back-to-top";

export default function StyleFactoryPage() {
  const library = useTemplateLibrary();
  const { draft } = library;
  const { previewRef, paperRef, scale, paperHeight, mobileTab, setMobileTab } = useStylePreview(draft);

  return (
    <div className="mx-auto max-w-[1600px] space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            简历样式工厂
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            像设计专业排版一样定制简历：布局、配色到每个元素的字号、字重与边距全部可调；也可通过自然语言交由 AI 智能生成。
          </p>
        </div>
      </div>

      <div className="lg:hidden sticky top-14 z-20 -mx-4 px-4 py-2 bg-bg/95 backdrop-blur border-b border-line mb-4 mt-6">
        <div className="flex rounded-xl bg-surface p-1 border border-line">
          <button
            type="button"
            onClick={() => setMobileTab("inspector")}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors min-h-[38px] ${
              mobileTab === "inspector"
                ? "bg-card text-ink shadow-xs font-semibold"
                : "text-muted hover:text-ink"
            }`}
          >
            ⚙️ 调节样式
          </button>
          <button
            type="button"
            onClick={() => setMobileTab("preview")}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors min-h-[38px] ${
              mobileTab === "preview"
                ? "bg-card text-ink shadow-xs font-semibold"
                : "text-muted hover:text-ink"
            }`}
          >
            👁️ 实时预览
          </button>
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div
          className={`lg:sticky lg:top-20 lg:self-start space-y-3 ${
            mobileTab === "preview" ? "block" : "hidden lg:block"
          }`}
        >
          <div className="flex items-center justify-between text-xs text-muted px-1">
            <span>A4 纸张排版预览（基于完整六模块样例数据）</span>
            <span className="font-mono text-[11px] text-faint">794px 等比缩放</span>
          </div>

          <div
            ref={previewRef}
            className="w-full rounded-2xl border border-line/80 bg-surface/50 p-4 shadow-inner overflow-hidden flex justify-center"
            style={{ minHeight: paperHeight * scale + 32 }}
          >
            <div style={{ transform: `scale(${scale})`, transformOrigin: "top center", width: 794 }}>
              <div
                ref={paperRef}
                className="paper min-h-[297mm] w-[210mm] bg-white text-black shadow-card-float rounded-[2px]"
              >
                <ResumeDoc prepared={prepare("样例简历", SAMPLE_MODULES)} style={draft} />
              </div>
            </div>
          </div>
        </div>

        <StyleInspector
          controller={library}
          className={mobileTab === "inspector" ? "block" : "hidden lg:block"}
        />
      </div>

      <BackToTop />
    </div>
  );
}
