// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DiagnosisChanges } from "../diagnosis-changes";
import type { DiagnosisRecord } from "@/lib/diagnosis";

function record(id: number): DiagnosisRecord {
  return { id, job_id: "job-1", job_title: "前端", jd: "JD", created_at: "2026-10-27T00:00:00.000Z", adoptions: [],
    report: { match: 7, summary: "诊断", modules: [] },
    resume_snapshot: { title: "简历", modules: [{ key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["Array<T>"] } }] },
  };
}
afterEach(cleanup);

it("上次快照不可用时不把空占位内容展示成新增或删除", () => {
  const previous = record(1);
  previous.report = null;
  Object.assign(previous, { corruptedFields: ["resume_snapshot"], resume_snapshot: { title: "", modules: [] } });
  const current = record(2);
  render(<DiagnosisChanges current={current} previous={previous} modules={current.resume_snapshot.modules} />);
  expect(screen.queryByText(/两次诊断间的内容变化/)).toBeNull();
  expect(screen.getByText("上次诊断快照无法读取，暂不能比较两次诊断间的内容。")).toBeTruthy();
  expect(screen.getByText(/本次诊断后当前内容变化（0 处）/)).toBeTruthy();
  expect(screen.queryByRole("table", { name: "模块评分变化" })).toBeNull();
});

it("当前快照不可用时不显示任何由占位值计算的内容变化", () => {
  const previous = record(1);
  const current = record(2);
  current.report = null;
  Object.assign(current, { corruptedFields: ["resume_snapshot"], resume_snapshot: { title: "", modules: [] } });
  render(<DiagnosisChanges current={current} previous={previous} modules={previous.resume_snapshot.modules} />);
  expect(screen.queryByText(/两次诊断间的内容变化/)).toBeNull();
  expect(screen.queryByText(/本次诊断后当前内容变化/)).toBeNull();
});

it("只有上次采纳记录损坏时仍可比较完整快照", () => {
  const previous = record(1);
  previous.report = null;
  Object.assign(previous, { corruptedFields: ["adoptions"] });
  const current = record(2);
  current.resume_snapshot.modules[0]!.content = { items: ["Map<K, V>"] };
  render(<DiagnosisChanges current={current} previous={previous} modules={current.resume_snapshot.modules} />);
  expect(screen.getByText(/两次诊断间的内容变化（1 处）/)).toBeTruthy();
  expect(screen.getByText(/Array<T>/)).toBeTruthy();
  expect(screen.queryByText(/上次诊断快照无法读取/)).toBeNull();
  expect(screen.queryByText(/上次建议已采纳/)).toBeNull();
});
