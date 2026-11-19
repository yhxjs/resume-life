// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiagnoseDialog } from "../diagnose-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { useResumeOptions } from "@/hooks/use-resume-options";
import type { ModuleData } from "@/lib/modules";
import type { DiagnosisHistoryResponse } from "@/lib/diagnosis";
import { diagnosisValue, validateGeneratedDiagnosis } from "@/lib/diagnosis";
import { writeDiagnosisValue } from "@/lib/module-descriptions";
import { stripRichText } from "@/lib/rich-text";

const { flushDraft, saveState } = vi.hoisted(() => ({
  flushDraft: vi.fn<() => Promise<void>>(),
  saveState: { needsUnloadWarning: false },
}));

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({
  getResumeSaveQueue: () => ({ flush: flushDraft, get needsUnloadWarning() { return saveState.needsUnloadWarning; } }),
}));
vi.mock("@/components/common/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
  alertDialog: vi.fn(async () => {}),
}));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: vi.fn() }));

const resumeOptions = [
  { id: 4, title: "我的简历", updated_at: "", versions: [{ id: 42, version: 2, name: "新版" }, { id: 41, version: 1, name: "投递版" }] },
];

const modules: ModuleData[] = [
  { key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["React", "TypeScript"] } },
];

const historyResponse = (adoptions = false) => ({
  current: {
    id: 7,
    job_id: "job-1",
    job_title: "资深前端",
    jd: "岗位 JD 全文",
    resume_version_id: 41,
    created_at: "2026-09-27T10:00:00.000Z",
    adoptions: adoptions
      ? [{ moduleKey: "skills", suggestionIndex: 0, value: ["React", "TypeScript", "Node.js"], applied_at: "2026-09-27T11:00:00.000Z" }]
      : [],
    resume_snapshot: { title: "简历", modules: [] },
    report: {
      match: 8,
      summary: "整体匹配良好",
      modules: [
        {
          moduleKey: "skills",
          label: "技能",
          scores: { depth: 8, structure: 7, authenticity: 9, completeness: 6 },
          gaps: "缺少 Node.js 相关技能",
          suggestions: [
            { itemId: "", field: "items" as const, reason: "JD 明确要求 Node.js", draft: ["React", "TypeScript", "Node.js"] },
          ],
        },
      ],
    },
  },
  previous: null,
  history: [{ id: 7, job_id: "job-1", job_title: "资深前端", created_at: "2026-09-27T10:00:00.000Z", match: 8 }],
});

