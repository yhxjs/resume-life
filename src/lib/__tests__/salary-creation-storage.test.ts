// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { clearPendingSalaryCreation, readPendingSalaryCreation, SALARY_CREATION_STORAGE_KEY, savePendingSalaryCreation } from "../salary-creation-storage";
const state = vi.hoisted(() => ({ generation: "first" }));
vi.mock("../api-fetch", () => ({ documentDataGeneration: () => state.generation }));
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); state.generation = "first"; });
const snapshot = { target_company_tier: "企业 <T>", target_role: "岗位", expected_salary: "30k，薪数待确认", current_or_competing_offer: "  原条件 &amp;\n未确认  ", hr_style: "standard" as const };
it("暂存完整快照并绑定文档世代，恢复后的新文档不认领旧请求", () => {
  const pending = { requestId: crypto.randomUUID(), snapshot };
  savePendingSalaryCreation(pending); expect(readPendingSalaryCreation()).toEqual(pending);
  state.generation = "restored";
  expect(readPendingSalaryCreation()).toBeNull(); expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
});
it("旧完成回调不能清掉当前标签页更新后的另一请求", () => {
  const old = crypto.randomUUID(); const next = crypto.randomUUID();
  savePendingSalaryCreation({ requestId: next, snapshot });
  expect(() => clearPendingSalaryCreation({ requestId: old, snapshot })).toThrow("已改变");
  expect(readPendingSalaryCreation()?.requestId).toBe(next);
  clearPendingSalaryCreation({ requestId: next, snapshot }); expect(readPendingSalaryCreation()).toBeNull();
});
it.each(Object.keys(snapshot) as (keyof typeof snapshot)[])("清理必须匹配完整背景，%s 改动不能删掉当前稿", key => {
  const pending = { requestId: crypto.randomUUID(), snapshot };
  savePendingSalaryCreation({ ...pending, snapshot: { ...snapshot, [key]: key === "hr_style" ? "pressure" : `${snapshot[key]} 新内容` } });
  const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
  expect(() => clearPendingSalaryCreation(pending)).toThrow("已改变");
  expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
});
it("同编号另一世代的记录不能清理，失败不能顺带丢弃旧暂存", () => {
  const pending = { requestId: crypto.randomUUID(), snapshot };
  savePendingSalaryCreation(pending); const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
  state.generation = "restored";
  expect(() => clearPendingSalaryCreation(pending)).toThrow("已改变");
  expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
});
it("背景字段顺序变化仍可核对，正文、内部空白和实体字面量保持原值", () => {
  const pending = { requestId: crypto.randomUUID(), snapshot };
  savePendingSalaryCreation({ ...pending, snapshot: Object.fromEntries(Object.entries(snapshot).reverse()) as typeof snapshot });
  clearPendingSalaryCreation(pending); expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
});
it("人工丢弃只能清理最初读取的损坏原文，后来的记录原样保留", () => {
  const raw = "{坏 JSON，原文 <T> &amp;";
  sessionStorage.setItem(SALARY_CREATION_STORAGE_KEY, raw);
  expect(() => clearPendingSalaryCreation({ raw: "另一份损坏记录" })).toThrow("已改变");
  expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
  clearPendingSalaryCreation({ raw }); expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
});
it("读取或移除失败不能伪装成清理成功，原编号仍可恢复", () => {
  const pending = { requestId: crypto.randomUUID(), snapshot }; savePendingSalaryCreation(pending);
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("读取失败"); });
  expect(() => clearPendingSalaryCreation(pending)).toThrow("读取失败"); get.mockRestore();
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("移除失败"); });
  expect(() => clearPendingSalaryCreation(pending)).toThrow("移除失败"); remove.mockRestore();
  expect(readPendingSalaryCreation()).toEqual(pending);
});
it.each([null, [], {}, { target_role: "" }, { ...snapshot, hr_style: "unknown" }, { ...snapshot, extra: "不能混入字段" }])("损坏快照 %# 不默认补齐、改写或认领", (invalid) => {
  sessionStorage.setItem(SALARY_CREATION_STORAGE_KEY, JSON.stringify({ version: 1, generation: "first", requestId: crypto.randomUUID(), snapshot: invalid }));
  expect(() => readPendingSalaryCreation()).toThrow("创建恢复信息损坏");
});
