// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PreparationRecordDialog } from "../preparation-record-dialog";
import { jsonFetch } from "@/lib/fetcher";
import type { DiagnosisHistoryResponse, DiagnosisReport } from "@/lib/diagnosis";
import type { PreparationResource } from "@/lib/application-preparation-types";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const record: PreparationResource = { id: 7, title: "前端诊断", summary: "", created_at: "", resume_id: 4, href: null, linked: true };
const notebook = { question: "当前题目", answer: "原答 Array<T>", comment: "点评 &amp;", reference: "参考 <template>" };
function response(summary = "当前报告"): DiagnosisHistoryResponse {
  return { current: { id: 7, job_id: "job-1", job_title: "前端", jd: "JD", created_at: "", resume_version_id: 41,
    adoptions: [], resume_snapshot: { title: "简历", modules: [] },
    report: { textFormat: "plain-text", match: 7, summary, modules: [{ moduleKey: "work", label: "工作经历",
      scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "差距说明",
      suggestions: [{ itemId: "w1", field: "description", reason: "修改理由", draft: "改写正文" }],
    }] },
  }, previous: null, history: [] };
}
const props = { kind: "diagnosis" as const, record, applicationId: 8, onClose: vi.fn() };

beforeEach(() => { vi.mocked(jsonFetch).mockReset(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(["新纯文本", "旧纯文本草稿", "历史富文本"])("%s 报告按字段格式显示，保留换行和技术字面量", async (format) => {
  const result = response();
  const report = result.current!.report!;
  delete report.textFormat;
  if (format === "新纯文本") report.textFormat = "plain-text";
  if (format === "旧纯文本草稿") report.draftFormat = "plain-text";
  const literal = "Map<K, V>、<template>、&amp;、&lt;T&gt;\n<strong>字面</strong>";
  const rich = '<strong>历史重点</strong>与 Map&lt;K, V&gt;、&amp; 与 &lt;strong&gt;字面&lt;/strong&gt;\n第二行';
  const annotation = format === "新纯文本" ? literal : rich;
  report.summary = `总评：${annotation}`;
  report.modules[0]!.gaps = `差距：${annotation}`;
  report.modules[0]!.suggestions[0]!.reason = `理由：${annotation}`;
  report.modules[0]!.suggestions[0]!.draft = format === "历史富文本" ? rich : literal;
  const original = structuredClone(result);
  vi.mocked(jsonFetch).mockResolvedValueOnce(result);
  render(<PreparationRecordDialog {...props} />);
  await screen.findByRole("link", { name: "到简历中采纳建议" });
  for (const prefix of ["总评：", "差距：", "理由："]) {
    const node = screen.getByText((_, element) => (element?.tagName === "P" || element?.tagName === "SUMMARY")
      && element.textContent?.startsWith(prefix) === true);
    expect(node.className).toContain("whitespace-pre-wrap");
    if (format === "新纯文本") {
      expect(node.textContent).toBe(`${prefix}${literal}`);
      expect(node.querySelector("strong, template")).toBeNull();
    } else {
      expect(node.querySelector("strong")?.textContent).toBe("历史重点");
      expect(node.textContent).toContain("Map<K, V>、& 与 <strong>字面</strong>");
    }
  }
  const draft = screen.getByText((_, element) => element?.tagName === "P" && element.className.includes("rounded-lg"));
  if (format === "历史富文本") expect(draft.querySelector("strong")?.textContent).toBe("历史重点");
  else {
    expect(draft.textContent).toBe(literal);
    expect(draft.querySelector("strong, template")).toBeNull();
  }
  expect(screen.getByRole("link", { name: "到简历中采纳建议" }).getAttribute("href")).toBe("/resumes/4?diagnosisId=7&applicationId=8");
  expect(result).toEqual(original);
});

it.each([{}, { draftFormat: "plain-text" }, { textFormat: "plain-text" }] satisfies Partial<DiagnosisReport>[])("技能列表在格式 %j 下仍按纯文本显示", async (format) => {
  const result = response();
  delete result.current!.report!.textFormat;
  Object.assign(result.current!.report!, format);
  result.current!.report!.modules[0]!.suggestions[0] = { itemId: "", field: "items", reason: "技能建议", draft: ["Array<T>", "<strong>React</strong>", "&amp;"] };
  vi.mocked(jsonFetch).mockResolvedValueOnce(result);
  render(<PreparationRecordDialog {...props} />);
  const node = await screen.findByText("Array<T> <strong>React</strong> &amp;");
  expect(node.textContent).toBe("Array<T>\n<strong>React</strong>\n&amp;");
  expect(node.querySelector("strong")).toBeNull();
});

it.each(["报告 ID", "简历 ID", "投递 ID", "记录类型"])("切换%s 后立即隐藏旧报告与采纳链接，只显示新记录", async (change) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response("先前报告"));
  const next = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(next.promise);
  const view = render(<PreparationRecordDialog {...props} />);
  await screen.findByText("先前报告");
  const nextProps = { ...props, kind: change === "记录类型" ? "notebook" as const : "diagnosis" as const,
    applicationId: change === "投递 ID" ? 9 : 8,
    record: { ...record, id: change === "报告 ID" ? 9 : 7, resume_id: change === "简历 ID" ? 5 : 4 } };
  view.rerender(<PreparationRecordDialog {...nextProps} />);
  expect(screen.queryByText("先前报告")).toBeNull();
  expect(screen.queryByRole("link", { name: "到简历中采纳建议" })).toBeNull();
  await act(async () => next.resolve(change === "记录类型" ? notebook : response("新的报告")));
  await screen.findByText(change === "记录类型" ? notebook.question : "新的报告");
  if (change === "记录类型") {
    expect(screen.queryByRole("link", { name: "到简历中采纳建议" })).toBeNull();
    expect(screen.getByText(notebook.answer)).toBeTruthy();
  } else expect(screen.getByRole("link", { name: "到简历中采纳建议" }).getAttribute("href"))
    .toBe(`/resumes/${nextProps.record.resume_id}?diagnosisId=${nextProps.record.id}&applicationId=${nextProps.applicationId}`);
});

it.each(["成功", "失败"].flatMap((outcome) => [false, true].map((activeFirst) => ({ outcome, activeFirst }))))("取消的旧请求晚到$outcome、当前已完成=$activeFirst 时不污染当前报告", async ({ outcome, activeFirst }) => {
  const old = Promise.withResolvers<unknown>();
  const active = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(active.promise);
  const view = render(<PreparationRecordDialog {...props} />);
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  view.rerender(<PreparationRecordDialog {...props} record={{ ...record, id: 9 }} />);
  expect(signal?.aborted).toBe(true);
  if (activeFirst) {
    await act(async () => active.resolve(response("新的报告")));
    await screen.findByText("新的报告");
  }
  await act(async () => {
    if (outcome === "成功") old.resolve(response("旧请求报告"));
    else old.reject(new Error("旧请求失败"));
  });
  expect(screen.queryByText("旧请求报告")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  if (!activeFirst) {
    expect(screen.queryByRole("link")).toBeNull();
    await act(async () => active.resolve(response("新的报告")));
    await screen.findByText("新的报告");
  } else expect(screen.getByText("新的报告")).toBeTruthy();
  expect(screen.getByRole("link", { name: "到简历中采纳建议" }).getAttribute("href"))
    .toBe("/resumes/4?diagnosisId=9&applicationId=8");
});

it("从错题切回诊断时不保留旧问答，晚到的错题响应不能覆盖报告", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response("诊断内容"));
  const view = render(<PreparationRecordDialog {...props} kind="notebook" />);
  view.rerender(<PreparationRecordDialog {...props} />);
  await screen.findByText("诊断内容");
  await act(async () => pending.resolve(notebook));
  expect(screen.queryByText(notebook.question)).toBeNull();
  expect(screen.queryByText(notebook.answer)).toBeNull();
  expect(screen.getByText("诊断内容")).toBeTruthy();
});

