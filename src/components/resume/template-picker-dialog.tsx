"use client";

import { useId, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  BUILTIN_STYLES,
  customRef,
  type CustomTemplate,
  type ResumeStyle,
} from "@/lib/templates";
import {
  CATEGORY_TABS,
  DEFAULT_ACCENT,
  categoryCount,
  filterBuiltins,
  filterCustoms,
  templateSummary,
  type CategoryTab,
} from "@/lib/template-browser";
import { TemplateThumbnail } from "./template-thumbnail";
import { useModalFocus } from "@/hooks/use-modal-focus";

function TemplateCard({
  title,
  badge,
  description,
  tags,
  style,
  accentColor,
  selected,
  onSelect,
  disabled = false,
}: {
  title: string;
  badge?: string;
  description: string;
  tags?: string[];
  style: ResumeStyle;
  accentColor: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      onClick={() => { if (!disabled) onSelect(); }}
      role="button"
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group relative flex ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"} flex-col rounded-xl border p-3 transition-all ${
        selected
          ? "border-primary bg-primary/5 ring-2 ring-primary/40 shadow-md"
          : "border-line bg-card hover:border-primary/50 hover:shadow-md"
      }`}
    >
      {selected && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-white shadow">
          <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          当前应用
        </div>
      )}

      <div className="transition-transform group-hover:scale-[1.02]">
        <TemplateThumbnail style={style} accentColor={accentColor} />
      </div>

      <div className="mt-3 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-ink group-hover:text-primary">{title}</h3>
          {badge ? (
            <span className="rounded bg-primary-soft px-1 text-[10px] font-medium text-primary">
              {badge}
            </span>
          ) : (
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: accentColor }} />
          )}
        </div>

        <p className="line-clamp-2 text-xs text-muted">{description}</p>

        {tags && tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span key={tag} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-faint">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 模板选择弹窗（参照 JadeAI 的全屏磨砂玻璃模态）。
 *
 * 从 template-picker.tsx 拆出来：选择器本身只负责「触发按钮 + 当前模板摘要」，
 * 而弹窗自带一套互不相干的状态（渐隐对比、分类页签、搜索词、焦点围栏），
 * 两者挤在一个组件里时，读触发按钮的逻辑得先翻过整个弹窗的 JSX。
 *
 * 挂载到 document.body 而非就地渲染：层级取 z-[9999]，避免被父级 stacking
 * context 穿透遮挡（编辑器侧栏、打印预览容器都建立过自己的层叠上下文）。
 */
const emptySubscribe = () => () => {};

export function TemplatePickerDialog({
  value,
  customs,
  onChange,
  onClose,
}: {
  value: string;
  customs: CustomTemplate[];
  onChange: (ref: string) => void;
  onClose: () => void;
}) {
  const [isFaded, setIsFaded] = useState(false);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const titleId = useId();

  // Portal 只能在客户端渲染，服务端首帧必须与客户端一致，否则 hydration 报错
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

  const close = () => {
    setIsFaded(false);
    onClose();
  };

  const modalRef = useModalFocus(true, close);

  const currentMeta = useMemo(() => templateSummary(value, customs), [value, customs]);
  const builtins = useMemo(
    () => filterBuiltins(activeCategory, searchQuery),
    [activeCategory, searchQuery]
  );
  const customItems = useMemo(
    () => filterCustoms(activeCategory, searchQuery, customs),
    [activeCategory, searchQuery, customs]
  );

  if (!isClient) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-5 md:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      {/* 毛玻璃背景遮罩：移出时几乎完全透明化，让底层简历一览无余 */}
      <div
        className={`fixed inset-0 transition-all duration-300 ${
          isFaded ? "bg-black/5 backdrop-blur-none" : "bg-black/50 backdrop-blur-md"
        }`}
        onClick={close}
        aria-hidden="true"
      />

      {/* 渐隐对比状态下的全不透明浮动提示徽标（居中显示在弹窗中心位置，静态常驻，不闪烁） */}
      {isFaded && (
        <div className="pointer-events-none fixed inset-0 z-[10000] flex items-center justify-center p-4">
          <div className="flex items-center gap-2.5 rounded-2xl border border-line/80 bg-card/95 px-5 py-3 text-sm font-semibold text-ink shadow-2xl backdrop-blur-xl">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
            <span>✨ 鼠标移回弹窗区域即可继续挑选模板</span>
          </div>
        </div>
      )}

      {/* 弹窗主体面板：鼠标移出时平滑渐隐至 15% 透明度，移回时瞬间平滑恢复 100% */}
      <div
        ref={modalRef}
        onMouseEnter={() => setIsFaded(false)}
        onMouseLeave={() => setIsFaded(true)}
        className={`relative flex max-h-[90vh] w-full max-w-5xl flex-col rounded-2xl border border-line/80 bg-card/95 backdrop-blur-2xl transition-all duration-300 ease-out dark:border-neutral-700/60 dark:bg-neutral-900/95 ${
          isFaded
            ? "opacity-15 scale-[0.985] shadow-md pointer-events-auto cursor-pointer"
            : "opacity-100 scale-100 shadow-2xl"
        }`}
      >
        {/* 弹窗头部 */}
        <div className="flex items-start justify-between border-b border-line px-5 py-4 sm:px-6">
          <div>
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="text-lg font-bold text-ink">
                选择简历模板
              </h2>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                16 款精选款式
              </span>
              <span className="hidden sm:inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-[10px] text-faint">
                <span>💡 鼠标移出弹窗自动渐隐对比底层效果</span>
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              参考行业顶尖求职标准精细设计，点击即可即时切换，移出弹窗可直观查看整页简历效果。
            </p>
          </div>

          <button
            type="button"
            onClick={close}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink focus:outline-none"
            aria-label="关闭"
          >
            <span className="text-xl leading-none">×</span>
          </button>
        </div>

        {/* 搜索与分类导航栏 */}
        <div className="flex flex-col gap-3 border-b border-line bg-surface/40 px-5 py-3 sm:px-6">
          {/* 搜索输入框 */}
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索模板名称、风格或关键词（如：极客、双栏、学术、紧凑）..."
              className="w-full rounded-xl border border-line bg-card px-3 py-1.5 pl-8 text-xs text-ink outline-none transition-colors focus:border-primary"
            />
            <svg
              className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-2 text-xs text-muted hover:text-ink"
              >
                清空
              </button>
            )}
          </div>

          {/* 分类切换 Tab 药丸 */}
          <div className="flex flex-wrap gap-1.5 overflow-x-auto pb-1 text-xs">
            {CATEGORY_TABS.map((tab) => {
              const isActive = activeCategory === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveCategory(tab.id)}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-primary text-white shadow-sm"
                      : "border border-line/80 bg-card text-muted hover:bg-surface hover:text-ink"
                  }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`rounded-full px-1.5 text-[10px] ${
                      isActive ? "bg-white/20 text-white" : "bg-surface text-faint"
                    }`}
                  >
                    {categoryCount(tab.id, customs)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 模板展示网格列表 */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6">
          {builtins.length === 0 && customItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm font-medium text-muted">未找到匹配的模板</p>
              <p className="mt-1 text-xs text-faint">
                尝试换个搜索词，或在上方分类中选择“全部模板”
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {builtins.map((tpl) => (
                <TemplateCard
                  key={tpl.key}
                  title={tpl.label}
                  description={tpl.desc}
                  tags={tpl.tags}
                  style={BUILTIN_STYLES[tpl.key]}
                  accentColor={tpl.previewColor}
                  selected={value === tpl.key}
                  onSelect={() => onChange(tpl.key)}
                />
              ))}

              {customItems.map((custom) => {
                const ref = customRef(custom.id);
                return (
                  <TemplateCard
                    key={custom.id}
                    title={custom.name}
                    badge={custom.corrupted ? "已损坏" : "我的模板"}
                    description={custom.corrupted ? "模板数据损坏，请到样式工厂修复后使用" : "样式工厂保存的专属自定义配置"}
                    disabled={custom.corrupted}
                    style={custom.style}
                    accentColor={custom.style.accent || DEFAULT_ACCENT}
                    selected={value === ref}
                    onSelect={() => onChange(ref)}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* 弹窗底栏 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/60 px-5 py-3 sm:px-6">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-faint">当前应用模板：</span>
            <span className="font-semibold text-ink">{currentMeta.label}</span>
            {currentMeta.isCustom && (
              <span className="rounded bg-primary-soft px-1 text-[10px] text-primary">自定义</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden sm:inline text-[11px] text-faint">移出弹窗即隐 · 移回即显</span>
            <Link
              href="/styles"
              className="rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface"
            >
              去样式工厂深度定制 →
            </Link>
            <button
              type="button"
              onClick={close}
              className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            >
              完成
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
