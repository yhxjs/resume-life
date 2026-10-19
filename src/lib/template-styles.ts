import { bannerStyles } from "./template-banner-styles";
import type { TemplateKey } from "./template-catalog";

/**
 * 简历样式参数（深度定制）：从页面布局到每个元素的字号/字重/颜色/间距全部可调，
 * 内置模板与样式工厂保存的自定义模板共用同一套渲染参数。
 * 长度单位：px（文字/间距）与 mm（页面边距/侧栏宽）；颜色一律 #RRGGBB。
 */
export type ResumeStyle = {
  /** single 单栏 / twocol 双栏（技能/文本/联系方式进侧栏） */
  layout: "single" | "twocol";
  /** 双栏侧栏宽度（mm） */
  asideWidth: number;
  /** 页面四边内边距（mm） */
  pageMargin: number;

  /** 页眉样式：default 普通纯文本 / banner 顶部色块通栏横幅 / card 悬浮圆角色块卡片 */
  headerStyle?: "default" | "banner" | "card";
  /** 顶部色块背景色（默认使用 accent） */
  headerBg?: string;

  /** serif 宋体（稳重传统）/ sans 黑体（现代简洁），全局字体族 */
  font: "serif" | "sans";
  /** 正文基准字号（px），条目正文/自我评价/技能等继承 */
  baseSize: number;
  /** 正文行高（倍） */
  lineHeight: number;
  /** 强调色：技能标签、副标题（可选）、标题分隔线（accent 模式） */
  accent: string;
  /** 主标题色：姓名、条目主标题 */
  ink: string;
  /** 正文色：条目正文、自我评价 */
  text: string;
  /** 次要信息色：联系方式、时间段、副标题（非强调时） */
  muted: string;

  /** 姓名字号（px） */
  nameSize: number;
  /** 姓名字重（400-900） */
  nameWeight: number;
  /** 姓名对齐 */
  titleAlign: "center" | "left";
  /** 姓名字距（px） */
  nameTracking: number;
  /** 姓名下方分隔线：none 无 / accent 强调色 / dark 深灰 */
  titleRule: "none" | "accent" | "dark";
  /** 分隔线粗细（px） */
  titleRuleThickness: number;
  /** 联系方式字号（px） */
  contactSize: number;
  /** 其他基本信息间隔符（可为空字符串，默认 "·"） */
  contactSeparator?: string;
  /** 其他基本信息项之间的间距（px，默认 8） */
  contactGap?: number;

  /** 小节标题字号（px） */
  sectionSize: number;
  /** 小节标题字重（400-900） */
  sectionWeight: number;
  /** 小节标题文字色 */
  sectionColor: string;
  /** 小节标题字距（px） */
  sectionTracking: number;
  /** 小节标题装饰：none 纯文字 / underline 下划线 / leftbar 左色条 / band 色块 */
  sectionDeco: "none" | "underline" | "leftbar" | "band";
  /** 装饰色（下划线/左色条/色块） */
  sectionDecoColor: string;
  /** 小节标题与上方内容的间距（px） */
  sectionGapBefore: number;
  /** 小节标题与下方内容的间距（px） */
  sectionGapAfter: number;

  /** 条目主标题字号（px） */
  entryTitleSize: number;
  /** 条目主标题字重（400-900） */
  entryTitleWeight: number;
  /** 条目副标题（职位/学位）是否用强调色（否则用次要色） */
  entrySubAccent: boolean;
  /** 条目之间的间距（px） */
  entryGap: number;
  /** 项目描述/工作内容多行条目以及技能列表各项之间的间距（px） */
  descItemGap?: number;

  /** 技能展示：pill 圆角标签 / line 一行文字 / list 列表 */
  skillStyle: "pill" | "line" | "list";

  /** 双栏侧栏位置，默认为 right。 */
  asidePosition?: "left" | "right";
  /** 侧栏模块分流：指定放入侧栏的 moduleKey 或 moduleType 数组；缺省时回退至现有自动规则（非 entries 模块进侧栏） */
  asideModules?: string[];
  /** 侧栏背景底色（6位 Hex，缺省为透明） */
  asideBg?: string;
  /** 侧栏边框分隔：auto（根据位置自动选靠内侧的一侧）/ none（无边框）/ left / right / both */
  asideBorder?: "auto" | "none" | "left" | "right" | "both";
  /** 侧栏边框颜色（默认 "#e2e2e2"） */
  asideBorderColor?: string;
  /** 侧栏内边距（px，默认 16） */
  asidePadding?: number;
  /** 主侧栏间距（px，默认 20） */
  asideGap?: number;

  /** 头像排布形式（针对普通文本页眉等）：right-avatar 靠右 / left-avatar 靠左 / center-avatar 文档流居中 */
  headerLayout?: "right-avatar" | "left-avatar" | "center-avatar";
  /** 联系方式排布形式：inline 行内流式 / grid2 双列等宽紧凑网格 */
  contactLayout?: "inline" | "grid2";
  /** 技能列数：1 列表/自适应流式 / 2 双列网格 / 3 三列网格 */
  skillCols?: 1 | 2 | 3;
  /** 经历条目列数：1 单列 / 2 双列网格 */
  entryCols?: 1 | 2;
};

