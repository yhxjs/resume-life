// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { INTERVIEW_QUESTION_GRAPH_DRAFT_KEY } from "@/lib/interview-question-graph-draft";

const mocks = vi.hoisted(() => ({ cursorList: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: mocks.cursorList }));
vi.mock("@/hooks/use-resume-options", () => ({
  useResumeOptions: () => ({
    resumes: [{ id: 1, title: "参考简历", versions: [{ id: 11, version: 1, name: "发布版" }] }],
    resumesError: "",
    reloadResumes: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-resume-version-selection", () => ({
  useResumeVersionSelection: () => ({ resumeVersionId: 11, setResumeVersionId: vi.fn() }),
}));

import { InterviewQuestionGraphWorkspace } from "../interview-question-graph-workspace";

const historyItem = {
  id: 42,
  resume_id: 1,
  resume_version_id: 11,
  resume_title: "参考简历",
  jd: "接口开发岗位",
  style: "deep" as const,
  question: "请说明你实际负责的工作。",
  revision: 2,
  created_at: "2026-11-22T08:00:00.000Z",
  updated_at: "2026-11-22T08:10:00.000Z",
};

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.cursorList.mockReset().mockReturnValue({
    items: [historyItem],
    total: 1,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    listError: "",
    hasMore: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
  });
  window.sessionStorage.removeItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY);
  window.history.replaceState(null, "", "/interviews/question-graphs");
});

afterEach(() => {
  cleanup();
  window.sessionStorage.removeItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY);
  window.history.replaceState(null, "", "/");
});

it("独立图谱工作区直接展示历史列表与记录摘要", () => {
  render(<InterviewQuestionGraphWorkspace />);

  expect(screen.getByRole("heading", { name: "历史记录" })).toBeTruthy();
  expect(screen.getByText("共 1 条")).toBeTruthy();
  expect(screen.getByText(historyItem.question)).toBeTruthy();
  expect(screen.getByRole("button", { name: "载入此图谱" })).toBeTruthy();
});

it("从模拟面试进入时消费暂存设置并清理临时地址参数", async () => {
  window.sessionStorage.setItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY, JSON.stringify({
    resumeId: 1,
    resumeVersionId: 11,
    jd: "当前岗位要求",
    style: "manager",
  }));
  window.history.replaceState(null, "", "/interviews/question-graphs?draft=interview");
  render(<InterviewQuestionGraphWorkspace />);

  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/interviews/question-graphs", { scroll: false }));
  expect((screen.getByLabelText("岗位要求（JD）") as HTMLTextAreaElement).value).toBe("当前岗位要求");
  expect(window.sessionStorage.getItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY)).toBeNull();
});