it("切换到损坏报告时只显示恢复说明，不沿用旧报告或采纳链接", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response("旧的完整报告"));
  const view = render(<PreparationRecordDialog {...props} />);
  await screen.findByText("旧的完整报告");
  const damaged = response();
  damaged.current!.report = null;
  vi.mocked(jsonFetch).mockResolvedValueOnce(damaged);
  view.rerender(<PreparationRecordDialog {...props} record={{ ...record, id: 9 }} />);
  await screen.findByText("报告无法读取，可返回准备页重新诊断。");
  expect(screen.queryByText("旧的完整报告")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("上一记录读取失败后切换新记录不保留旧错误，当前失败可重试", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("上一记录失败")).mockRejectedValueOnce(new Error("本次读取失败"));
  const view = render(<PreparationRecordDialog {...props} />);
  expect((await screen.findByRole("alert")).textContent).toContain("上一记录失败");
  view.rerender(<PreparationRecordDialog {...props} record={{ ...record, id: 9 }} />);
  expect(screen.queryByText(/上一记录失败/)).toBeNull();
  expect((await screen.findByRole("alert")).textContent).toContain("本次读取失败");
  vi.mocked(jsonFetch).mockResolvedValueOnce(response("重试成功"));
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("重试成功");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)![0]).toBe("/api/resumes/4/diagnose?diagnosis_id=9");
});
