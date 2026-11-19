// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { ResumeDoc, prepare } from "../doc";
import { DEFAULT_STYLE, SKILL_PILL_ALPHA_HEX } from "@/lib/template-styles";
import { isCompleteGeneratedStyle } from "@/lib/templates";
import type { ModuleData } from "@/lib/modules";

describe("ResumeDoc Layout and Grid Features", () => {
  afterEach(cleanup);

  const mockModules: ModuleData[] = [
    {
      key: "basic_1",
      type: "basic",
      label: "基本信息",
      sort: 0,
      content: {
        name: "李四",
        title: "前端工程师",
        phone: "139-0000-0000",
        email: "lisi@example.com",
      },
    },
    {
      key: "education_1",
      type: "education",
      label: "教育经历",
      sort: 1,
      content: [
        {
          school: "北京大学",
          degree: "本科",
          field: "计算机科学",
          start: "2018",
          end: "2022",
        },
        {
          school: "清华大学",
          degree: "硕士",
          field: "软件工程",
          start: "2022",
          end: "2025",
        },
      ],
    },
    {
      key: "skills_1",
      type: "skills",
      label: "专业技能",
      sort: 2,
      content: {
        items: ["React", "TypeScript", "Node.js", "TailwindCSS"],
      },
    },
  ];

  it.each([1, 2, 3] as const)("校验通过的 %i 列技能标签与侧栏标题使用校验对应的颜色", skillCols => {
    const style = {
      ...DEFAULT_STYLE, layout: "twocol" as const, asideBg: "#eeeeee", asideModules: ["skills"],
      accent: "#555555", ink: "#111111", text: "#333333", muted: "#555555", sectionColor: "#555555", skillCols,
    };
    expect(isCompleteGeneratedStyle(style)).toBe(true);
    const { container } = render(<ResumeDoc prepared={prepare("样例", mockModules)} style={style} />);
    const aside = container.querySelector("aside")!;
    expect(aside.style.backgroundColor).toBe("rgb(238, 238, 238)");
    expect(aside.querySelector("h2")!.style.color).toBe("rgb(85, 85, 85)");
    const pill = aside.querySelector<HTMLElement>('[data-resume-entry="0"]')!;
    const reference = document.createElement("span");
    reference.style.backgroundColor = `${style.accent}${SKILL_PILL_ALPHA_HEX}`;
    expect(pill.style.backgroundColor).toBe(reference.style.backgroundColor);
    expect(pill.style.color).toBe("rgb(85, 85, 85)");
  });

  it("band 标题按白字与色带校验，不使用 sectionColor 或侧栏底色作为标题配色", () => {
    const style = {
      ...DEFAULT_STYLE, layout: "twocol" as const, asideBg: "#eeeeee", asideModules: ["skills"],
      accent: "#555555", ink: "#111111", text: "#333333", muted: "#555555", sectionColor: "#ffffff",
      sectionDeco: "band" as const, sectionDecoColor: "#555555",
    };
    expect(isCompleteGeneratedStyle(style)).toBe(true);
    const { container } = render(<ResumeDoc prepared={prepare("样例", mockModules)} style={style} />);
    const title = container.querySelector<HTMLElement>("aside h2")!;
    expect(title.style.background).toBe("rgb(85, 85, 85)");
    expect(title.style.color).toBe("rgb(255, 255, 255)");
  });

  it("renders twocol with left aside and custom aside background", () => {
    const prepared = prepare("样例", mockModules);
    const twocolStyle = {
      ...DEFAULT_STYLE,
      layout: "twocol" as const,
      asidePosition: "left" as const,
      asideBg: "#f1f5f9",
      asidePadding: 20,
      asideGap: 24,
    };

    const { container } = render(<ResumeDoc prepared={prepared} style={twocolStyle} />);
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.style.backgroundColor).toBe("rgb(241, 245, 249)");
    expect(aside?.style.padding).toBe("20px");

    // 网格列宽：aside 居左时，第一个是 aside 宽 mm，第二个是 1fr
    const gridContainer = aside?.parentElement;
    expect(gridContainer?.style.gridTemplateColumns).toBe("88mm 1fr");
    expect(gridContainer?.style.gap).toBe("24px");
  });

  it.each([
    { selectors: undefined, expected: ["skills_1"] },
    { selectors: [], expected: ["skills_1"] },
    { selectors: ["entries"], expected: ["education_1"] },
    { selectors: ["education"], expected: ["education_1"] },
    { selectors: ["education_1"], expected: ["education_1"] },
    { selectors: ["absent-module"], expected: [] },
  ])("分栏选择器保留类型、具体模块、历史 kind 与缺省规则：$selectors", ({ selectors, expected }) => {
    const { container } = render(<ResumeDoc prepared={prepare("样例", mockModules)} style={{
      ...DEFAULT_STYLE, layout: "twocol", asideModules: selectors,
    }} />);
    const aside = container.querySelector("aside")!;
    expect([...aside.querySelectorAll("[data-resume-module]")].map(element => element.getAttribute("data-resume-module"))).toEqual(expected);
    for (const key of ["education_1", "skills_1"]) {
      expect(container.querySelectorAll(`[data-resume-module="${key}"]`)).toHaveLength(1);
    }
  });

  it("dynamically splits modules according to asideModules", () => {
    const prepared = prepare("样例", mockModules);
    // 显式指定 education_1 放入侧栏，skills_1 放回主栏
    const customSplitStyle = {
      ...DEFAULT_STYLE,
      layout: "twocol" as const,
      asideModules: ["education_1"],
    };

    const { container } = render(<ResumeDoc prepared={prepared} style={customSplitStyle} />);
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    // 教育经历应该在 aside 内部
    expect(aside?.querySelector('[data-resume-module="education_1"]')).not.toBeNull();
    // 技能应该在主栏（aside 外部）
    expect(aside?.querySelector('[data-resume-module="skills_1"]')).toBeNull();
  });

  it("uses module type selectors for repeated and custom modules", () => {
    const prepared = prepare("样例", [
      ...mockModules,
      {
        key: "education_2", type: "education", label: "补充教育", sort: 3,
        content: [{ school: "复旦大学", degree: "硕士", field: "计算机", start: "2023", end: "2025" }],
      },
      {
        key: "mod_custom_1", type: "custom", label: "资格证书", sort: 4,
        content: [{ id: "c1", title: "云平台认证", description: "已取得认证" }],
      },
      {
        key: "summary_1", type: "summary", label: "自我评价", sort: 5,
        content: { text: "关注工程质量" },
      },
    ]);
    const { container } = render(<ResumeDoc prepared={prepared} style={{
      ...DEFAULT_STYLE, layout: "twocol", asideModules: ["education", "custom", "summary"],
    }} />);
    const aside = container.querySelector("aside");

    expect(aside?.querySelector('[data-resume-module="education_1"]')).not.toBeNull();
    expect(aside?.querySelector('[data-resume-module="education_2"]')).not.toBeNull();
    expect(aside?.querySelector('[data-resume-module="mod_custom_1"]')).not.toBeNull();
    expect(aside?.querySelector('[data-resume-module="summary_1"]')).not.toBeNull();
    expect(aside?.querySelector('[data-resume-module="skills_1"]')).toBeNull();
  });

  it("renders entries with 2-column grid when entryCols is 2", () => {
    const prepared = prepare("样例", mockModules);
    const gridEntryStyle = {
      ...DEFAULT_STYLE,
      entryCols: 2 as const,
    };

    const { container } = render(<ResumeDoc prepared={prepared} style={gridEntryStyle} />);
    const eduModule = container.querySelector('[data-resume-module="education_1"]');
    const entryGrid = eduModule?.querySelector('div[style*="grid-template-columns"]');
    expect(entryGrid).not.toBeNull();
    expect((entryGrid as HTMLElement).style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("renders skills with multiple columns when skillCols is 2", () => {
    const prepared = prepare("样例", mockModules);
    const multiColSkillStyle = {
      ...DEFAULT_STYLE,
      skillCols: 2 as const,
      skillStyle: "pill" as const,
    };

    const { container } = render(<ResumeDoc prepared={prepared} style={multiColSkillStyle} />);
    const skillsModule = container.querySelector('[data-resume-module="skills_1"]');
    const skillContainer = skillsModule?.querySelector('div[style*="display: grid"]');
    expect(skillContainer).not.toBeNull();
    expect((skillContainer as HTMLElement).style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });
});
