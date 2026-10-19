import { RESUME_TEMPLATES } from "./template-catalog";
import type { TemplateKey } from "./template-catalog";
import { BUILTIN_STYLES, DEFAULT_STYLE } from "./template-styles";
import type { ResumeStyle } from "./template-styles";

export { RESUME_TEMPLATES } from "./template-catalog";
export type { TemplateKey, TemplateCategory, ResumeTemplateMeta } from "./template-catalog";
export { BUILTIN_STYLES, DEFAULT_STYLE } from "./template-styles";
export type { ResumeStyle } from "./template-styles";

export const TEMPLATE_KEYS = RESUME_TEMPLATES.map((t) => t.key);

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && (TEMPLATE_KEYS as string[]).includes(value);
}

/** 样式工厂保存的自定义模板（resume_templates 表） */
export type CustomTemplate = {
  id: number;
  name: string;
  style: ResumeStyle;
  /** 损坏记录的 style 仅用于修复预览，不能应用或导出。 */
  corrupted?: boolean;
  created_at: string;
  updated_at: string;
};

/** 自定义模板在 resumes.template 列中的引用格式：custom:<id> */
export function customRef(id: number): string {
  return `custom:${id}`;
}

/** 简历模板值合法性：内置 key 或 custom:<id> 引用 */
export function isTemplateRef(value: unknown): value is string {
  if (isTemplateKey(value)) return true;
  return typeof value === "string" && /^custom:\d+$/.test(value);
}

const STYLE_ENUMS = {
  layout: ["single", "twocol"],
  headerStyle: ["default", "banner", "card"],
  font: ["serif", "sans"],
  titleAlign: ["center", "left"],
  titleRule: ["none", "accent", "dark"],
  sectionDeco: ["none", "underline", "leftbar", "band"],
  skillStyle: ["pill", "line", "list"],
  asidePosition: ["left", "right"],
  asideBorder: ["auto", "none", "left", "right", "both"],
  headerLayout: ["right-avatar", "left-avatar", "center-avatar"],
  contactLayout: ["inline", "grid2"],
} as const;

const GENERATED_STYLE_KEYS = [
  "layout", "asideWidth", "pageMargin", "headerStyle", "headerBg", "font", "baseSize", "lineHeight",
  "accent", "ink", "text", "muted", "titleAlign", "nameSize", "nameWeight", "nameTracking",
  "titleRule", "titleRuleThickness", "contactSize", "sectionSize", "sectionWeight", "sectionColor",
  "sectionTracking", "sectionDeco", "sectionDecoColor", "sectionGapBefore", "sectionGapAfter",
  "entryTitleSize", "entryTitleWeight", "entrySubAccent", "entryGap", "descItemGap", "skillStyle",
] as const;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** 把 #RGB 短写展开为 #RRGGBB（type=color 与 8 位 hex 透明度拼接都依赖完整写法） */
function normalizeHex(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim();
  if (!HEX_RE.test(raw)) return fallback;
  if (raw.length === 4) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return raw.toLowerCase();
}

