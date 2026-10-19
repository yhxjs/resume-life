import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const configSource = fs.readFileSync(path.join(process.cwd(), "vitest.config.ts"), "utf8");

/**
 * 最近一次全量覆盖率实测水位（2026-09-28，含页面和布局）。
 *
 * 门禁阈值必须留在这条线之下：一个永远失败的门禁等价于没有门禁，
 * 而且会训练所有人忽略 CI 红叉；扩大统计范围后需重测基线再调整阈值。
 *
 * 覆盖率真实提升后，请同步上调这里与 vitest.config.ts。
 */
const MEASURED = { lines: 55.07, functions: 40.05, branches: 42.45 } as const;

type ThresholdKey = "lines" | "functions" | "branches";

/** 从配置源码里取出 coverage.thresholds.<key>；提取不到返回 null（而非 0，避免把「没读到」伪装成「阈值是 0」） */
function threshold(source: string, key: ThresholdKey): number | null {
  const block = source.match(/thresholds\s*:\s*\{[^}]*\}/u);
  if (!block) return null;
  const value = block[0].match(new RegExp(`${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, "u"));
  return value ? Number(value[1]) : null;
}

describe("覆盖率门禁契约", () => {
  it("覆盖率报告计入页面与布局，而非只统计领域模块", () => {
    expect(configSource).not.toContain('"src/app/**/page.tsx"');
    expect(configSource).not.toContain('"src/app/**/layout.tsx"');
  });
  it("提取器能识别真实配置，且认得出被改小的阈值", () => {
    // 提取器必须「有牙齿」：既不能永远返回 null（下面的断言就恒真了），
    // 也不能对阈值改动视而不见。合成输入分别覆盖「能读」「读得准」「读不到」。
    expect(threshold("thresholds: { lines: 0 }", "lines")).toBe(0);
    expect(threshold("thresholds: { lines: 53 }", "lines")).toBe(53);
    expect(threshold("thresholds: { lines: 50, branches: 40 }", "branches")).toBe(40);
    // thresholds 被改名即失明——这正是下面的 not.toBeNull() 守卫要拦的情形
    expect(threshold("limits: { lines: 53 }", "lines")).toBeNull();
  });

  it("配置里同时存在行、函数与分支阈值", () => {
    // 只有行阈值时，「写一堆只走 if 分支的测试」就能把门禁刷绿；
    // 补上分支阈值才能挡住这条捷径；函数阈值挡住「少数大函数刷满行数」的捷径。
    expect(threshold(configSource, "lines")).not.toBeNull();
    expect(threshold(configSource, "functions")).not.toBeNull();
    expect(threshold(configSource, "branches")).not.toBeNull();
  });

  it("所有阈值都不低于下界，挡住「把门禁改回形同虚设」", () => {
    expect(threshold(configSource, "lines")).toBeGreaterThanOrEqual(50);
    expect(threshold(configSource, "functions")).toBeGreaterThanOrEqual(38);
    expect(threshold(configSource, "branches")).toBeGreaterThanOrEqual(37);
  });

  it("所有阈值都不高于实测水位，保证门禁当下确实能过", () => {
    expect(threshold(configSource, "lines")).toBeLessThanOrEqual(MEASURED.lines);
    expect(threshold(configSource, "functions")).toBeLessThanOrEqual(MEASURED.functions);
    expect(threshold(configSource, "branches")).toBeLessThanOrEqual(MEASURED.branches);
  });

  it("阈值不高于 100，挡住小数点丢失之类的笔误", () => {
    expect(threshold(configSource, "lines")).toBeLessThanOrEqual(100);
    expect(threshold(configSource, "functions")).toBeLessThanOrEqual(100);
    expect(threshold(configSource, "branches")).toBeLessThanOrEqual(100);
  });
});
