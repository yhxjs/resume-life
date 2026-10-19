import { describe, expect, it } from "vitest";
import {
  CATEGORY_TABS,
  DEFAULT_ACCENT,
  categoryCount,
  filterBuiltins,
  filterCustoms,
  templateSummary,
} from "../template-browser";
import { BUILTIN_STYLES, RESUME_TEMPLATES, type CustomTemplate } from "../templates";

/**
 * 模板选择器的筛选与摘要逻辑。
 *
 * 这些判断此前长在 template-picker.tsx 的组件体内，而本仓库的测试环境是 node
 * （没装 jsdom / testing-library），组件渲染不出来，于是分支只能靠肉眼点。
 * 拆成纯函数后，下面每条断言都对应一个真实会出错的场景。
 */
const custom = (id: number, name: string, accent = "#2563eb"): CustomTemplate =>
  ({
    id,
    name,
    style: { ...BUILTIN_STYLES.classic, accent },
  }) as CustomTemplate;

describe("templateSummary", () => {
  it("内置模板取元数据里的名称、描述与预览色", () => {
    const meta = RESUME_TEMPLATES[0]!;
    expect(templateSummary(meta.key, [])).toEqual({
      label: meta.label,
      desc: meta.desc,
      color: meta.previewColor,
      isCustom: false,
    });
  });

  it("custom:<id> 命中自定义模板时标记为自定义并取其强调色", () => {
    const summary = templateSummary("custom:7", [custom(7, "极简深蓝", "#123456")]);
    expect(summary).toEqual({
      label: "极简深蓝",
      desc: "我的自定义模板",
      color: "#123456",
      isCustom: true,
    });
  });

  it("自定义模板强调色为空串时退回默认蓝，而不是渲染出空背景", () => {
    expect(templateSummary("custom:7", [custom(7, "无强调色", "")]).color).toBe(DEFAULT_ACCENT);
  });

  it("custom:<id> 指向已删除的模板时退回兜底文案", () => {
    // 用户在样式工厂删掉模板后，仍停在旧简历上时就会走到这里
    expect(templateSummary("custom:99", [custom(7, "还在的模板")])).toEqual({
      label: "自定义/未知",
      desc: "已指定特定样式",
      color: "#6b7280",
      isCustom: false,
    });
  });

  it("非法引用值同样兜底，不抛错", () => {
    for (const value of ["", "custom:", "custom:abc", "custom:-1", "不存在的键"]) {
      expect(templateSummary(value, []).label).toBe("自定义/未知");
    }
  });
});

describe("categoryCount", () => {
  it("「全部模板」把内置与自定义相加", () => {
    expect(categoryCount("all", [custom(1, "a"), custom(2, "b")])).toBe(
      RESUME_TEMPLATES.length + 2
    );
  });

  it("「我的模板」只数自定义", () => {
    expect(categoryCount("custom", [custom(1, "a")])).toBe(1);
  });

  it("其余分类数该分类下的内置模板", () => {
    for (const tab of CATEGORY_TABS) {
      if (tab.id === "all" || tab.id === "custom") continue;
      expect(categoryCount(tab.id, [custom(1, "a")])).toBe(
        RESUME_TEMPLATES.filter((tpl) => tpl.category === tab.id).length
      );
    }
  });

  it("每个分类页签都有模板可展示，不会点进去是一片空白", () => {
    for (const tab of CATEGORY_TABS) {
      if (tab.id === "custom") continue;
      expect(categoryCount(tab.id, []), `分类 ${tab.id} 为空`).toBeGreaterThan(0);
    }
  });
});

describe("filterBuiltins", () => {
  it("切到「我的模板」时内置模板必须清空", () => {
    expect(filterBuiltins("custom", "")).toEqual([]);
  });

  it("「全部模板」返回全部内置模板", () => {
    expect(filterBuiltins("all", "")).toHaveLength(RESUME_TEMPLATES.length);
  });

  it("分类过滤只保留该分类", () => {
    for (const tpl of filterBuiltins("tech", "")) expect(tpl.category).toBe("tech");
  });

  it("搜索命中名称、描述或标签任一即可", () => {
    const target = RESUME_TEMPLATES.find((tpl) => tpl.tags.length > 0)!;
    const tag = target.tags[0]!;
    expect(filterBuiltins("all", tag).map((tpl) => tpl.key)).toContain(target.key);
  });

  it("搜索大小写不敏感且忽略首尾空白", () => {
    const label = RESUME_TEMPLATES[0]!.label;
    const baseline = filterBuiltins("all", label).map((tpl) => tpl.key);
    expect(filterBuiltins("all", `  ${label.toUpperCase()}  `).map((tpl) => tpl.key)).toEqual(baseline);
  });

  it("分类与搜索同时生效（取交集，不是并集）", () => {
    const found = filterBuiltins("tech", "zzz-绝不匹配-zzz");
    expect(found).toEqual([]);
  });

  it("每个内置模板的样式表都存在，不会渲染时取到 undefined", () => {
    for (const tpl of RESUME_TEMPLATES) {
      expect(BUILTIN_STYLES[tpl.key], `模板 ${tpl.key} 缺少样式`).toBeDefined();
    }
  });
});

describe("filterCustoms", () => {
  const items = [custom(1, "极简深蓝"), custom(2, "Geek Dark")];

  it("只在「全部」与「我的模板」页签下出现", () => {
    expect(filterCustoms("all", "", items)).toHaveLength(2);
    expect(filterCustoms("custom", "", items)).toHaveLength(2);
    for (const tab of CATEGORY_TABS) {
      if (tab.id === "all" || tab.id === "custom") continue;
      expect(filterCustoms(tab.id, "", items), `分类 ${tab.id} 不该出现自定义模板`).toEqual([]);
    }
  });

  it("按名称搜索，大小写不敏感", () => {
    expect(filterCustoms("custom", "geek", items).map((c) => c.id)).toEqual([2]);
    expect(filterCustoms("custom", "极简", items).map((c) => c.id)).toEqual([1]);
  });

  it("搜不到时返回空数组而不是全部", () => {
    expect(filterCustoms("custom", "不存在的名字", items)).toEqual([]);
  });
});
