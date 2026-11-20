// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import OfferComparisonPage from "../page";
import ToolsPage from "../../page";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const condition = (name: string) => within(screen.getByRole("region", { name: `Offer ${name} 条件` }));
const results = () => within(screen.getByRole("region", { name: "比较结果" }));
const example = () => fireEvent.click(screen.getByRole("button", { name: "用示例体验" }));

it("工具箱可进入比较器，空表单保留未知状态并提示补齐", () => {
  const toolbox = render(<ToolsPage />);
  expect(screen.getByRole("link", { name: /Offer 实际价值比较器/ }).getAttribute("href")).toBe("/tools/offer");
  toolbox.unmount();
  render(<OfferComparisonPage />);
  expect(screen.getByRole("link", { name: /练习薪酬谈判/ }).getAttribute("href")).toBe("/tools/salary");
  fireEvent.click(screen.getByRole("button", { name: "检查并查看比较" }));
  expect(screen.getByRole("alert").textContent).toContain("未填项目不会按 0");
  expect(condition("A").getByLabelText("税前月固定工资").getAttribute("aria-invalid")).toBe("true");
  expect(results().queryByText(/情景下的取舍/)).toBeNull();
});

it("切换情景与编辑输入即时重新计算，删除必填值后撤回旧结论", () => {
  render(<OfferComparisonPage />);
  example();
  expect(results().getByText("中性情景下的取舍")).toBeDefined();
  expect(results().getByText(/Offer A 每年成本后现金多 31,000 元/)).toBeDefined();
  expect(results().getByText(/Offer B 更高/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "乐观" }));
  expect(results().getByText("乐观情景下的取舍")).toBeDefined();
  expect(results().getByText("60,000 元")).toBeDefined();
  fireEvent.change(condition("A").getByLabelText("税前月固定工资"), { target: { value: "10000" } });
  expect(results().getByText(/Offer B 每年成本后现金多/)).toBeDefined();
  fireEvent.change(condition("A").getByLabelText("税前月固定工资"), { target: { value: "" } });
  expect(results().queryByText(/情景下的取舍/)).toBeNull();
  expect(results().getByText(/补齐两份 Offer/)).toBeDefined();
});

it("修改偏好权重和核实状态更新评分与问题，复制失败提供可恢复反馈", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<OfferComparisonPage />);
  example();
  for (const label of ["业务与岗位稳定性", "团队与管理方式", "地点与工作灵活性"]) {
    fireEvent.change(screen.getByLabelText(`${label}权重`), { target: { value: "0" } });
  }
  expect(results().getByText("100 / 100")).toBeDefined();
  expect(results().getByText("60 / 100")).toBeDefined();
  fireEvent.click(condition("A").getByLabelText("奖金兑现与发放条件"));
  expect(within(screen.getByRole("region", { name: "Offer A 确认清单" })).queryByText(/年度目标奖金/)).toBeNull();
  expect(within(screen.getByRole("region", { name: "Offer B 确认清单" })).getByText(/年度目标奖金/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "复制两份问题清单" }));
  expect((await screen.findByRole("alert")).textContent).toContain("复制失败");
  expect(writeText.mock.calls[0]?.[0]).toContain("Offer B · 生活平衡方案（示例）");
  writeText.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "复制两份问题清单" }));
  expect(await screen.findByRole("button", { name: "已复制" })).toBeDefined();
});

it("开始填写后不再允许示例覆盖，倒置情景比例显示错误", () => {
  render(<OfferComparisonPage />);
  fireEvent.change(condition("A").getByLabelText("保证发薪月数"), { target: { value: "13" } });
  expect(screen.queryByRole("button", { name: "用示例体验" })).toBeNull();
  cleanup();
  render(<OfferComparisonPage />);
  example();
  fireEvent.change(condition("A").getByLabelText("保守奖金兑现（%）"), { target: { value: "80" } });
  fireEvent.click(screen.getByRole("button", { name: "检查并查看比较" }));
  expect(screen.getByText(/保守 ≤ 中性 ≤ 乐观/)).toBeDefined();
  expect(results().queryByText(/情景下的取舍/)).toBeNull();
});