/** 数值钳位：非法输入回退默认值，合法输入限制在 [min, max] 并保留一位小数 */
function num(value: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isEnum<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** AI 样式生成专用的严格校验，避免不完整结果被 normalizeStyle 静默补成默认样式。 */
export function isCompleteGeneratedStyle(input: unknown): input is ResumeStyle {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const o = input as Record<string, unknown>;
  if (GENERATED_STYLE_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(o, key))) return false;

  const weighted = (value: unknown) =>
    isNumberInRange(value, 400, 900) && Number.isInteger(value) && value % 100 === 0;
  const colors = [o.headerBg, o.accent, o.ink, o.text, o.muted, o.sectionColor, o.sectionDecoColor];

  return (
    isEnum(o.layout, STYLE_ENUMS.layout) &&
    isEnum(o.headerStyle, STYLE_ENUMS.headerStyle) &&
    isEnum(o.font, STYLE_ENUMS.font) &&
    isEnum(o.titleAlign, STYLE_ENUMS.titleAlign) &&
    isEnum(o.titleRule, STYLE_ENUMS.titleRule) &&
    isEnum(o.sectionDeco, STYLE_ENUMS.sectionDeco) &&
    isEnum(o.skillStyle, STYLE_ENUMS.skillStyle) &&
    colors.every(isHexColor) &&
    isNumberInRange(o.asideWidth, 30, 100) &&
    isNumberInRange(o.pageMargin, 6, 25) &&
    isNumberInRange(o.baseSize, 9, 14) &&
    isNumberInRange(o.lineHeight, 1.2, 2) &&
    isNumberInRange(o.nameSize, 16, 40) &&
    weighted(o.nameWeight) &&
    isNumberInRange(o.nameTracking, 0, 8) &&
    isNumberInRange(o.titleRuleThickness, 1, 6) &&
    isNumberInRange(o.contactSize, 9, 14) &&
    isNumberInRange(o.sectionSize, 10, 18) &&
    weighted(o.sectionWeight) &&
    isNumberInRange(o.sectionTracking, 0, 8) &&
    isNumberInRange(o.sectionGapBefore, 4, 28) &&
    isNumberInRange(o.sectionGapAfter, 2, 16) &&
    isNumberInRange(o.entryTitleSize, 11, 16) &&
    weighted(o.entryTitleWeight) &&
    typeof o.entrySubAccent === "boolean" &&
    isNumberInRange(o.entryGap, 4, 20) &&
    isNumberInRange(o.descItemGap, 0, 16)
  );
}

/** 校验并钳位样式参数 JSON（AI 生成、API 写入、DB 读取共用）；非对象返回 null。
 *  fallback 作为缺省与非法值的兜底（默认 DEFAULT_STYLE），用于把不完整输入补齐到指定基准。 */
export function normalizeStyle(input: unknown, fallback: ResumeStyle = DEFAULT_STYLE): ResumeStyle | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const d = fallback;
  return {
    layout: pickEnum(o.layout, STYLE_ENUMS.layout, d.layout),
    headerStyle: pickEnum(o.headerStyle, STYLE_ENUMS.headerStyle, d.headerStyle ?? "default"),
    headerBg: normalizeHex(o.headerBg, d.headerBg ?? d.accent),
    asideWidth: num(o.asideWidth, 30, 100, d.asideWidth),
    pageMargin: num(o.pageMargin, 6, 25, d.pageMargin),
    font: pickEnum(o.font, STYLE_ENUMS.font, d.font),
    baseSize: num(o.baseSize, 9, 14, d.baseSize),
    lineHeight: num(o.lineHeight, 1.2, 2, d.lineHeight),
    accent: normalizeHex(o.accent, d.accent),
    ink: normalizeHex(o.ink, d.ink),
    text: normalizeHex(o.text, d.text),
    muted: normalizeHex(o.muted, d.muted),
    titleAlign: pickEnum(o.titleAlign, STYLE_ENUMS.titleAlign, d.titleAlign),
    nameSize: num(o.nameSize, 16, 40, d.nameSize),
    nameWeight: num(o.nameWeight, 400, 900, d.nameWeight),
    nameTracking: num(o.nameTracking, 0, 8, d.nameTracking),
    titleRule: pickEnum(o.titleRule, STYLE_ENUMS.titleRule, d.titleRule),
    titleRuleThickness: num(o.titleRuleThickness, 1, 6, d.titleRuleThickness),
    contactSize: num(o.contactSize, 9, 14, d.contactSize),
    contactSeparator: typeof o.contactSeparator === "string" ? o.contactSeparator : (d.contactSeparator ?? "·"),
    contactGap: num(o.contactGap, 0, 32, d.contactGap ?? 8),
    sectionSize: num(o.sectionSize, 10, 18, d.sectionSize),
    sectionWeight: num(o.sectionWeight, 400, 900, d.sectionWeight),
    sectionColor: normalizeHex(o.sectionColor, d.sectionColor),
    sectionTracking: num(o.sectionTracking, 0, 8, d.sectionTracking),
    sectionDeco: pickEnum(o.sectionDeco, STYLE_ENUMS.sectionDeco, d.sectionDeco),
    sectionDecoColor: normalizeHex(o.sectionDecoColor, d.sectionDecoColor),
    sectionGapBefore: num(o.sectionGapBefore, 4, 28, d.sectionGapBefore),
    sectionGapAfter: num(o.sectionGapAfter, 2, 16, d.sectionGapAfter),
    entryTitleSize: num(o.entryTitleSize, 11, 16, d.entryTitleSize),
    entryTitleWeight: num(o.entryTitleWeight, 400, 900, d.entryTitleWeight),
    entrySubAccent: typeof o.entrySubAccent === "boolean" ? o.entrySubAccent : d.entrySubAccent,
    entryGap: num(o.entryGap, 4, 20, d.entryGap),
    descItemGap: num(o.descItemGap, 0, 16, d.descItemGap ?? 2),
    skillStyle: pickEnum(o.skillStyle, STYLE_ENUMS.skillStyle, d.skillStyle),
    asidePosition: pickEnum(o.asidePosition, STYLE_ENUMS.asidePosition, d.asidePosition ?? "right"),
    asideModules: Array.isArray(o.asideModules)
      ? o.asideModules.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      : d.asideModules,
    asideBg: typeof o.asideBg === "string" ? normalizeHex(o.asideBg, "") || undefined : d.asideBg,
    asideBorder: pickEnum(o.asideBorder, STYLE_ENUMS.asideBorder, d.asideBorder ?? "auto"),
    asideBorderColor: normalizeHex(o.asideBorderColor, d.asideBorderColor ?? "#e2e2e2"),
    asidePadding: num(o.asidePadding, 0, 40, d.asidePadding ?? 16),
    asideGap: num(o.asideGap, 0, 40, d.asideGap ?? 20),
    headerLayout: pickEnum(o.headerLayout, STYLE_ENUMS.headerLayout, d.headerLayout ?? "right-avatar"),
    contactLayout: pickEnum(o.contactLayout, STYLE_ENUMS.contactLayout, d.contactLayout ?? "inline"),
    skillCols: (o.skillCols === 2 || o.skillCols === 3) ? o.skillCols : (o.skillCols === 1 ? 1 : (d.skillCols ?? 1)),
    entryCols: (o.entryCols === 2) ? 2 : (o.entryCols === 1 ? 1 : (d.entryCols ?? 1)),
  };
}

