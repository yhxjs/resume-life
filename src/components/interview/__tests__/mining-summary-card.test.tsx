// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiningSummaryCard } from "../mining-summary-card";
import type { MiningSummary } from "@/lib/scores";

const summary: MiningSummary = {
  project_name: "接口维护", background: "维护已有服务", actions: "参与参数校验", tradeoffs: "范围有限",
  results: "尚未上线", contribution: "仅负责校验", pending_confirmations: [],
  resume_bullets: ["只参与参数校验 <T> &amp;\n尚未上线，未统计收益。", "[待补充：个人分工]，不代表独立完成。"],
};
const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("经历挖掘草稿的复制契约", () => {
  it("单条与整组逐字复制，失败定位到对应内容，重试与切换操作不沿用旧成功", async () => {
    const original = structuredClone(summary);
    render(<MiningSummaryCard miningSummary={summary} />);
    const region = within(screen.getByRole("region", { name: "简历描述草稿" }));
    const row = screen.getByText((_text, node) => node?.tagName === "P" && node.textContent === summary.resume_bullets[0]).closest(".group")! as HTMLElement;
    const single = within(row);
    fireEvent.click(single.getByRole("button", { name: "复制" }));
    const copied = await single.findByRole("button", { name: "已复制" });
    expect(writeText).toHaveBeenLastCalledWith(summary.resume_bullets[0]);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(copied);
    expect((await single.findByRole("alert")).textContent).toContain("手动复制");
    expect(single.queryByRole("button", { name: "已复制" })).toBeNull();
    fireEvent.click(single.getByRole("button", { name: "复制" }));
    await single.findByRole("button", { name: "已复制" });
    expect(single.queryByRole("alert")).toBeNull();
    const all = region.getByRole("button", { name: "📋 一键复制全部要点" });
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(all);
    await region.findByRole("alert");
    expect(single.queryByRole("alert")).toBeNull();
    expect(region.queryByRole("button", { name: "已复制" })).toBeNull();
    fireEvent.click(all);
    await region.findByRole("button", { name: "✓ 全部草稿已复制" });
    expect(region.queryByRole("alert")).toBeNull();
    expect(writeText).toHaveBeenLastCalledWith(summary.resume_bullets.map((bullet) => `• ${bullet}`).join("\n"));
    expect(summary).toEqual(original);
    expect(region.getByText(/没有依据时不补写量化结果/)).toBeTruthy();
  });

  it("复制等待时整组与单条按钮一起禁用，卸载后晚到结果不报错", async () => {
    let resolve!: () => void;
    writeText.mockReturnValueOnce(new Promise<void>((yes) => { resolve = yes; }));
    const { unmount } = render(<MiningSummaryCard miningSummary={summary} />);
    const region = within(screen.getByRole("region", { name: "简历描述草稿" }));
    fireEvent.click(region.getByRole("button", { name: "📋 一键复制全部要点" }));
    for (const button of region.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
    unmount();
    await act(async () => { resolve(); });
    expect(writeText).toHaveBeenCalledOnce();
  });
});
