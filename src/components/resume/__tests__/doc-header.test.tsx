// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { DocHeader } from "../doc-header";
import { DEFAULT_STYLE } from "@/lib/template-styles";
import type { Prepared } from "../doc-data";

describe("DocHeader contact rendering", () => {
  afterEach(cleanup);

  const basePrepared: Prepared = {
    title: "简历",
    name: "张三",
    contact: "138-0000-0000 · test@example.com · 北京",
    contactParts: ["138-0000-0000", "test@example.com", "北京"],
    links: ["github.com/zhangsan"],
    sections: [],
  };

  it("renders with default separator and gap", () => {
    render(<DocHeader d={basePrepared} s={DEFAULT_STYLE} />);
    expect(screen.getByText("张三")).toBeDefined();
    expect(screen.getByText("138-0000-0000")).toBeDefined();
    expect(screen.getByText("test@example.com")).toBeDefined();
    expect(screen.getByText("北京")).toBeDefined();
    expect(screen.getByText("github.com/zhangsan")).toBeDefined();

    // 默认分隔符 ·
    const separators = screen.getAllByText("·");
    expect(separators.length).toBe(2);
    // 默认间距 8px -> margin 4px
    expect(separators[0]!.style.marginLeft).toBe("4px");
    expect(separators[0]!.style.marginRight).toBe("4px");
  });

  it("renders with custom separator and custom gap", () => {
    const customStyle = {
      ...DEFAULT_STYLE,
      contactSeparator: "|",
      contactGap: 16,
    };
    render(<DocHeader d={basePrepared} s={customStyle} />);
    const separators = screen.getAllByText("|");
    expect(separators.length).toBe(2);
    expect(separators[0]!.style.marginLeft).toBe("8px");
    expect(separators[0]!.style.marginRight).toBe("8px");
  });

  it("renders without separator when contactSeparator is empty string", () => {
    const emptyStyle = {
      ...DEFAULT_STYLE,
      contactSeparator: "",
      contactGap: 12,
    };
    render(<DocHeader d={basePrepared} s={emptyStyle} />);
    expect(screen.getByText("138-0000-0000")).toBeDefined();
    expect(screen.getByText("test@example.com")).toBeDefined();
    expect(screen.getByText("北京")).toBeDefined();

    // 此时不存在分隔符 span
    expect(screen.queryByText("·")).toBeNull();
    expect(screen.queryByText("|")).toBeNull();

    // 容器应当设置 columnGap 为 12px
    const contactContainer = screen.getByText("138-0000-0000").closest("div");
    expect(contactContainer?.style.columnGap).toBe("12px");
  });

  it("renders correctly in banner and card styles", () => {
    const bannerStyle = {
      ...DEFAULT_STYLE,
      headerStyle: "banner" as const,
      contactSeparator: "/",
      contactGap: 10,
    };
    render(<DocHeader d={basePrepared} s={bannerStyle} />);
    const separators = screen.getAllByText("/");
    expect(separators.length).toBe(2);
    expect(separators[0]!.style.marginLeft).toBe("5px");
  });

  it("renders with grid2 contactLayout", () => {
    const gridStyle = {
      ...DEFAULT_STYLE,
      contactLayout: "grid2" as const,
    };
    render(<DocHeader d={basePrepared} s={gridStyle} />);
    const contactContainer = screen.getByText("138-0000-0000").closest("div")?.parentElement;
    expect(contactContainer?.style.display).toBe("grid");
    expect(contactContainer?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("renders headerLayout center-avatar and left-avatar", () => {
    const avatarPrepared: Prepared = {
      ...basePrepared,
      avatar: "http://localhost/avatar.png",
    };

    const centerStyle = {
      ...DEFAULT_STYLE,
      headerLayout: "center-avatar" as const,
    };
    const { unmount } = render(<DocHeader d={avatarPrepared} s={centerStyle} />);
    expect(screen.getByAltText("个人头像")).toBeDefined();
    unmount();

    const leftStyle = {
      ...DEFAULT_STYLE,
      headerLayout: "left-avatar" as const,
    };
    render(<DocHeader d={avatarPrepared} s={leftStyle} />);
    expect(screen.getByAltText("个人头像")).toBeDefined();
  });
});