beforeEach(() => {
  saveState.needsUnloadWarning = false;
  flushDraft.mockReset().mockResolvedValue(undefined);
  vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
  vi.mocked(useResumeOptions).mockReturnValue({ resumes: resumeOptions, resumesError: "", reloadResumes: vi.fn() });
  vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return historyResponse(true) as never;
    if (String(url).startsWith("/api/resumes/4/diagnose")) return historyResponse() as never;
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

function openDialog() {
  const onApply = vi.fn(() => true);
  render(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
  return onApply;
}

async function openReport() {
  const onApply = openDialog();
  // 改写草稿 textarea 已按建议草稿填充，说明报告加载完成
  const draft = (await screen.findByRole("textbox", { name: /改写草稿/ })) as HTMLTextAreaElement;
  expect(draft.value).toBe("React\nTypeScript\nNode.js");
  return onApply;
}

describe("DiagnoseDialog JD 诊断交互", () => {
  it("候选读取等待显示状态，不放行诊断", async () => {
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: null, resumesError: "", reloadResumes: vi.fn() });
    vi.mocked(jsonFetch).mockResolvedValue({ current: null, previous: null, history: [] });
    openDialog();
    await waitFor(() => expect(screen.queryByText("正在处理，请稍候…")).toBeNull());
    expect(screen.getByText("正在读取已发布版本…").getAttribute("role")).toBe("status");
    expect(screen.getByRole("button", { name: "开始诊断" }).hasAttribute("disabled")).toBe(true);
  });

  it("候选失败停止加载提示，可单独重读且保留岗位与 JD 草稿", async () => {
    const reloadResumes = vi.fn();
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: null, resumesError: "候选响应损坏", reloadResumes });
    vi.mocked(jsonFetch).mockResolvedValue({ current: null, previous: null, history: [] });
    const onApply = vi.fn(() => true);
    const { rerender } = render(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await waitFor(() => expect(screen.queryByText("正在处理，请稍候…")).toBeNull());
    fireEvent.change(screen.getByLabelText(/岗位名称/), { target: { value: "岗位草稿" } });
    fireEvent.change(screen.getByLabelText("岗位要求（JD）"), { target: { value: "参与联调 <T> &amp;\n尚未上线" } });
    expect(screen.getByRole("alert").textContent).toContain("候选响应损坏");
    expect(screen.queryByText("正在读取已发布版本…")).toBeNull();
    expect(screen.getByRole("button", { name: "开始诊断" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "点击重试" }));
    expect(reloadResumes).toHaveBeenCalledOnce();
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: resumeOptions, resumesError: "", reloadResumes });
    rerender(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
    expect((screen.getByLabelText(/岗位名称/) as HTMLInputElement).value).toBe("岗位草稿");
    expect((screen.getByLabelText("岗位要求（JD）") as HTMLTextAreaElement).value).toBe("参与联调 <T> &amp;\n尚未上线");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement).value).toBe("42");
    expect(screen.getByRole("button", { name: "开始诊断" }).hasAttribute("disabled")).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it.each(["summary", "skills"] as const)("%s 模块级建议带错误条目 ID 时不写入或记录采纳", async (type) => {
    const target: ModuleData = { key: "target", type, label: "目标模块", sort: 1,
      content: type === "summary" ? { text: "原正文" } : { items: ["原技能"] } };
    const response: DiagnosisHistoryResponse = historyResponse();
    response.current!.resume_snapshot.modules = [target];
    response.current!.report!.modules[0]!.moduleKey = "target";
    response.current!.report!.modules[0]!.suggestions = [{ itemId: "wrong-id", field: type === "summary" ? "text" : "items",
      reason: "优化表达", draft: type === "summary" ? "改写正文" : ["改写技能"] }];
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn(() => true);
    render(<DiagnoseDialog resumeId="4" modules={[target]} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await screen.findByRole("textbox", { name: "改写草稿" });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    expect((await screen.findByRole("alert")).textContent).toBe("目标模块或条目已被删除，无法写入");
    expect(onApply).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  async function openSkillReport(original: string[], current: string[], adopted?: string[] | string) {
    const response: DiagnosisHistoryResponse = historyResponse();
    const snapshotModules: ModuleData[] = [{ ...modules[0]!, content: { items: original } }];
    response.current!.resume_snapshot.modules = snapshotModules;
    if (adopted !== undefined) response.current!.adoptions = [{
      moduleKey: "skills", suggestionIndex: 0, value: adopted, applied_at: "2026-10-27T00:00:00.000Z",
    }];
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn(() => true);
    render(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: current } }]} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await screen.findByText("诊断时原文");
    return { onApply, response };
  }

  it.each([
    { original: ["<template>"], current: ["<script>"] },
    { original: ["Array<T>", "Map<K, V>", "&amp;"], current: ["Promise<T>", "&lt;T&gt;", "<strong>React</strong>"] },
  ])("技能原文 $original 与当前值 $current 按纯文本显示", async ({ original, current }) => {
    await openSkillReport(original, current);
    const originalDisplay = screen.getByText("诊断时原文").nextElementSibling!;
    const currentDisplay = screen.getByText("查看当前内容（诊断后有变化）").nextElementSibling!;
    for (const skill of original) expect(originalDisplay.textContent).toContain(skill);
    for (const skill of current) expect(currentDisplay.textContent).toContain(skill);
    expect(originalDisplay.querySelector("strong, template, script")).toBeNull();
    expect(currentDisplay.querySelector("strong, template, script")).toBeNull();
  });

  it.each([
    { adopted: ["<template>"] },
    { adopted: ["Map<K, V>", "&amp;", "<strong>React</strong>"] },
    { adopted: "<template>\r\n&amp;" },
  ])("已采纳技能 $adopted 保留字面内容，兼容历史字符串记录", async ({ adopted }) => {
    await openSkillReport(["React"], ["React"], adopted);
    const display = screen.getByText("改写草稿（已采纳，显示当时写入内容）").nextElementSibling!;
    const expected = typeof adopted === "string" ? adopted.split(/\r?\n/) : adopted;
    for (const skill of expected) expect(display.textContent).toContain(skill);
    expect(display.querySelector("strong, template")).toBeNull();
  });

  it.each([false, true])("技能写入后 saved=%s，待同步展示及重试载荷保留字面内容", async (saved) => {
    const { onApply, response } = await openSkillReport(["React"], ["React"]);
    const skills = ["Map<K, V>", "&amp;", "<template>", "<strong>React</strong>"];
    if (saved) vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录失败"));
    else flushDraft.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("保存失败"));
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: skills.join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    const retryButton = await screen.findByRole("button", { name: saved ? "重试记录" : "重试保存并记录" });
    const label = saved ? "改写草稿（已保存，待同步采纳记录）" : "改写草稿（已写入，待保存并记录）";
    const display = screen.getByText(label).nextElementSibling!;
    for (const skill of skills) expect(display.textContent).toContain(skill);
    expect(display.querySelector("strong, template")).toBeNull();
    expect(onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", skills);

    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, current: { ...response.current!, adoptions: [{
      moduleKey: "skills", suggestionIndex: 0, value: skills, applied_at: "2026-10-27T00:00:00.000Z",
    }] } });
    fireEvent.click(retryButton);
    await screen.findByText("改写草稿（已采纳，显示当时写入内容）");
    const patches = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(saved ? 2 : 1);
    for (const [, init] of patches) expect(JSON.parse(String(init?.body)).value).toEqual(skills);
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("已采纳技能模块删除后显示目标已删除，空数组仍是存在的目标", async () => {
    const response: DiagnosisHistoryResponse = historyResponse(true);
    response.current!.adoptions[0]!.value = "React\r\nTypeScript";
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn(() => true);
    const view = render(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    expect((await screen.findByText(/已采纳写入/)).textContent).toContain("· 当前保留 ·");
    view.rerender(<DiagnoseDialog resumeId="4" modules={[]} onApply={onApply} />);
    expect(screen.getByText(/已采纳写入/).textContent).toContain("· 目标已删除 ·");
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: [] } }]} onApply={onApply} />);
    expect(screen.getByText(/已采纳写入/).textContent).toContain("· 后续已修改 ·");
    view.rerender(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
    expect(screen.getByText(/已采纳写入/).textContent).toContain("· 当前保留 ·");
    expect(onApply).not.toHaveBeenCalled();
    expect(flushDraft).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(1);
    expect(response.current!.adoptions[0]!.value).toBe("React\r\nTypeScript");
  });

  it.each([
    { adopted: ["Map<K, V>", "&amp;", "<template>"], current: ["Map<K, V>", "&amp;", "<template>"], status: "当前保留" },
    { adopted: "Map<K, V>\n&amp;\n<template>", current: ["Map<K, V>", "&amp;", "<template>"], status: "当前保留" },
    { adopted: "Map<K, V>\r\n&amp;\r\n<template>", current: ["Map<K, V>", "&amp;", "<template>"], status: "当前保留" },
    { adopted: "Map<K, V>\r&amp;\r<template>", current: ["Map<K, V>", "&amp;", "<template>"], status: "当前保留" },
    { adopted: "Map<K, V>\n&amp;", current: ["&amp;", "Map<K, V>"], status: "后续已修改" },
    { adopted: "Map<K, V>\n&amp;", current: ["Map<K, V>", "&"], status: "后续已修改" },
    { adopted: "Map<K, V>\n<template>", current: ["Map<K, V>"], status: "后续已修改" },
    { adopted: "Map<K, V>", current: ["Map<K, V>", "<template>"], status: "后续已修改" },
    { adopted: "React\nReact", current: ["React"], status: "后续已修改" },
  ])("技能历史 $adopted 与当前 $current 的保留状态为 $status", async ({ adopted, current, status }) => {
    const { onApply, response } = await openSkillReport(["原技能"], current, adopted);
    expect((await screen.findByText(/已采纳写入/)).textContent).toContain(`· ${status} ·`);
    expect(screen.queryByRole("button", { name: "采纳写入" })).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
    expect(flushDraft).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(1);
    expect(response.current!.adoptions[0]!.value).toEqual(adopted);
  });

  it.each(["报告先返回", "投递先返回"])("深链接%s，提前打开时等待读全绑定信息，不额外读取最新报告", async (order) => {
    window.history.replaceState(null, "", "/?diagnosisId=7&applicationId=8");
    const diagnosis = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    const application = Promise.withResolvers<{ id: number; resume_id: number; resume_version_id: number; jd: string }>();
    vi.mocked(jsonFetch).mockImplementation((url, init) => {
      if (url === "/api/resumes/4/diagnose?diagnosis_id=7") return diagnosis.promise;
      if (url === "/api/applications/8") return application.promise;
      if (init?.method === "POST") return Promise.resolve(historyResponse());
      return Promise.resolve({ ...historyResponse(), current: { ...historyResponse().current, id: 99 } });
    });
    render(<DiagnoseDialog resumeId="4" modules={modules} onApply={vi.fn(() => true)} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(2);
    expect((screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement).disabled).toBe(true);
    const applicationResult = { id: 8, resume_id: 4, resume_version_id: 41, jd: "投递绑定的完整 JD" };
    await act(async () => {
      if (order === "报告先返回") diagnosis.resolve(historyResponse());
      else application.resolve(applicationResult);
    });
    expect(screen.queryByRole("textbox", { name: /改写草稿/ })).toBeNull();
    expect((screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      if (order === "报告先返回") application.resolve(applicationResult);
      else diagnosis.resolve(historyResponse());
    });
    await screen.findByRole("textbox", { name: /改写草稿/ });
    expect((screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement).value).toBe("41");
    fireEvent.click(screen.getByRole("button", { name: "按所选发布版本再次诊断" }));
    await waitFor(() => {
      const post = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ jd: applicationResult.jd, application_id: 8, resume_version_id: 41, job_id: "job-1" });
    });
    await waitFor(() => expect((screen.getByRole("button", { name: "按所选发布版本再次诊断" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("提前打开后深链接读取失败，释放忙碌状态并保留绑定错误", async () => {
    window.history.replaceState(null, "", "/?diagnosisId=7&applicationId=8");
    const diagnosis = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockImplementation((url) => url === "/api/applications/8"
      ? Promise.resolve({ id: 8, resume_id: 4, resume_version_id: 41, jd: "投递 JD" }) : diagnosis.promise);
    render(<DiagnoseDialog resumeId="4" modules={modules} onApply={vi.fn(() => true)} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await act(async () => diagnosis.reject(new Error("指定诊断读取失败")));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "指定诊断读取失败");
    expect((screen.getByRole("button", { name: "关闭" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "开始诊断" }) as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(2);
  });

  it.each(["成功", "失败"])("StrictMode 取消的初始读取晚到%s，不解除新读取的互斥状态", async (outcome) => {
    window.history.replaceState(null, "", "/?diagnosisId=7");
    const cancelled = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    const active = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(cancelled.promise).mockReturnValueOnce(active.promise);
    render(<React.StrictMode><DiagnoseDialog resumeId="4" modules={modules} onApply={vi.fn(() => true)} /></React.StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    const firstCall = vi.mocked(jsonFetch).mock.calls[0]!;
    expect(firstCall[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "成功") cancelled.resolve(historyResponse());
      else cancelled.reject(new Error("已取消的旧请求失败"));
    });
    expect((screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(2);
    await act(async () => active.resolve(historyResponse()));
    await screen.findByRole("textbox", { name: /改写草稿/ });
    expect((screen.getByRole("button", { name: "按所选发布版本再次诊断" }) as HTMLButtonElement).disabled).toBe(false);
  });

  async function openSnapshotReport(currentModules = modules, reportHistory = historyResponse().history) {
    const response = historyResponse();
    vi.mocked(jsonFetch).mockResolvedValueOnce({
      ...response,
      history: reportHistory,
      current: { ...response.current, resume_snapshot: { title: "简历", modules } },
    });
    const onApply = vi.fn(() => true);
    const view = render(<DiagnoseDialog resumeId="4" modules={currentModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await screen.findByRole("textbox", { name: /改写草稿/ });
    return { ...view, onApply };
  }

  async function openRichReport(field: "description" | "text", changed = false) {
    const targetModules: ModuleData[] = field === "description"
      ? [{ key: "target", type: "work", label: "工作经历", sort: 1, content: [{ id: "w1", company: "公司", title: "开发", description: "当前原文" }] }]
      : [{ key: "target", type: "summary", label: "自我评价", sort: 1, content: { text: "当前原文" } }];
    const response: DiagnosisHistoryResponse = {
      ...historyResponse(),
      current: {
        ...historyResponse().current,
        resume_snapshot: { title: "简历", modules: changed ? [] : targetModules },
        report: {
          ...historyResponse().current.report,
          modules: [{ ...historyResponse().current.report.modules[0]!, moduleKey: "target", suggestions: [{ itemId: field === "description" ? "w1" : "", field, reason: "突出成果", draft: "待采纳的<strong>草稿</strong>" }] }],
        },
      },
    };
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn(() => true);
    render(<DiagnoseDialog resumeId="4" modules={targetModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await screen.findByRole("textbox", { name: "改写草稿" });
    return { onApply, response };
  }

  async function openContentReport(type: "work" | "projects" | "education" | "summary", draft: string, plainText: boolean | "report" = false) {
    const targetModules: ModuleData[] = [{
      key: "target", type, label: "目标模块", sort: 1,
      content: type === "summary" ? { text: "原正文" } : [{
        id: "entry", company: "公司", title: "开发", name: "订单系统", role: "后端开发", school: "大学", description: "原正文",
      }],
    }];
    const field = type === "summary" ? "text" : "description";
    const response: DiagnosisHistoryResponse = {
      ...historyResponse(),
      current: {
        ...historyResponse().current,
        resume_snapshot: { title: "简历", modules: targetModules },
        report: {
          ...historyResponse().current.report,
          ...(plainText === "report" ? { textFormat: "plain-text" as const } : plainText ? { draftFormat: "plain-text" as const } : {}),
          modules: [{ ...historyResponse().current.report.modules[0]!, moduleKey: "target", suggestions: [
            { itemId: type === "summary" ? "" : "entry", field, reason: "表达优化", draft },
          ] }],
        },
      },
    };
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn<React.ComponentProps<typeof DiagnoseDialog>["onApply"]>(() => true);
    const view = render(<DiagnoseDialog resumeId="4" modules={targetModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await screen.findAllByRole("textbox", { name: /改写草稿/ });
    return { ...view, onApply, response, targetModules };
  }

  it.each((["work", "projects", "education", "summary"] as const).flatMap((type) => ([true, "report"] as const).map((format) => ({ type, format }))))("$type 格式 $format 新诊断纯文本草稿进入编辑器与采纳时保留泛型、标签和实体字面量", async ({ type, format }) => {
    const draft = "使用 Array<T> 与 <template>\r\n保留 &amp;、&lt;tag&gt; 和 <strong>字面</strong>";
    const view = await openContentReport(type, draft, format);
    const editors = screen.getAllByRole("textbox", { name: /改写草稿/ });
    expect(editors).toHaveLength(type === "summary" ? 1 : 2);
    expect(editors[0]!.textContent).toContain("Array<T> 与 <template>");
    expect(editors.at(-1)!.textContent).toContain("&amp;、&lt;tag&gt; 和 <strong>字面</strong>");
    for (const editor of editors) expect(editor.querySelector("strong, template")).toBeNull();

    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录暂不可用"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "重试记录" });
    expect(view.onApply).toHaveBeenCalledOnce();
    const value = view.onApply.mock.calls[0]![3] as string;
    expect(value).toContain("Array&lt;T&gt;");
    expect(value).toContain("&amp;amp;");
    const field = type === "summary" ? "text" : "description";
    const itemId = type === "summary" ? "" : "entry";
    const mod = view.targetModules[0]!;
    const content = writeDiagnosisValue(type, mod.content, itemId, value);
    const written = diagnosisValue([{ ...mod, content }], "target", { itemId, field, draft, reason: "" });
    expect(stripRichText(written as string)).toBe(draft.replace(/\r\n/g, "\n"));
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body)).value).toBe(value);

    // 恢复未经手动修改的默认草稿，不能再转义一次。
    vi.mocked(jsonFetch).mockResolvedValueOnce(view.response);
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    await screen.findAllByRole("textbox", { name: /改写草稿/ });
    expect(screen.getAllByRole("textbox", { name: /改写草稿/ })[0]!.textContent).toContain("Array<T>");
    expect(view.onApply).toHaveBeenCalledOnce();
  });

  it.each(["work", "summary"] as const)("%s 新报告的手动富文本编辑和失败恢复不重复转义", async (type) => {
    const view = await openContentReport(type, "支持 Map<K, V>", "report");
    const edited = "负责<strong>Map&lt;K, V&gt;</strong> 与 &amp;amp;";
    const editor = screen.getByRole("textbox", { name: "改写草稿" });
    editor.innerHTML = edited;
    fireEvent.input(editor);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "继续编辑草稿" });
    expect(view.onApply).toHaveBeenCalledExactlyOnceWith("target", type === "summary" ? "" : "entry", type === "summary" ? "text" : "description", edited);
    vi.mocked(jsonFetch).mockResolvedValueOnce(view.response);
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    expect((await screen.findByRole("textbox", { name: "改写草稿" })).innerHTML).toBe(edited);
  });

  it.each(["textFormat", "draftFormat"] as const)("纯文本格式标记 %s 不转义技能列表", async (field) => {
    const skills = ["Map<K, V>", "&amp;", "<template>"];
    const response: DiagnosisHistoryResponse = historyResponse();
    response.current!.report![field] = "plain-text";
    response.current!.report!.modules[0]!.suggestions[0]!.draft = skills;
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = openDialog();
    expect((await screen.findByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe(skills.join("\n"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", skills));
  });

  it.each([
    { type: "work", draft: "公司 | 开发" },
    { type: "projects", draft: "订单系统 | 后端开发" },
    { type: "summary", draft: "•" },
  ] as const)("$type 草稿整理后为空时保留原正文，补充正文后可重新采纳", async ({ type, draft }) => {
    const view = await openContentReport(type, draft);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "草稿整理后为空，请补充正文后重新采纳");
    expect(view.onApply).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(flushDraft).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /重试记录|重试保存并记录/ })).toBeNull();
    const editor = screen.getByRole("textbox", { name: /改写草稿/ });
    expect(editor.textContent).toBe(draft);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    editor.innerHTML = "负责<strong>接口联调</strong>";
    fireEvent.input(editor);
    vi.mocked(jsonFetch).mockResolvedValueOnce({
      ...view.response, current: { ...view.response.current!, adoptions: [
        { moduleKey: "target", suggestionIndex: 0, value: "负责<strong>接口联调</strong>", applied_at: "2026-10-27T00:00:00.000Z" },
      ] },
    });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledExactlyOnceWith("target", type === "summary" ? "" : "entry", type === "summary" ? "text" : "description", "负责<strong>接口联调</strong>");
  });

  it.each(["等待保存", "替换确认"])("%s期间经历信息变化后，按最新抬头规则检查空正文", async (phase) => {
    const view = await openContentReport("work", "星河科技");
    const pending = Promise.withResolvers<void>();
    const confirmation = Promise.withResolvers<boolean>();
    if (phase === "等待保存") flushDraft.mockReturnValueOnce(pending.promise);
    else {
      view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...view.targetModules[0]!, content: [{ id: "entry", company: "公司", title: "开发", description: "后来修改的正文" }] }]} onApply={view.onApply} />);
      vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    }
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    if (phase === "替换确认") await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...view.targetModules[0]!, content: [{
      id: "entry", company: "星河科技", title: "开发", description: phase === "等待保存" ? "原正文" : "后来修改的正文",
    }] }]} onApply={view.onApply} />);
    await act(async () => { pending.resolve(); confirmation.resolve(true); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "草稿整理后为空，请补充正文后重新采纳");
    expect(view.onApply).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it.each([
    { type: "education", draft: "项目：课程设计" },
    { type: "work", draft: "公司 | 开发\n负责接口联调" },
    { type: "projects", draft: "订单系统 | 后端开发\n负责接口联调" },
  ] as const)("$type 草稿按实际写入规则仍有正文时允许采纳", async ({ type, draft }) => {
    const view = await openContentReport(type, draft);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...view.response, current: { ...view.response.current!, adoptions: [
      { moduleKey: "target", suggestionIndex: 0, value: type === "education" ? draft : "负责接口联调", applied_at: "2026-10-27T00:00:00.000Z" },
    ] } });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledExactlyOnceWith("target", "entry", "description", draft);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["保存失败", "记录失败"])("采纳%s后可继续编辑原草稿，恢复编辑不写入，重新采纳仍需核对当前内容", async (phase) => {
    const view = await openSnapshotReport();
    const draft = "React\n此前手动改写";
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: draft } });
    if (phase === "保存失败") flushDraft.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("保存失败"));
    else vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "继续编辑草稿" });
    const requestCount = vi.mocked(jsonFetch).mock.calls.length;
    const saveCount = flushDraft.mock.calls.length;
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: ["后续手动编辑"] } }]} onApply={view.onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    expect((await screen.findByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe(draft);
    expect(screen.queryByRole("button", { name: /重试记录|重试保存并记录/ })).toBeNull();
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(requestCount + 1);
    expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toBe("/api/resumes/4/diagnose?diagnosis_id=7");
    expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.method).toBeUndefined();
    expect(flushDraft).toHaveBeenCalledTimes(saveCount);
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: "用户再次修改的草稿" } });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole("button", { name: "采纳写入" }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.onApply).toHaveBeenCalledOnce();
    const response = historyResponse(true);
    response.current.adoptions[0]!.value = ["用户再次修改的草稿"];
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledTimes(2);
    expect(view.onApply).toHaveBeenLastCalledWith("skills", "", "items", ["用户再次修改的草稿"]);
    expect(confirmDialog).toHaveBeenCalledTimes(2);
    const patch = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ diagnosis_id: 7, value: ["用户再次修改的草稿"] });
  });

  it.each(["description", "text"] as const)("%s待同步时继续编辑保留富文本，不重复写入", async (field) => {
    const { onApply, response } = await openRichReport(field);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("采纳记录未同步"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "继续编辑草稿" });
    const requestCount = vi.mocked(jsonFetch).mock.calls.length;
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    expect((await screen.findByRole("textbox", { name: "改写草稿" })).innerHTML).toBe("待采纳的<strong>草稿</strong>");
    expect(onApply).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(requestCount + 1);
    expect(flushDraft).toHaveBeenCalledTimes(2);
  });

  it("补记开始但状态尚未刷新时，继续编辑不会抢占在途记录", async () => {
    const view = await openSnapshotReport();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    const editButton = await screen.findByRole("button", { name: "继续编辑草稿" });
    const retryButton = screen.getByRole("button", { name: "重试记录" });
    const request = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(editButton);
    });
    expect(screen.queryByRole("textbox", { name: /改写草稿/ })).toBeNull();
    await act(async () => request.resolve(historyResponse(true)));
    await screen.findByText(/已采纳写入/);
    expect(screen.queryByRole("button", { name: "继续编辑草稿" })).toBeNull();
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
  });

  it("恢复一条建议编辑时保留另一条的待同步记录", async () => {
    const targetModules: ModuleData[] = [...modules, { ...modules[0]!, key: "skills-extra" }];
    const initial = historyResponse();
    const response = {
      ...initial,
      current: { ...initial.current, resume_snapshot: { title: "简历", modules: targetModules } },
    };
    response.current.report.modules.push({ ...response.current.report.modules[0]!, moduleKey: "skills-extra" });
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn(() => true);
    render(<DiagnoseDialog resumeId="4" modules={targetModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await screen.findAllByRole("textbox", { name: /改写草稿/ });
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("第一条记录失败"));
    fireEvent.click(screen.getAllByRole("button", { name: "采纳写入" })[0]!);
    await screen.findByRole("button", { name: "继续编辑草稿" });
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("第二条记录失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "继续编辑草稿" })).toHaveLength(2));
    const requestCount = vi.mocked(jsonFetch).mock.calls.length;
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    fireEvent.click(screen.getAllByRole("button", { name: "继续编辑草稿" })[0]!);
    expect(await screen.findAllByRole("textbox", { name: /改写草稿/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "重试记录" })).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(requestCount + 1);
    const confirmed = { ...response, current: { ...response.current, adoptions: [{ moduleKey: "skills-extra", suggestionIndex: 0, value: ["React", "TypeScript", "Node.js"], applied_at: "2026-10-26T10:00:00.000Z" }] } };
    vi.mocked(jsonFetch).mockResolvedValueOnce(confirmed);
    fireEvent.click(screen.getByRole("button", { name: "重试记录" }));
    await screen.findByText(/已采纳写入/);
    expect(screen.getByRole("textbox", { name: /改写草稿/ })).toBeTruthy();
    expect(onApply).toHaveBeenCalledTimes(2);
    const patch = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ module_key: "skills-extra" });
  });

  it("采纳请求报错但记录已落库时，继续编辑先读取确认，不重新开放已采纳建议", async () => {
    const view = await openSnapshotReport();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应中断"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "继续编辑草稿" });
    vi.mocked(jsonFetch).mockResolvedValueOnce(historyResponse(true));
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    await screen.findByText(/已采纳写入/);
    expect(screen.queryByRole("textbox", { name: /改写草稿/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续编辑草稿" })).toBeNull();
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(flushDraft).toHaveBeenCalledTimes(2);
    expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toBe("/api/resumes/4/diagnose?diagnosis_id=7");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["读取失败", "报告损坏"])("恢复编辑时%s保留待同步记录，可重新读取后恢复", async (outcome) => {
    const view = await openSnapshotReport();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录请求失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "继续编辑草稿" });
    if (outcome === "读取失败") vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("读取报告失败"));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({ ...historyResponse(), current: { ...historyResponse().current, report: null } });
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "继续编辑草稿" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("alert").textContent).toContain("无法恢复草稿编辑");
    expect(screen.getByRole("button", { name: "重试记录" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /改写草稿/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑草稿" }));
    await screen.findByRole("textbox", { name: /改写草稿/ });
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(flushDraft).toHaveBeenCalledTimes(2);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["description", "text"] as const)("采纳%s等待保存时锁定富文本和格式按钮，保存失败后恢复编辑", async (field) => {
    const { onApply } = await openRichReport(field);
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    const editor = screen.getByRole("textbox", { name: "改写草稿" });
    const locked = editor.getAttribute("contenteditable");
    const boldDisabled = (screen.getByRole("button", { name: "加粗文本" }) as HTMLButtonElement).disabled;
    const colorDisabled = (screen.getByRole("button", { name: "设置文字颜色" }) as HTMLButtonElement).disabled;
    await act(async () => saving.reject(new Error("保存失败")));
    expect(locked).toBe("false");
    expect(boldDisabled).toBe(true);
    expect(colorDisabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("保存失败");
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect((screen.getByRole("button", { name: "加粗文本" }) as HTMLButtonElement).disabled).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
    editor.innerHTML = "失败后<strong>继续编辑</strong>";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledExactlyOnceWith("target", field === "description" ? "w1" : "", field, "失败后<strong>继续编辑</strong>"));
    await screen.findByText(/已采纳写入/);
  });

  it("采纳等待确认期间锁定编辑，取消后保留草稿并恢复输入", async () => {
    const { onApply } = await openRichReport("text", true);
    const confirmation = Promise.withResolvers<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    const locked = screen.getByRole("textbox", { name: "改写草稿" }).getAttribute("contenteditable");
    await act(async () => confirmation.resolve(false));
    expect(locked).toBe("false");
    const editor = screen.getByRole("textbox", { name: "改写草稿" });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.innerHTML).toBe("待采纳的<strong>草稿</strong>");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("采纳开始但按钮状态尚未刷新时拦截晚到的输入、增删和移动，不改写草稿", async () => {
    await openRichReport("description");
    fireEvent.click(screen.getByRole("button", { name: "+ 添加一行描述" }));
    const first = screen.getByRole("textbox", { name: "改写草稿第 1 行" });
    const second = screen.getByRole("textbox", { name: "改写草稿第 2 行" });
    second.innerHTML = "第二行";
    fireEvent.input(second);
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    const applyButton = screen.getByRole("button", { name: "采纳写入" });
    const addButton = screen.getByRole("button", { name: "+ 添加一行描述" });
    const removeButton = screen.getByRole("button", { name: "删除第 1 行" });
    const moveButton = screen.getByRole("button", { name: "下移第 1 行" });
    act(() => {
      fireEvent.click(applyButton);
      first.innerHTML = "等待期间的意外输入";
      fireEvent.input(first);
      fireEvent.click(addButton);
      fireEvent.click(removeButton);
      fireEvent.click(moveButton);
    });
    await act(async () => saving.reject(new Error("保存失败")));
    expect(screen.queryByRole("textbox", { name: "改写草稿第 3 行" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "改写草稿第 1 行" }).innerHTML).toBe("待采纳的<strong>草稿</strong>");
    expect(screen.getByRole("textbox", { name: "改写草稿第 2 行" }).textContent).toBe("第二行");
  });

  it.each(["手动改写", "清空草稿"])("切换诊断历史保留%s，各报告草稿独立，返回后按当前草稿采纳", async (change) => {
    const history = [...historyResponse().history, { ...historyResponse().history[0]!, id: 8 }];
    const view = await openSnapshotReport(modules, history);
    const edited = change === "手动改写" ? "React\n手动补充的技能" : "";
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: edited } });
    const other = historyResponse();
    other.history = history;
    other.current.id = 8;
    other.current.report.modules[0]!.suggestions[0]!.draft = ["另一份报告的建议"];
    vi.mocked(jsonFetch).mockResolvedValueOnce(other);
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "8" } });
    await waitFor(() => expect((screen.getByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe("另一份报告的建议"));
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: "另一份报告的手动修改" } });
    vi.mocked(jsonFetch).mockResolvedValueOnce(historyResponse());
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "7" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "诊断历史" }) as HTMLSelectElement).value).toBe("7"));
    expect((screen.getByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe(edited);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    if (change === "手动改写") {
      await screen.findByText(/已采纳写入/);
      expect(view.onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", ["React", "手动补充的技能"]);
      const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ diagnosis_id: 7, value: ["React", "手动补充的技能"] });
    } else {
      expect(view.onApply).not.toHaveBeenCalled();
      expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    }
  });

  it("关闭后重开同一报告保留未采纳的改写草稿", async () => {
    await openSnapshotReport();
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: "重开后应保留的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "完成并关闭" }));
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await waitFor(() => expect((screen.getByRole("button", { name: "采纳写入" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe("重开后应保留的草稿");
  });

  it.each(["修改岗位 JD", "诊断新岗位", "再次诊断"])("%s后返回旧报告保留草稿，新报告使用本次生成内容", async (action) => {
    const history = [...historyResponse().history, { ...historyResponse().history[0]!, id: 8 }];
    await openSnapshotReport(modules, history);
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: "旧报告手动改写" } });
    const other = historyResponse();
    other.current.id = 8;
    other.current.report.modules[0]!.suggestions[0]!.draft = ["本次生成的新建议"];
    other.history = history;
    vi.mocked(jsonFetch).mockResolvedValueOnce(other);
    if (action === "再次诊断") fireEvent.click(screen.getByRole("button", { name: "按所选发布版本再次诊断" }));
    else {
      fireEvent.click(screen.getByRole("button", { name: action }));
      fireEvent.change(screen.getByRole("textbox", { name: "岗位要求（JD）" }), { target: { value: "新的 JD" } });
      fireEvent.click(screen.getByRole("button", { name: "开始诊断" }));
    }
    await waitFor(() => expect((screen.getByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe("本次生成的新建议"));
    vi.mocked(jsonFetch).mockResolvedValueOnce(historyResponse());
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "7" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "诊断历史" }) as HTMLSelectElement).value).toBe("7"));
    expect((screen.getByRole("textbox", { name: /改写草稿/ }) as HTMLTextAreaElement).value).toBe("旧报告手动改写");
  });

  it("分行富文本的编辑与顺序在切换报告后保留，采纳使用保留草稿", async () => {
    const workModules: ModuleData[] = [{ key: "work", type: "work", label: "工作经历", sort: 1, content: [{ id: "w1", company: "公司", title: "开发", description: "原文" }] }];
    const response = {
      ...historyResponse(),
      current: {
        ...historyResponse().current,
        resume_snapshot: { title: "简历", modules: workModules },
        report: {
          ...historyResponse().current.report,
          modules: [{ ...historyResponse().current.report.modules[0]!, moduleKey: "work", suggestions: [{ itemId: "w1", field: "description", reason: "突出成果", draft: "初始第一行\n初始第二行" }] }],
        },
      },
      history: [...historyResponse().history, { ...historyResponse().history[0]!, id: 8 }],
    };
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = vi.fn(() => true);
    render(<DiagnoseDialog resumeId="4" modules={workModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    const firstLine = await screen.findByRole("textbox", { name: "改写草稿第 1 行" });
    firstLine.innerHTML = "手动<strong>改写</strong>";
    fireEvent.input(firstLine);
    fireEvent.click(screen.getByRole("button", { name: "下移第 1 行" }));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, current: { ...response.current, id: 8 } });
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "8" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "诊断历史" }) as HTMLSelectElement).value).toBe("8"));
    expect(screen.getByRole("textbox", { name: "改写草稿第 1 行" }).textContent).toBe("初始第一行");
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "7" } });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "诊断历史" }) as HTMLSelectElement).value).toBe("7"));
    expect(screen.getByRole("textbox", { name: "改写草稿第 1 行" }).textContent).toBe("初始第二行");
    expect(screen.getByRole("textbox", { name: "改写草稿第 2 行" }).querySelector("strong")?.textContent).toBe("改写");
    const value = "初始第二行\n手动<strong>改写</strong>";
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, current: { ...response.current, adoptions: [{ moduleKey: "work", suggestionIndex: 0, value, applied_at: "2026-10-26T10:00:00.000Z" }] } });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByText(/已采纳写入/);
    expect(onApply).toHaveBeenCalledExactlyOnceWith("work", "w1", "description", value);
  });

  it.each(["保存请求失败", "仍有未保存内容"])("采纳写入后%s，重试只继续保存与记录", async (outcome) => {
    const view = await openSnapshotReport();
    const draft = ["React", "TypeScript", "Vite"];
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: draft.join("\n") } });
    flushDraft.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      if (outcome === "保存请求失败") throw new Error("保存请求失败");
      saveState.needsUnloadWarning = true;
    });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("尚未确认保存成功"));
    expect(screen.queryByRole("button", { name: "采纳写入" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /改写草稿/ })).toBeNull();
    expect(screen.queryByText(/简历已保存/)).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: draft } }]} onApply={view.onApply} />);
    saveState.needsUnloadWarning = false;
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    const retryButton = screen.getByRole("button", { name: "重试保存并记录" });
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });
    expect(screen.queryByText(/简历已保存/)).toBeNull();
    const response = historyResponse(true);
    response.current.adoptions[0]!.value = draft;
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    await act(async () => saving.resolve());
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", draft);
    expect(flushDraft).toHaveBeenCalledTimes(3);
    expect(confirmDialog).not.toHaveBeenCalled();
    const patches = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(JSON.parse(String(patches[0]![1]?.body))).toMatchObject({ diagnosis_id: 7, module_key: "skills", suggestion_index: 0, value: draft });
  });

  it("采纳写入后保存连续失败保持待保存，保存恢复后记录失败转为仅重试记录", async () => {
    const view = await openSnapshotReport();
    flushDraft.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("首次保存失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "重试保存并记录" });
    flushDraft.mockRejectedValueOnce(new Error("再次保存失败"));
    fireEvent.click(screen.getByRole("button", { name: "重试保存并记录" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("再次保存失败"));
    expect(screen.queryByText(/简历已保存/)).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录请求失败"));
    fireEvent.click(screen.getByRole("button", { name: "重试保存并记录" }));
    await screen.findByRole("button", { name: "重试记录" });
    expect(screen.getByRole("alert").textContent).toContain("简历已保存，但采纳记录未同步");
    expect(screen.queryByRole("button", { name: "重试保存并记录" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试记录" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(flushDraft).toHaveBeenCalledTimes(5);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
  });

  it("采纳写入后保存失败，期间手动修改内容的重试不再次替换目标", async () => {
    const view = await openSnapshotReport();
    flushDraft.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("保存失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "重试保存并记录" });
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: ["后续手动编辑"] } }]} onApply={view.onApply} />);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("采纳内容尚未保存或已被修改，请确认简历保存成功后重试"));
    fireEvent.click(screen.getByRole("button", { name: "重试保存并记录" }));
    await screen.findByRole("button", { name: "重试记录" });
    expect(screen.getByRole("alert").textContent).toContain("已被修改");
    expect(view.onApply).toHaveBeenCalledOnce();
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ value: ["React", "TypeScript", "Node.js"] });
    expect(screen.queryByText(/已采纳写入/)).toBeNull();
  });

  it("简历保存后记录失败，保留实际写入草稿，重试仅补记采纳", async () => {
    const view = await openSnapshotReport();
    const draft = ["React", "TypeScript", "Vite"];
    fireEvent.change(screen.getByRole("textbox", { name: /改写草稿/ }), { target: { value: draft.join("\n") } });
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录请求失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("简历已保存，但采纳记录未同步"));
    expect(screen.queryByRole("button", { name: "采纳写入" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /改写草稿/ })).toBeNull();
    expect(screen.getByText("Vite")).toBeTruthy();
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: draft } }]} onApply={view.onApply} />);
    const request = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    const retryButton = screen.getByRole("button", { name: "重试记录" });
    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });
    const response = historyResponse(true);
    response.current.adoptions[0]!.value = draft;
    await act(async () => request.resolve(response));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", draft);
    expect(flushDraft).toHaveBeenCalledTimes(3);
    expect(confirmDialog).not.toHaveBeenCalled();
    const patches = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(String(patches[1]![1]?.body))).toMatchObject({ diagnosis_id: 7, module_key: "skills", suggestion_index: 0, value: draft });
  });

  it.each(["保存失败", "内容变化"])("补记采纳时%s，保留重试入口且不重新覆盖内容", async (outcome) => {
    const view = await openSnapshotReport();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录请求失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "重试记录" });
    const currentModules = [{ ...modules[0]!, content: { items: ["后续手动编辑"] } }];
    view.rerender(<DiagnoseDialog resumeId="4" modules={currentModules} onApply={view.onApply} />);
    if (outcome === "保存失败") flushDraft.mockRejectedValueOnce(new Error("保存失败"));
    else vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("采纳内容尚未保存或已被修改，请确认简历保存成功后重试"));
    fireEvent.click(screen.getByRole("button", { name: "重试记录" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining(outcome === "保存失败" ? "保存失败" : "已被修改"));
    await waitFor(() => expect((screen.getByRole("button", { name: "重试记录" }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(screen.queryByText(/已采纳写入/)).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(outcome === "保存失败" ? 1 : 2);
  });

  it("切换历史报告不混用待同步记录，返回原报告仍可补记", async () => {
    const reportHistory = [...historyResponse().history, { ...historyResponse().history[0]!, id: 8 }];
    const view = await openSnapshotReport(modules, reportHistory);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("记录请求失败"));
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByRole("button", { name: "重试记录" });
    const other = historyResponse();
    other.current.id = 8;
    other.history = reportHistory;
    vi.mocked(jsonFetch).mockResolvedValueOnce(other);
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "8" } });
    await screen.findByRole("button", { name: "采纳写入" });
    expect(screen.queryByRole("button", { name: "重试记录" })).toBeNull();
    vi.mocked(jsonFetch).mockResolvedValueOnce(historyResponse());
    fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "7" } });
    await screen.findByRole("button", { name: "重试记录" });
    fireEvent.click(screen.getByRole("button", { name: "重试记录" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledOnce();
    const patches = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(JSON.parse(String(patches[1]![1]?.body))).toMatchObject({ diagnosis_id: 7 });
  });

  it("按钮状态刷新前重复采纳只写入一次，不重复保存和记录", async () => {
    const view = await openSnapshotReport();
    const saving = Promise.withResolvers<void>();
    flushDraft.mockImplementation(() => saving.promise);
    const applyButton = screen.getByRole("button", { name: "采纳写入" });
    act(() => {
      fireEvent.click(applyButton);
      fireEvent.click(applyButton);
    });
    const initialSaveCount = flushDraft.mock.calls.length;
    await act(async () => saving.resolve());
    await screen.findByText(/已采纳写入/);
    expect(initialSaveCount).toBe(1);
    expect(flushDraft).toHaveBeenCalledTimes(2);
    expect(view.onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", ["React", "TypeScript", "Node.js"]);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("按钮状态刷新前重复诊断只提交一次，完成后仍可再次生成", async () => {
    await openSnapshotReport();
    const request = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockReturnValueOnce(request.promise);
    const generateButton = screen.getByRole("button", { name: "按所选发布版本再次诊断" });
    act(() => {
      fireEvent.click(generateButton);
      fireEvent.click(generateButton);
    });
    const postCount = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST").length;
    await act(async () => request.resolve(historyResponse()));
    expect(postCount).toBe(1);
    expect((screen.getByRole("button", { name: "按所选发布版本再次诊断" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "按所选发布版本再次诊断" }));
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
    await waitFor(() => expect((screen.getByRole("button", { name: "按所选发布版本再次诊断" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("开始采纳后、状态刷新前触发诊断和历史读取也不会插入新任务", async () => {
    const view = await openSnapshotReport();
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    const applyButton = screen.getByRole("button", { name: "采纳写入" });
    const generateButton = screen.getByRole("button", { name: "按所选发布版本再次诊断" });
    const historySelect = screen.getByRole("combobox", { name: "诊断历史" });
    act(() => {
      fireEvent.click(applyButton);
      fireEvent.click(generateButton);
      fireEvent.change(historySelect, { target: { value: "7" } });
    });
    await act(async () => saving.resolve());
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => !init?.method)).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["保存失败", "取消确认"])("采纳因%s结束后释放互斥状态，可以重试", async (outcome) => {
    const view = await openSnapshotReport([{ ...modules[0]!, content: { items: ["后续编辑"] } }]);
    if (outcome === "保存失败") flushDraft.mockRejectedValueOnce(new Error("保存失败"));
    else vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    if (outcome === "保存失败") expect(await screen.findByRole("alert")).toHaveProperty("textContent", "保存失败");
    await waitFor(() => expect((screen.getByRole("button", { name: "采纳写入" }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["修改目标", "删除目标"])("等待保存期间%s后使用最新内容检查，不直接覆盖", async (change) => {
    const view = await openSnapshotReport();
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    const currentModules = change === "删除目标" ? [] : [{ ...modules[0]!, content: { items: ["最新手动编辑"] } }];
    view.rerender(<DiagnoseDialog resumeId="4" modules={currentModules} onApply={view.onApply} />);
    await act(async () => saving.resolve());
    if (change === "删除目标") {
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", "目标模块或条目已被删除，无法写入");
      expect(confirmDialog).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
      expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "确认替换当前内容" }));
    }
    expect(view.onApply).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    await waitFor(() => expect((screen.getByRole("button", { name: "采纳写入" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("等待保存期间写入回调更新后，使用当前回调采纳", async () => {
    const view = await openSnapshotReport();
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    const currentApply = vi.fn(() => true);
    view.rerender(<DiagnoseDialog resumeId="4" modules={modules} onApply={currentApply} />);
    await act(async () => saving.resolve());
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).not.toHaveBeenCalled();
    expect(currentApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", ["React", "TypeScript", "Node.js"]);
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it.each(["卸载", "切换简历"])("等待保存期间%s后不再采纳旧简历建议", async (action) => {
    const view = await openSnapshotReport();
    const saving = Promise.withResolvers<void>();
    flushDraft.mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    if (action === "卸载") view.unmount();
    else view.rerender(<DiagnoseDialog resumeId="5" modules={modules} onApply={view.onApply} />);
    await act(async () => saving.resolve());
    expect(view.onApply).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it.each((["历史读取", "重新诊断"] as const).flatMap((kind) => ["成功", "失败"].flatMap((outcome) => [false, true].map((returnToOriginal) => ({ kind, outcome, returnToOriginal })))))("$kind 旧请求晚到$outcome，切回原简历=$returnToOriginal 时不污染报告或解除新请求锁", async ({ kind, outcome, returnToOriginal }) => {
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: [...resumeOptions, { ...resumeOptions[0]!, id: 5 }], resumesError: "", reloadResumes: vi.fn() });
    const view = await openSnapshotReport();
    const oldRequest = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(oldRequest.promise);
    if (kind === "历史读取") fireEvent.change(screen.getByRole("combobox", { name: "诊断历史" }), { target: { value: "7" } });
    else fireEvent.click(screen.getByRole("button", { name: "按所选发布版本再次诊断" }));
    view.rerender(<DiagnoseDialog resumeId="5" modules={modules} onApply={view.onApply} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    if (returnToOriginal) view.rerender(<DiagnoseDialog resumeId="4" modules={modules} onApply={view.onApply} />);
    const newRequest = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(newRequest.promise);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    const newCall = vi.mocked(jsonFetch).mock.calls.at(-1)!;
    expect(newCall[0]).toBe(`/api/resumes/${returnToOriginal ? "4" : "5"}/diagnose`);
    await act(async () => {
      if (outcome === "成功") oldRequest.resolve(historyResponse());
      else oldRequest.reject(new Error("旧简历请求失败"));
    });
    expect(screen.queryByText("整体匹配良好")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement).disabled).toBe(true);
    const next = historyResponse();
    next.current.id = 8;
    next.current.report.summary = "新简历的诊断报告";
    next.current.jd = "新简历 JD";
    await act(async () => newRequest.resolve(next));
    await screen.findByText("新简历的诊断报告");
    expect(screen.queryByText("整体匹配良好")).toBeNull();
    expect(view.onApply).not.toHaveBeenCalled();
  });

  it.each(["卸载", "切换简历"] as const)("写入简历后第二次保存等待期间%s，不发送旧简历采纳请求", async (action) => {
    const view = await openSnapshotReport();
    const saving = Promise.withResolvers<void>();
    flushDraft.mockResolvedValueOnce(undefined).mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(view.onApply).toHaveBeenCalledOnce());
    expect(screen.getByText("改写草稿（已写入，待保存并记录）")).toBeTruthy();
    if (action === "卸载") view.unmount();
    else view.rerender(<DiagnoseDialog resumeId="5" modules={modules} onApply={view.onApply} />);
    await act(async () => saving.resolve());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    if (action === "切换简历") {
      view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: ["React", "TypeScript", "Node.js"] } }]} onApply={view.onApply} />);
      fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
      await waitFor(() => expect(screen.getByRole("button", { name: "重试记录" })).toBeTruthy());
      expect(screen.getByText("改写草稿（已保存，待同步采纳记录）")).toBeTruthy();
      vi.mocked(jsonFetch).mockResolvedValueOnce(historyResponse(true));
      fireEvent.click(screen.getByRole("button", { name: "重试记录" }));
      await screen.findByText(/已采纳写入/);
      expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
      expect(view.onApply).toHaveBeenCalledOnce();
    }
  });

  it("切换简历期间采纳响应成功也保留待同步项，返回后幂等重试确认", async () => {
    const view = await openSnapshotReport();
    const request = Promise.withResolvers<ReturnType<typeof historyResponse>>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("改写草稿（已保存，待同步采纳记录）")).toBeTruthy());
    view.rerender(<DiagnoseDialog resumeId="5" modules={modules} onApply={view.onApply} />);
    await act(async () => request.resolve(historyResponse(true)));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    view.rerender(<DiagnoseDialog resumeId="4" modules={[{ ...modules[0]!, content: { items: ["React", "TypeScript", "Node.js"] } }]} onApply={view.onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重试记录" })).toBeTruthy());
    expect(screen.getByText("改写草稿（已保存，待同步采纳记录）")).toBeTruthy();
    vi.mocked(jsonFetch).mockResolvedValueOnce(historyResponse(true));
    fireEvent.click(screen.getByRole("button", { name: "重试记录" }));
    await screen.findByText(/已采纳写入/);
    expect(view.onApply).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
  });

  it.each(["修改目标", "删除目标", "只改其他模块"])("替换确认期间%s，写入前再次核对目标", async (change) => {
    const beforeConfirm = [{ ...modules[0]!, content: { items: ["确认前的当前内容"] } }];
    const view = await openSnapshotReport(beforeConfirm);
    const confirmation = Promise.withResolvers<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    const currentModules = change === "删除目标" ? [] : change === "修改目标"
      ? [{ ...modules[0]!, content: { items: ["确认期间再次编辑"] } }]
      : [...beforeConfirm, { ...modules[0]!, key: "skills-other", content: { items: ["其他模块编辑"] } }];
    view.rerender(<DiagnoseDialog resumeId="4" modules={currentModules} onApply={view.onApply} />);
    await act(async () => confirmation.resolve(true));
    if (change === "只改其他模块") {
      await screen.findByText(/已采纳写入/);
      expect(view.onApply).toHaveBeenCalledExactlyOnceWith("skills", "", "items", ["React", "TypeScript", "Node.js"]);
    } else {
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", change === "删除目标"
        ? "目标模块或条目已被删除，无法写入" : "确认期间目标内容已变化，请重新采纳并核对");
      expect(view.onApply).not.toHaveBeenCalled();
      expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    }
  });

  it("点击触发按钮后打开诊断报告并渲染总体评价与改写草稿", async () => {
    await openReport();

    expect(screen.getByText("总体评价")).toBeTruthy();
    expect(screen.getByText("整体匹配良好")).toBeTruthy();
    expect(screen.getByText("缺少 Node.js 相关技能")).toBeTruthy();
    expect(screen.getByRole("button", { name: "采纳写入" })).toBeTruthy();
  });

  it("点击采纳写入回调 onApply 并以 diagnosis_id 回写 PATCH", async () => {
    const onApply = await openReport();

    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith("skills", "", "items", ["React", "TypeScript", "Node.js"]);
    });
    await waitFor(() => {
      const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
        diagnosis_id: 7,
        module_key: "skills",
        suggestion_index: 0,
      });
    });
    // PATCH 结果回填后该建议标记为已采纳
    expect(await screen.findByText(/已采纳写入/)).toBeTruthy();
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith(expect.objectContaining({ title: "确认替换当前内容" }));
  });

  it("编辑改写草稿后采纳，onApply 收到编辑后的草稿内容", async () => {
    const onApply = await openReport();

    const draft = screen.getByRole("textbox", { name: /改写草稿/ });
    fireEvent.change(draft, { target: { value: "React\nTypeScript\nNode.js\nVite" } });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith("skills", "", "items", ["React", "TypeScript", "Node.js", "Vite"]);
    });
  });

  it.each([
    "Map<K, V> 与 <template>",
    "&amp;、&lt;T&gt; 与 &amp;lt;",
    "第一行技术依据\r\n第二行职责限定",
    '<strong>字面标签</strong> 与 <script>alert("仅为文本")</script>',
  ])("新报告的总评、差距和理由保留纯文本 %s", async (literal) => {
    const raw = {
      match: 7, summary: `总评：${literal}`, modules: [{
        module_key: "skills", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 },
        gaps: `差距：${literal}`, suggestions: [{ item_id: "", field: "items", reason: `理由：${literal}`, draft: ["React"] }],
      }],
    };
    const response: DiagnosisHistoryResponse = historyResponse();
    response.current!.report = validateGeneratedDiagnosis(raw, modules);
    const originalReport = structuredClone(response.current!.report);
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const onApply = openDialog();
    await screen.findByText("总体评价");
    for (const prefix of ["总评：", "差距：", "建议：理由："]) {
      const node = screen.getByText((_, element) => element?.tagName === "P" && element.textContent === `${prefix}${literal}`);
      expect(node.querySelector("strong, template, script")).toBeNull();
      expect(node.className).toContain("whitespace-pre-wrap");
    }
    expect(response.current!.report).toEqual(originalReport);
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each([false, true])("历史报告 draftFormat=%s 的原文与说明仍支持富文本", async (marked) => {
    const richWorkModules: ModuleData[] = [
      {
        key: "work_1",
        type: "work",
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "资深开发",
            description: "核心耗时[待确认示例：<strong>从2.5s降至0.8s</strong>]",
          },
        ],
      },
    ];

    vi.mocked(jsonFetch).mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/resumes/4/diagnose")) {
        return {
          current: {
            id: 8,
            job_id: "job-2",
            job_title: "Java工程师",
            jd: "JD",
            resume_version_id: 41,
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [],
            resume_snapshot: {
              title: "我的简历",
              modules: richWorkModules,
            },
            report: {
              ...(marked ? { draftFormat: "plain-text" } : {}),
              match: 7,
              summary: "<strong>整体表现尚可</strong>",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 },
                  gaps: "包含重要指标 <strong>从2.5s降至0.8s</strong> 与 &lt;strong&gt;转义&lt;/strong&gt;",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "优化<strong>表达</strong>",
                      draft: "优化后的工作内容",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      throw new Error(`unexpected GET: ${url}`);
    });

    render(<DiagnoseDialog resumeId="4" modules={richWorkModules} onApply={vi.fn(() => true)} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));

    // 等待报告渲染出来
    await screen.findByText("总体评价");

    // 1. 诊断时原文中渲染出 <strong> 标签
    const boldNodes = screen.getAllByText("从2.5s降至0.8s");
    expect(boldNodes.some((el) => el.tagName === "STRONG")).toBe(true);

    // 2. gaps 的真实标签正常渲染，转义标签只显示为字面文本。
    const gaps = screen.getByText(/<strong>转义<\/strong>/);
    expect(gaps.textContent).toContain("与 <strong>转义</strong>");
    expect(gaps.querySelectorAll("strong")).toHaveLength(1);
    expect(gaps.querySelector("strong")?.textContent).toBe("从2.5s降至0.8s");

    // 3. 总体评价 summary 也渲染出 <strong>
    const summaryBold = screen.getByText("整体表现尚可");
    expect(summaryBold.tagName).toBe("STRONG");

    // 确保没有把 <strong> 当纯文本输出在界面上
    expect(screen.queryByText(/<strong>从2.5s降至0.8s<\/strong>/)).toBeNull();
  });

  it("改写草稿支持富文本编辑并在采纳后将富文本写入简历", async () => {
    const onApply = vi.fn(() => true);
    const workModules: ModuleData[] = [
      {
        key: "work_1",
        type: "work",
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "开发",
            description: "旧工作描述",
          },
        ],
      },
    ];

    vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return {
          current: {
            id: 9,
            job_id: "job-3",
            job_title: "前端",
            jd: "JD",
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [
              {
                moduleKey: "work_1",
                suggestionIndex: 0,
                value: "优化后<strong>核心业务</strong>达成",
                applied_at: "2026-09-27T11:00:00.000Z",
              },
            ],
            resume_snapshot: { title: "简历", modules: workModules },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需突出业务核心",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "对齐 JD",
                      draft: "优化后工作描述",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      if (String(url).startsWith("/api/resumes/4/diagnose")) {
        return {
          current: {
            id: 9,
            job_id: "job-3",
            job_title: "前端",
            jd: "JD",
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [],
            resume_snapshot: { title: "简历", modules: workModules },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需突出业务核心",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "对齐 JD",
                      draft: "优化后工作描述",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<DiagnoseDialog resumeId="4" modules={workModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));

    // 等待编辑器加载
    const richEditor = await screen.findByRole("textbox", { name: "改写草稿" });
    expect(richEditor).toBeTruthy();

    // 模拟在富文本编辑器中输入包含 <strong> 标签的内容
    richEditor.innerHTML = "优化后<strong>核心业务</strong>达成";
    fireEvent.input(richEditor);

    // 点击采纳写入
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    // 验证 onApply 收到带富文本 HTML 的值
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith("work_1", "w1", "description", "优化后<strong>核心业务</strong>达成");
    });

    // 验证已采纳状态下富文本渲染成功（显示加粗核心业务）
    await screen.findByText(/已采纳写入/);
    const adoptedBold = screen.getByText("核心业务");
    expect(adoptedBold.tagName).toBe("STRONG");
    expect(screen.queryByText(/<strong>核心业务<\/strong>/)).toBeNull();
  });

  it("经历多行描述在改写草稿中按多行独立编辑，支持新增、调序、删除与合并采纳", async () => {
    const onApply = vi.fn(() => true);
    const workModules: ModuleData[] = [
      {
        key: "work_1",
        type: "work",
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "开发",
            description: "旧工作描述第1行\n旧工作描述第2行",
          },
        ],
      },
    ];

    vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return {
          current: {
            id: 10,
            job_id: "job-3",
            job_title: "前端工程师",
            jd: "JD",
            resume_version_id: 41,
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [
              {
                moduleKey: "work_1",
                suggestionIndex: 0,
                value: "优化后第2行\n优化后第1行\n新增第3行",
                applied_at: "2026-09-27T11:00:00.000Z",
              },
            ],
            resume_snapshot: { title: "简历", modules: [] },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需补充",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "分行细化描述",
                      draft: "草稿第1行\n草稿第2行",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      if (String(url).startsWith("/api/resumes/4/diagnose")) {
        return {
          current: {
            id: 10,
            job_id: "job-3",
            job_title: "前端工程师",
            jd: "JD",
            resume_version_id: 41,
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [],
            resume_snapshot: {
              title: "简历",
              modules: workModules,
            },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需补充",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "分行细化描述",
                      draft: "草稿第1行\n草稿第2行",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<DiagnoseDialog resumeId="4" modules={workModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));

    // 原文多行应按多行列表展示
    expect(await screen.findByText("旧工作描述第1行")).toBeTruthy();
    expect(screen.getByText("旧工作描述第2行")).toBeTruthy();

    // 改写草稿初始包含两行独立的富文本编辑框
    const line1 = await screen.findByRole("textbox", { name: "改写草稿第 1 行" });
    const line2 = screen.getByRole("textbox", { name: "改写草稿第 2 行" });
    expect(line1).toBeTruthy();
    expect(line2).toBeTruthy();

    // 交互：点击“+ 添加一行描述”增加第 3 行
    fireEvent.click(screen.getByRole("button", { name: "+ 添加一行描述" }));
    const line3 = await screen.findByRole("textbox", { name: "改写草稿第 3 行" });
    expect(line3).toBeTruthy();

    // 交互：在第 3 行输入内容
    line3.innerHTML = "新增第3行";
    fireEvent.input(line3);

    // 交互：将第 2 行上移到第 1 行
    const upButtons = screen.getAllByRole("button", { name: /上移第 2 行/ });
    fireEvent.click(upButtons[0]!);

    // 修改原来第 1 行（现在是第 2 行）和原来第 2 行（现在是第 1 行）的内容
    const currentLine1 = screen.getByRole("textbox", { name: "改写草稿第 1 行" });
    currentLine1.innerHTML = "优化后第2行";
    fireEvent.input(currentLine1);

    const currentLine2 = screen.getByRole("textbox", { name: "改写草稿第 2 行" });
    currentLine2.innerHTML = "优化后第1行";
    fireEvent.input(currentLine2);

    // 点击采纳写入
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    // 验证 onApply 收到换行合并后的多行描述
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith(
        "work_1",
        "w1",
        "description",
        "优化后第2行\n优化后第1行\n新增第3行"
      );
    });

    // 采纳后展示区域也以多行形式渲染采纳内容
    expect(await screen.findByText("优化后第2行")).toBeTruthy();
    expect(screen.getByText("优化后第1行")).toBeTruthy();
    expect(screen.getByText("新增第3行")).toBeTruthy();
  });
});
