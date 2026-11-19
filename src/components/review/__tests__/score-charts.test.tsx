// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RadarChart, TrendChart, type ReviewSessionPoint } from "../score-charts";

const scores = { depth: 0, structure: 10, authenticity: 7.4, completeness: 8.2 };
const sessions = (count: number): ReviewSessionPoint[] => Array.from({ length: count }, (_, index) => ({
  id: `drill-${index + 1}`, kind: "drill", label: `原题 ${index + 1} <T> &amp;`,
  date: "旧时间字面量", count: 2, avg: scores, overall: 6.4,
}));
const openDetails = () => {
  fireEvent.click(screen.getByText("查看本页场次明细"));
  return screen.getByRole("list", { name: "本页场次明细" });
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("最近20场按原序展示；两次翻页覆盖全部45场且无重复，首尾按钮边界正确", () => {
  const source = sessions(45), before = structuredClone(source);
  render(<TrendChart sessions={source} />);
  const list = openDetails();
  const labels: string[] = [];
  for (let page = 0; page < 3; page++) {
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(page === 2 ? 5 : 20);
    expect(screen.getByRole("img").querySelectorAll("circle, rect").length).toBeLessThanOrEqual(80);
    labels.push(...items.map(item => within(item).getByText(/^原题 /).textContent!));
    if (page < 2) fireEvent.click(screen.getByRole("button", { name: "更早场次" }));
  }
  expect(new Set(labels).size).toBe(45);
  expect(labels).toEqual([...source.slice(25), ...source.slice(5, 25), ...source.slice(0, 5)].map(item => item.label));
  expect((screen.getByRole("button", { name: "更早场次" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "0" } });
  expect((screen.getByRole("button", { name: "较新场次" }) as HTMLButtonElement).disabled).toBe(true);
  expect(source).toEqual(before);
});

it.each([1, 20, 21, 20_000])("%i 场历史的图形和明细均有界，并可直达最早场次", count => {
  render(<TrendChart sessions={sessions(count)} />);
  const list = openDetails();
  expect(within(list).getAllByRole("listitem")).toHaveLength(Math.min(20, count));
  expect(screen.getByRole("img").querySelectorAll("circle, rect").length).toBe(Math.min(20, count) * 4);
  if (count > 20) fireEvent.change(screen.getByRole("combobox"), { target: { value: String(Math.ceil(count / 20) - 1) } });
  expect(within(list).getByText("原题 1 <T> &amp;")).toBeDefined();
});

it("来源数据缩短时夹紧当前页，空数据不显示假场次", () => {
  const { rerender } = render(<TrendChart sessions={sessions(45)} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
  rerender(<TrendChart sessions={sessions(3)} />);
  expect(openDetails().querySelectorAll("li")).toHaveLength(3);
  expect(screen.queryByRole("combobox")).toBeNull();
  rerender(<TrendChart sessions={[]} />);
  expect(screen.getByText("暂无场次数据")).toBeDefined();
  expect(screen.queryByRole("img")).toBeNull();
});

it.each(["2026-02-30", "旧时间字面量", ""])("完整标题、边界小数及历史日期 %j 保留在明细中", date => {
  const label = "标题 <T> &amp;\n  内部空格 ".repeat(100);
  render(<TrendChart sessions={[{ ...sessions(1)[0]!, label, date }]} />);
  const list = openDetails();
  expect(list.textContent).toContain(label);
  expect(list.textContent).toContain(date || "未记录时间");
  for (const value of ["0.0", "10.0", "7.4", "8.2"]) expect(within(list).getByText(value)).toBeDefined();
});

it("雷达表格区分缺失来源与零分；保留每一维小数并提供表头", () => {
  render(<RadarChart series={[{ label: "练习", avg: scores, color: "red" }, { label: "面试", avg: null, color: "blue" }]} />);
  const table = screen.getByRole("table", { name: "四维均分对比" });
  expect(within(table).getAllByText("暂无评分")).toHaveLength(4);
  expect(within(table).getByText("0.0")).toBeDefined();
  expect(within(table).getByText("7.4")).toBeDefined();
  expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
  expect(within(table).getAllByRole("rowheader")).toHaveLength(4);
});

it("空数据恢复后启动尺寸观察，窄屏调整坐标宽度而不缩小字号，卸载停止观察", () => {
  let onResize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { onResize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const { unmount, rerender } = render(<TrendChart sessions={[]} />);
  expect(observe).not.toHaveBeenCalled();
  rerender(<TrendChart sessions={sessions(2)} />);
  expect(observe).toHaveBeenCalledOnce();
  // 模拟真实容器尺寸通知；浏览器测试实测变换后的像素字号。
  resize(onResize, 240);
  expect(screen.getByRole("img").getAttribute("viewBox")).toBe("0 0 240 280");
  expect(screen.getByRole("img").querySelector("text")?.getAttribute("font-size")).toBe("12");
  unmount(); expect(disconnect).toHaveBeenCalledOnce();
});

function resize(callback: ResizeObserverCallback, width: number) {
  act(() => callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
}