/** 简历级样式覆盖参数：在所选模板预设之上的叠加定制，可覆盖 ResumeStyle 的任意字段
 *  （间距微调、配色、字体、布局装饰等），不污染全局/自定义模板 */
export type ResumeStyleOverrides = Partial<ResumeStyle>;

/** 校验并钳位简历级样式覆盖参数：仅保留输入中显式给出的字段，非法属性忽略、数值钳位；
 *  非法值回退到 fallback（未传则为全局默认样式），返回空对象表示无有效覆盖 */
export function sanitizeStyleOverrides(input: unknown, fallback?: ResumeStyle): ResumeStyleOverrides {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const o = input as Record<string, unknown>;
  const base = fallback ?? DEFAULT_STYLE;
  // 以 base 补齐后整表归一化，再只取回输入里出现过的字段，保证叠加语义（base 之外不引入默认值）
  const full = normalizeStyle({ ...base, ...o }, base);
  if (!full) return {};
  const res: ResumeStyleOverrides = {};
  for (const key of Object.keys(o)) {
    if (key in full) {
      (res as Record<string, unknown>)[key] = (full as Record<string, unknown>)[key];
    }
  }
  return res;
}

/** 按模板引用解析样式：内置 key 取预设，custom:<id> 查自定义列表，失效回退经典；若有 overrides 则叠加上层覆盖 */
export function resolveStyle(
  ref: string,
  customs: CustomTemplate[],
  overrides?: ResumeStyleOverrides | null,
): ResumeStyle {
  let base: ResumeStyle = BUILTIN_STYLES.classic;
  if (isTemplateKey(ref)) {
    base = BUILTIN_STYLES[ref];
  } else {
    const m = /^custom:(\d+)$/.exec(ref);
    const found = m ? customs.find((c) => c.id === Number(m[1])) : undefined;
    if (found) base = found.style;
  }
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const clean = sanitizeStyleOverrides(overrides, base);
  return { ...base, ...clean };
}
