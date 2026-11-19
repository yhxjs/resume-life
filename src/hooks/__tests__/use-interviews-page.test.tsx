// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResumeOption } from "../use-resume-options";

const state = vi.hoisted(() => ({ resumes: null as ResumeOption[] | null }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({ resumes: state.resumes, resumesError: "", reloadResumes: vi.fn() }) }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({ items: [], total: 0, listError: "", reload: vi.fn(), hasMore: false }) }));
import { useInterviewsPage } from "../use-interviews-page";

const first: ResumeOption = { id: 1, title: "甲简历", updated_at: "", versions: [{ id: 11, version: 1, name: "甲版" }] };
const second: ResumeOption = { id: 2, title: "乙简历", updated_at: "", versions: [{ id: 21, version: 1, name: "乙旧版" }, { id: 22, version: 2, name: "乙新版" }] };
beforeEach(() => { state.resumes = [first, second]; });
afterEach(cleanup);

it("首次载入默认首份简历的最新发布版，列表刷新保留手动选择", () => {
  const view = renderHook(() => useInterviewsPage(null));
  expect(view.result.current.resumeId).toBe(1);
  act(() => view.result.current.setResumeId(2));
  act(() => view.result.current.setResumeVersionId(21));
  state.resumes = [first, { ...second, versions: [...second.versions, { id: 23, version: 3, name: "新发布" }] }];
  view.rerender();
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe(21);
});

it("URL 只负责初始选择，刷新不撤销用户后来选择的简历", () => {
  const view = renderHook(() => useInterviewsPage("1", "11"));
  act(() => view.result.current.setResumeId(2));
  expect(view.result.current.resumeVersionId).toBe(22);
  state.resumes = [...state.resumes!];
  view.rerender();
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe(22);
});

it.each(["999", "abc", "0", "1.5"])("URL 简历 %s 不可用时保持未选，不默用其他材料", (id) => {
  const view = renderHook(() => useInterviewsPage(id, "21"));
  expect(view.result.current.resumeId).toBe("");
  expect(view.result.current.resumeVersionId).toBe("");
  act(() => view.result.current.setResumeId(2));
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe(22);
});

it("已选简历从刷新列表消失时清空可提交值，不切到列表第一份", () => {
  const view = renderHook(() => useInterviewsPage(null));
  act(() => view.result.current.setResumeId(2));
  state.resumes = [first];
  view.rerender();
  expect(view.result.current.resumeId).toBe("");
  expect(view.result.current.resumeVersionId).toBe("");
  state.resumes = [first, second];
  view.rerender();
  expect(view.result.current.resumeId).toBe(2);
});

it("URL 来源改变后选择对应简历与指定旧版，缺失版本不换最新版", () => {
  const view = renderHook(({ id, version }) => useInterviewsPage(id, version), { initialProps: { id: "1", version: "11" } });
  view.rerender({ id: "2", version: "21" });
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe(21);
  view.rerender({ id: "2", version: "999" });
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe("");
});

it("简历列表延迟载入及初始为空时可在真实选项出现后初始化", () => {
  state.resumes = null;
  const view = renderHook(() => useInterviewsPage(null));
  expect(view.result.current.resumeId).toBe("");
  state.resumes = [];
  view.rerender();
  state.resumes = [second];
  view.rerender();
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe(22);
});

it("投递指定发布版暂时缺失时不替换，刷新出现后恢复指定旧版", () => {
  state.resumes = [{ ...second, versions: [second.versions[1]!] }];
  const view = renderHook(() => useInterviewsPage("2", "21"));
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe("");
  state.resumes = [first, second];
  view.rerender();
  expect(view.result.current.resumeId).toBe(2);
  expect(view.result.current.resumeVersionId).toBe(21);
});