/** 归一化兜底用的默认样式（现代简约基调） */
export const DEFAULT_STYLE: ResumeStyle = {
  layout: "single",
  asideWidth: 88,
  pageMargin: 13,
  headerStyle: "default",
  headerBg: "#2563eb",
  font: "sans",
  baseSize: 12,
  lineHeight: 1.55,
  accent: "#2563eb",
  ink: "#111111",
  text: "#404040",
  muted: "#737373",
  titleAlign: "left",
  nameSize: 24,
  nameWeight: 800,
  nameTracking: 0,
  titleRule: "accent",
  titleRuleThickness: 2,
  contactSize: 11.5,
  contactSeparator: "·",
  contactGap: 8,
  sectionSize: 13,
  sectionWeight: 700,
  sectionColor: "#2563eb",
  sectionTracking: 0,
  sectionDeco: "leftbar",
  sectionDecoColor: "#2563eb",
  sectionGapBefore: 12,
  sectionGapAfter: 6,
  entryTitleSize: 13,
  entryTitleWeight: 700,
  entrySubAccent: true,
  entryGap: 10,
  descItemGap: 2,
  skillStyle: "pill",
  asidePosition: "right",
  asideBorder: "auto",
  asideBorderColor: "#e2e2e2",
  asidePadding: 16,
  asideGap: 20,
  headerLayout: "right-avatar",
  contactLayout: "inline",
  skillCols: 1,
  entryCols: 1,
};

