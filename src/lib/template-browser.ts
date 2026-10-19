import {
  RESUME_TEMPLATES,
  type CustomTemplate,
  type ResumeTemplateMeta,
  type TemplateCategory,
} from "./templates";

/**
 * 模板选择器的纯逻辑：分类页签、当前选中项摘要、按分类与关键词过滤。
 *
 * 与 template-picker.tsx 分开，让筛选规则无需 DOM 即可独立验证；
 * 组件交互另由 jsdom / testing-library 覆盖。
 * 纯函数直接断言：分类切到「我的模板」时内置模板必须清空、
 * 搜索词大小写不敏感、坏掉的 custom 引用要退回兜底文案。
 */

export type CategoryTab = TemplateCategory | "custom";

export const CATEGORY_TABS: { id: CategoryTab; label: string }[] = [
  { id: "all", label: "全部模板" },
  { id: "banner", label: "🎨 顶部色块" },
  { id: "general", label: "通用经典" },
  { id: "tech", label: "技术研发" },
  { id: "minimal", label: "极简无饰" },
  { id: "academic", label: "学术科研" },
  { id: "compact", label: "高密紧凑" },
  { id: "executive", label: "商务精英" },
  { id: "creative", label: "活力创意" },
  { id: "custom", label: "我的模板" },
];

export type TemplateSummary = {
  label: string;
  desc: string;
  color: string;
  isCustom: boolean;
};

/** 自定义模板未设强调色时的默认色，与样式工厂一致 */
export const DEFAULT_ACCENT = "#2563eb";

/** 页签角标：显示该分类下的模板数量 */
export function categoryCount(tab: CategoryTab, customs: CustomTemplate[]): number {
  if (tab === "all") return RESUME_TEMPLATES.length + customs.length;
  if (tab === "custom") return customs.length;
  return RESUME_TEMPLATES.filter((tpl) => tpl.category === tab).length;
}

/**
 * 当前选中模板的摘要，用于触发按钮与底栏。
 * `custom:<id>` 指向的模板已被删除时退回「自定义/未知」而不是崩溃或空白。
 */
export function templateSummary(value: string, customs: CustomTemplate[]): TemplateSummary {
  const builtin = RESUME_TEMPLATES.find((tpl) => tpl.key === value);
  if (builtin) {
    return { label: builtin.label, desc: builtin.desc, color: builtin.previewColor, isCustom: false };
  }
  const matched = /^custom:(\d+)$/.exec(value);
  if (matched) {
    const custom = customs.find((c) => c.id === Number(matched[1]));
    if (custom) {
      return {
        label: custom.corrupted ? `${custom.name}（已损坏）` : custom.name,
        desc: custom.corrupted ? "模板数据损坏，请到样式工厂修复" : "我的自定义模板",
        color: custom.style.accent || DEFAULT_ACCENT,
        isCustom: true,
      };
    }
  }
  return { label: "自定义/未知", desc: "已指定特定样式", color: "#6b7280", isCustom: false };
}

/** 内置模板过滤：分类 + 关键词（命中名称、描述或标签任一即可） */
export function filterBuiltins(
  category: CategoryTab,
  searchQuery: string
): ResumeTemplateMeta[] {
  if (category === "custom") return [];
  const query = searchQuery.toLowerCase().trim();
  return RESUME_TEMPLATES.filter((tpl) => {
    if (category !== "all" && tpl.category !== category) return false;
    if (!query) return true;
    return (
      tpl.label.toLowerCase().includes(query) ||
      tpl.desc.toLowerCase().includes(query) ||
      tpl.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  });
}

/**
 * 自定义模板过滤：只在「全部」与「我的模板」两个页签下出现，
 * 其余分类是内置模板的维度，混进自定义模板会让分类失去意义。
 */
export function filterCustoms(
  category: CategoryTab,
  searchQuery: string,
  customs: CustomTemplate[]
): CustomTemplate[] {
  if (category !== "all" && category !== "custom") return [];
  const query = searchQuery.toLowerCase().trim();
  if (!query) return customs;
  return customs.filter((custom) => custom.name.toLowerCase().includes(query));
}
