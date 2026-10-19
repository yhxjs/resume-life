// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApplicationInterviewReviewDialog } from "../application-interview-review-dialog";
import type { Application, ApplicationInterview } from "@/lib/applications-types";

const controls = vi.hoisted(() => ({ confirm: vi.fn(), push: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: controls.confirm }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));

const app = { id: 8, company: "甲公司", role: "前端工程师" } as Application;
const round = { id: 3, application_id: 8, round_name: "技术一面" } as ApplicationInterview;
const question = { question: "如何处理高并发？", answer: "用了缓存", stuck: "一致性没讲清", feedback: "继续解释" };
const result = {
  mistakes: [{ question_index: 1, gap: "缺少一致性", improved_answer: "说明失效策略" }],
  drills: [{ question_index: 1, question: "缓存击穿怎么办？" }],
  resume_suggestions: [{ question_index: 1, suggestion: "补充量化结果" }],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); controls.confirm.mockReset(); controls.push.mockReset(); });

it("从逐题录入到确认生成并在同一轮回看结果", async () => {
  let questions: typeof question[] = [];
  let latest: unknown = null;
  let hash = "a".repeat(64);
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      questions = JSON.parse(String(init.body)).questions;
      hash = "b".repeat(64);
    }
    if (init?.method === "POST") {
      latest = { id: 1, application_id: app.id, interview_id: round.id, questions, result,
        exports: { mistakes: false, drills: null, resume_suggestions: false },
        created_at: "2026-09-29T00:00:00.000Z", input_hash: hash };
    }
    return { ok: true, json: async () => ({ questions, input_hash: hash, latest, selected: null, history: latest ? [{ id: 1, created_at: "2026-09-29T00:00:00.000Z", input_hash: hash }] : [] }) };
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("还没有逐题记录");
  fireEvent.click(screen.getByRole("button", { name: "添加题目" }));
  fireEvent.change(screen.getByRole("textbox", { name: "问了什么" }), { target: { value: question.question } });
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: question.answer } });
  fireEvent.change(screen.getByRole("textbox", { name: "卡在哪里" }), { target: { value: question.stuck } });
  fireEvent.change(screen.getByRole("textbox", { name: "对方反馈" }), { target: { value: question.feedback } });
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "PUT" })));
  fireEvent.click(screen.getByRole("button", { name: "确认并生成复盘" }));
  await screen.findByText("缓存击穿怎么办？");
  expect(screen.getByText("缺少一致性")).toBeTruthy();
  expect(screen.getByText("补充量化结果")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST" }));
});

it("三类结果分别确认后执行，取消时不写入，追练创建后打开练习", async () => {
  const recap = { id: 7, application_id: app.id, interview_id: round.id, questions: [question], result,
    exports: { mistakes: false, drills: null as number | null, resume_suggestions: false },
    created_at: "2026-09-29T00:00:00.000Z", input_hash: "a".repeat(64) };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const { action } = JSON.parse(String(init.body));
      if (action === "mistakes") recap.exports.mistakes = true;
      if (action === "drills") recap.exports.drills = 24;
      if (action === "resume_suggestions") recap.exports.resume_suggestions = true;
    }
    return { ok: true, json: async () => ({ questions: [question], input_hash: recap.input_hash, latest: recap,
      selected: null, history: [{ id: recap.id, created_at: recap.created_at, input_hash: recap.input_hash }],
      drill_id: recap.exports.drills }) };
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByRole("button", { name: "加入错题本" });

  controls.confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "加入错题本" }));
  await waitFor(() => expect(controls.confirm).toHaveBeenCalledTimes(1));
  expect(fetch).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST" }));

  controls.confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "加入错题本" }));
  await screen.findByRole("button", { name: "已加入错题本" });
  fireEvent.click(screen.getByRole("button", { name: "开始追练" }));
  await waitFor(() => expect(controls.push).toHaveBeenCalledWith("/drills/24"));
  fireEvent.click(screen.getByRole("button", { name: "创建修改待办" }));
  await screen.findByRole("button", { name: "已创建待办" });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
});

it("当前输入摘要变化后允许重新生成，使用新摘要并保留旧结果到生成完成", async () => {
  const currentHash = "b".repeat(64);
  let latest = { id: 7, application_id: app.id, interview_id: round.id, questions: [question], result,
    exports: { mistakes: false, drills: null, resume_suggestions: false },
    created_at: "2026-09-29T00:00:00.000Z", input_hash: "a".repeat(64) };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") latest = { ...latest, id: 8, input_hash: currentHash };
    return { ok: true, json: async () => ({ questions: [question], input_hash: currentHash, latest, selected: null,
      history: [{ id: latest.id, created_at: latest.created_at, input_hash: latest.input_hash }] }) };
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  const generate = await screen.findByRole("button", { name: "确认并生成复盘" });
  await screen.findByText("缓存击穿怎么办？");
  expect((generate as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(generate);
  await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(true));
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST", body: JSON.stringify({ expected_hash: currentHash }) }));
});
