// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "../review-session";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { ReviewDetail } from "@/lib/spaced-repetition-card-types";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const detail: ReviewDetail = {
  id: 301, source: "notebook", source_id: 91, source_label: "缓存追练", question: "如何处理缓存一致性？",
  answer: "原始答案秘密", reference: "标准参考秘密", comment: "历史点评秘密", mastery: "learning",
  interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 1, lapses: 0, next_review_date: "2026-09-27", last_reviewed_at: "2026-09-26T10:00:00Z",
  attempts: [{ id: 5, answer: "上次复习秘密", grade: "good", reviewed_at: "2026-09-26T10:00:00Z", interval_days: 1, next_review_date: "2026-09-27" }], nextCursor: null,
};
const onSaved = vi.fn(); const onClose = vi.fn();
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
const answer = () => screen.getByRole("textbox", { name: "本次回答" }) as HTMLTextAreaElement;
async function loaded() {
  render(<ReviewSession cardId={301} onSaved={onSaved} onClose={onClose} />);
  await screen.findByRole("heading", { name: detail.question });
}
async function prepared() {
  await loaded(); fireEvent.change(answer(), { target: { value: "独立回忆的本次答案" } });
  fireEvent.click(screen.getByRole("button", { name: "查看参考并自评" })); fireEvent.click(screen.getByRole("button", { name: /基本掌握/ }));
}
beforeEach(() => { vi.mocked(jsonFetch).mockResolvedValue(detail); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("间隔复习会话", () => {
  it("默认输入空白，答案、参考、点评和历史回答均不渲染", async () => {
    await loaded(); expect(answer().value).toBe("");
    for (const secret of [detail.answer, detail.reference, detail.comment, detail.attempts[0]!.answer]) expect(screen.queryByText(secret)).toBeNull();
    expect((screen.getByRole("button", { name: "查看参考并自评" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(answer(), { target: { value: "   " } }); expect((screen.getByRole("button", { name: "查看参考并自评" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("先回忆才显示参考，按编号确认后保存实际排期并刷新完整历史", async () => {
    await prepared(); expect(screen.getByText(detail.reference)).toBeTruthy(); expect(screen.getByText(detail.comment)).toBeTruthy(); expect(screen.queryByText(detail.answer)).toBeNull();
    const card = { ...detail, next_review_date: "2026-10-03", review_count: 2 };
    const attempt = { ...detail.attempts[0]!, id: 6, answer: "独立回忆的本次答案", next_review_date: card.next_review_date };
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => init?.method === "POST" ? { card, attempt } : url.includes("/requests/") ? { card, attempt, request_id: posts()[0]!.request_id } : { ...card, attempts: [attempt, ...detail.attempts] });
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" })); await screen.findByText("本次复习已保存");
    expect(posts()[0]).toMatchObject({ answer: "独立回忆的本次答案", grade: "good", expected_review_count: 1, request_id: expect.any(String), time_zone: expect.any(String) });
    expect(onSaved).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole("button", { name: "查看复习历史" })); await screen.findByText("上次复习秘密");
  });

  it("网络失败保留原稿，显式重放用原编号，明确拒绝后编辑才生成新编号", async () => {
    await prepared(); let calls = 0;
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "POST") throw ++calls === 1 ? new Error("暂时保存失败") : new HttpError("明确拒绝", 400); throw new HttpError("未找到", 404); });
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" })); await screen.findByRole("button", { name: "重试同一提交" }); expect(answer().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重试同一提交" })); await screen.findByText(/明确拒绝/); expect(answer().disabled).toBe(false);
    fireEvent.change(answer(), { target: { value: "补充后的回忆" } }); fireEvent.click(screen.getByRole("button", { name: "保存本次复习" }));
    await waitFor(() => expect(posts()).toHaveLength(3)); expect(posts()[0].request_id).toBe(posts()[1].request_id); expect(posts()[2].request_id).not.toBe(posts()[1].request_id); expect(onSaved).not.toHaveBeenCalled();
  });

  it("进度冲突核对未找到后要求重载详情，保留草稿与自评", async () => {
    await prepared(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("进度已变更", 409)).mockRejectedValueOnce(new HttpError("未找到", 404));
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" })); await screen.findByRole("button", { name: "重新加载最新进度" });
    expect((screen.getByRole("button", { name: "保存本次复习" }) as HTMLButtonElement).disabled).toBe(true); expect(answer().value).toBe("独立回忆的本次答案");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail, review_count: 4 }); fireEvent.click(screen.getByRole("button", { name: "重新加载最新进度" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "保存本次复习" }) as HTMLButtonElement).disabled).toBe(false)); expect(answer().value).toBe("独立回忆的本次答案");
    expect(screen.getByRole("button", { name: /基本掌握/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(/复习进度已变更，本次提交尚未找到/)).toBeNull();
  });

  it("HTTP 环境缺少 randomUUID 时生成合法编号，显式重放复用原编号", async () => {
    await prepared(); vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "POST") throw new Error("断线"); throw new HttpError("未找到", 404); });
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" })); await screen.findByRole("button", { name: "重试同一提交" });
    fireEvent.click(screen.getByRole("button", { name: "重试同一提交" })); await screen.findByRole("button", { name: "重试同一提交" });
    expect(posts()).toHaveLength(2); expect(posts()[0].request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); expect(posts()[1].request_id).toBe(posts()[0].request_id);
  });

  it("生成请求 ID 失败后恢复操作、保留草稿且零写入", async () => {
    await prepared(); vi.stubGlobal("crypto", { randomUUID: () => { throw new Error("请求编号生成失败"); } });
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" })); await screen.findByText(/请求编号生成失败/);
    expect((screen.getByRole("button", { name: "保存本次复习" }) as HTMLButtonElement).disabled).toBe(false); expect((screen.getByRole("button", { name: /返回复习列表/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(answer().value).toBe("独立回忆的本次答案"); expect(posts()).toHaveLength(0);
  });

  it("保存已确认后历史刷新失败仍保留成功，不把旧历史当完整新页，重读不重复写", async () => {
    await prepared(); const card = { ...detail, review_count: 2 }; const attempt = { ...detail.attempts[0]!, id: 6, answer: "独立回忆的本次答案" };
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => { if (init?.method === "POST") return { card, attempt }; if (url.includes("/requests/")) return { card, attempt, request_id: posts()[0]!.request_id }; throw new Error("最新历史读取失败"); });
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" })); await screen.findByText("本次复习已保存"); await screen.findByText("最新历史读取失败");
    fireEvent.click(screen.getByRole("button", { name: "查看复习历史" })); expect(screen.queryByText("上次复习秘密")).toBeNull();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...card, attempts: [attempt, ...detail.attempts] }); fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await screen.findByText("上次复习秘密");
    expect(posts()).toHaveLength(1); expect(onSaved).toHaveBeenCalledOnce();
  });
});