/** 内置各套模板的样式预设，渲染层统一以此参数驱动 */
export const BUILTIN_STYLES: Record<TemplateKey, ResumeStyle> = {
  classic: {
    ...DEFAULT_STYLE,
    pageMargin: 12,
    font: "serif",
    accent: "#262626",
    ink: "#111111",
    titleAlign: "center",
    nameSize: 22,
    nameWeight: 700,
    nameTracking: 1,
    titleRule: "none",
    contactSize: 11.5,
    sectionColor: "#262626",
    sectionTracking: 4,
    sectionDeco: "underline",
    sectionDecoColor: "#262626",
    sectionGapBefore: 12,
    entrySubAccent: false,
    skillStyle: "line",
  },
  modern: { ...DEFAULT_STYLE, pageMargin: 12 },
  twocol: {
    ...DEFAULT_STYLE,
    layout: "twocol",
    pageMargin: 12,
    accent: "#2563eb",
    titleAlign: "left",
    nameSize: 22,
    nameWeight: 700,
    titleRule: "dark",
    contactSize: 11,
    sectionColor: "#2563eb",
    sectionDeco: "none",
    sectionGapBefore: 8,
    entrySubAccent: false,
    skillStyle: "list",
  },
  tech: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 11,
    font: "sans",
    baseSize: 11.5,
    lineHeight: 1.5,
    accent: "#0284c7",
    ink: "#0f172a",
    text: "#334155",
    muted: "#64748b",
    titleAlign: "left",
    nameSize: 23,
    nameWeight: 800,
    nameTracking: 0,
    titleRule: "accent",
    titleRuleThickness: 2,
    contactSize: 11,
    sectionSize: 13,
    sectionWeight: 700,
    sectionColor: "#0284c7",
    sectionTracking: 0,
    sectionDeco: "leftbar",
    sectionDecoColor: "#0284c7",
    sectionGapBefore: 11,
    sectionGapAfter: 5,
    entryTitleSize: 13,
    entryTitleWeight: 700,
    entrySubAccent: true,
    entryGap: 9,
    skillStyle: "pill",
  },
  minimal: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 13,
    font: "sans",
    baseSize: 12,
    lineHeight: 1.6,
    accent: "#171717",
    ink: "#000000",
    text: "#404040",
    muted: "#737373",
    titleAlign: "left",
    nameSize: 22,
    nameWeight: 700,
    nameTracking: 0,
    titleRule: "none",
    titleRuleThickness: 1,
    contactSize: 11,
    sectionSize: 12.5,
    sectionWeight: 700,
    sectionColor: "#171717",
    sectionTracking: 1,
    sectionDeco: "none",
    sectionDecoColor: "#e5e5e5",
    sectionGapBefore: 14,
    sectionGapAfter: 6,
    entryTitleSize: 12.5,
    entryTitleWeight: 600,
    entrySubAccent: false,
    entryGap: 10,
    skillStyle: "line",
  },
  academic: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 13,
    font: "serif",
    baseSize: 12,
    lineHeight: 1.55,
    accent: "#1e3a8a",
    ink: "#172554",
    text: "#334155",
    muted: "#64748b",
    titleAlign: "center",
    nameSize: 22,
    nameWeight: 700,
    nameTracking: 1,
    titleRule: "dark",
    titleRuleThickness: 1,
    contactSize: 11,
    sectionSize: 13,
    sectionWeight: 700,
    sectionColor: "#1e3a8a",
    sectionTracking: 2,
    sectionDeco: "underline",
    sectionDecoColor: "#93c5fd",
    sectionGapBefore: 12,
    sectionGapAfter: 6,
    entryTitleSize: 13,
    entryTitleWeight: 700,
    entrySubAccent: false,
    entryGap: 10,
    skillStyle: "line",
  },
  compact: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 9,
    font: "sans",
    baseSize: 11,
    lineHeight: 1.42,
    accent: "#334155",
    ink: "#0f172a",
    text: "#334155",
    muted: "#64748b",
    titleAlign: "left",
    nameSize: 20,
    nameWeight: 800,
    nameTracking: 0,
    titleRule: "accent",
    titleRuleThickness: 1.5,
    contactSize: 10.5,
    sectionSize: 12,
    sectionWeight: 700,
    sectionColor: "#1e293b",
    sectionTracking: 0,
    sectionDeco: "leftbar",
    sectionDecoColor: "#475569",
    sectionGapBefore: 8,
    sectionGapAfter: 4,
    entryTitleSize: 12,
    entryTitleWeight: 700,
    entrySubAccent: true,
    entryGap: 7,
    skillStyle: "pill",
  },
  executive: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 12,
    font: "sans",
    baseSize: 12,
    lineHeight: 1.55,
    accent: "#0f172a",
    ink: "#020617",
    text: "#334155",
    muted: "#64748b",
    titleAlign: "left",
    nameSize: 24,
    nameWeight: 800,
    nameTracking: 0.5,
    titleRule: "dark",
    titleRuleThickness: 2,
    contactSize: 11,
    sectionSize: 13,
    sectionWeight: 700,
    sectionColor: "#0f172a",
    sectionTracking: 1,
    sectionDeco: "band",
    sectionDecoColor: "#1e293b",
    sectionGapBefore: 13,
    sectionGapAfter: 6,
    entryTitleSize: 13,
    entryTitleWeight: 700,
    entrySubAccent: false,
    entryGap: 10,
    skillStyle: "pill",
  },
  ats: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 12,
    font: "sans",
    baseSize: 11.5,
    lineHeight: 1.5,
    accent: "#1f2937",
    ink: "#111827",
    text: "#374151",
    muted: "#6b7280",
    titleAlign: "left",
    nameSize: 22,
    nameWeight: 700,
    nameTracking: 0,
    titleRule: "none",
    contactSize: 11,
    sectionSize: 13,
    sectionWeight: 700,
    sectionColor: "#111827",
    sectionTracking: 1,
    sectionDeco: "underline",
    sectionDecoColor: "#9ca3af",
    sectionGapBefore: 11,
    sectionGapAfter: 5,
    entryTitleSize: 12.5,
    entryTitleWeight: 700,
    entrySubAccent: false,
    entryGap: 9,
    skillStyle: "line",
  },
  creative: {
    ...DEFAULT_STYLE,
    layout: "single",
    pageMargin: 12,
    font: "sans",
    baseSize: 12,
    lineHeight: 1.55,
    accent: "#7c3aed",
    ink: "#1e1b4b",
    text: "#374151",
    muted: "#6b7280",
    titleAlign: "left",
    nameSize: 24,
    nameWeight: 800,
    nameTracking: 0,
    titleRule: "accent",
    titleRuleThickness: 2,
    contactSize: 11,
    sectionSize: 13,
    sectionWeight: 700,
    sectionColor: "#7c3aed",
    sectionTracking: 0.5,
    sectionDeco: "leftbar",
    sectionDecoColor: "#a78bfa",
    sectionGapBefore: 12,
    sectionGapAfter: 6,
    entryTitleSize: 13,
    entryTitleWeight: 700,
    entrySubAccent: true,
    entryGap: 10,
    skillStyle: "pill",
  },
  twocol_card: {
    ...DEFAULT_STYLE,
    layout: "twocol",
    asideWidth: 84,
    pageMargin: 11,
    font: "sans",
    baseSize: 11.5,
    lineHeight: 1.5,
    accent: "#059669",
    ink: "#064e3b",
    text: "#334155",
    muted: "#64748b",
    titleAlign: "left",
    nameSize: 22,
    nameWeight: 700,
    nameTracking: 0,
    titleRule: "accent",
    titleRuleThickness: 2,
    contactSize: 11,
    sectionSize: 12.5,
    sectionWeight: 700,
    sectionColor: "#059669",
    sectionTracking: 0,
    sectionDeco: "none",
    sectionDecoColor: "#059669",
    sectionGapBefore: 8,
    sectionGapAfter: 4,
    entryTitleSize: 12.5,
    entryTitleWeight: 700,
    entrySubAccent: true,
    entryGap: 8,
    skillStyle: "pill",
  },
  ...bannerStyles(DEFAULT_STYLE),
};

