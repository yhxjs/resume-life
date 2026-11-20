// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePreparationPlan } from "../use-preparation-plan";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { fetchSse, SseServerError } from "@/lib/fetch-sse";
import { PLAN_STEP_KEYS, type PreparationPlan } from "@/lib/preparation-plan-types";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", async original => ({ ...await original<typeof import("@/lib/fetch-sse")>(), fetchSse: vi.fn() }));
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); vi.mocked(fetchSse).mockReset(); });
afterEach(cleanup);

function fixture(): PreparationPlan {
  return {
    application: { id: 1, company: "甲公司", role: "前端", jd: "前端 JD", resume_id: 2, resume_version_id: 3 } as PreparationPlan["application"],
    contextKey: "a".repeat(64), generatedAt: "2026-11-20T00:00:00Z", stale: false,
    steps: PLAN_STEP_KEYS.slice(0, 10).map(key => ({ key, category: key === "portrait" ? "material" : "training", title: key, reason: "准备原因", minutes: [10, 20], done: false, manual: key === "focus", blocked: null, action: key === "portrait" || key === "intro" ? "generate" : "practice", actionLabel: "开始", href: null, instructions: ["完成一次练习"] })),
  };
}
async function setup() {
  const initial = fixture();
  vi.mocked(jsonFetch).mockResolvedValueOnce(initial);
  const hook = renderHook(() => usePreparationPlan(1));
  await waitFor(() => expect(hook.result.current.data).toEqual(initial));
  return hook;
}

it("完成以服务端确认快照为准，连续点击只发起一次写入", async () => {
  const hook = await setup();
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const step = hook.result.current.data!.steps.find(item => item.key === "focus")!;
  let operation: Promise<void> | undefined;
  act(() => { operation = hook.result.current.complete(step, true); void hook.result.current.complete(step, true); });
  expect(hook.result.current.data!.steps.find(item => item.key === "focus")!.done).toBe(false);
  const saved = fixture(); saved.steps.find(item => item.key === "focus")!.done = true;
  await act(async () => { pending.resolve(saved); await operation; });
  expect(hook.result.current.data!.steps.find(item => item.key === "focus")!.done).toBe(true);
  expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});

it("失败保存保留原进度，结果不确定时必须先读取核对再重试", async () => {
  const hook = await setup();
  const step = hook.result.current.data!.steps.find(item => item.key === "focus")!;
  vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("保存失败", 503));
  await act(async () => { await hook.result.current.complete(step, true); });
  expect(hook.result.current.blocked).toBe(true);
  expect(hook.result.current.data!.steps.find(item => item.key === "focus")!.done).toBe(false);
  await act(async () => { await hook.result.current.complete(step, true); });
  expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  vi.mocked(jsonFetch).mockResolvedValueOnce(fixture());
  await act(async () => { await hook.result.current.reload(); });
  expect(hook.result.current.blocked).toBe(false);
});

it("迟到读取不能撤销已经确认的完成进度", async () => {
  const hook = await setup();
  const old = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise);
  let reading: Promise<void>;
  act(() => { reading = hook.result.current.reload(); });
  const saved = fixture(); saved.steps.find(item => item.key === "focus")!.done = true;
  vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
  await act(async () => { await hook.result.current.complete(saved.steps.find(item => item.key === "focus")!, true); });
  await act(async () => { old.resolve(fixture()); await reading; });
  expect(hook.result.current.data).toEqual(saved);
});

it("资料生成沿用当前投递 ID、JD 和发布版，刷新确认后才算资料齐备", async () => {
  const hook = await setup();
  const saved = fixture(); saved.steps.find(item => item.key === "portrait")!.done = true;
  vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(saved);
  await act(async () => { await hook.result.current.generateMaterial(hook.result.current.data!.steps.find(item => item.key === "portrait")!); });
  const call = vi.mocked(jsonFetch).mock.calls.find(([url]) => url === "/api/tools/jd-portraits")!;
  expect(JSON.parse(String(call[1]?.body))).toMatchObject({ application_id: 1, jd: "前端 JD", resume_id: 2, resume_version_id: 3 });
  expect(hook.result.current.data!.steps.find(item => item.key === "portrait")!.done).toBe(true);
});

it("流式自我介绍与普通资料都必须核对成功归档，错误快照不得冒充成功", async () => {
  const hook = await setup();
  vi.mocked(fetchSse).mockResolvedValueOnce(undefined);
  vi.mocked(jsonFetch).mockResolvedValueOnce(fixture());
  await act(async () => { await hook.result.current.generateMaterial(hook.result.current.data!.steps.find(item => item.key === "intro")!); });
  expect(fetchSse).toHaveBeenCalledWith("/api/intros", expect.objectContaining({ body: expect.objectContaining({ application_id: 1, resume_version_id: 3 }) }));
  expect(hook.result.current.blocked).toBe(true);
  expect(hook.result.current.notice).toBe("");
  expect(hook.result.current.error).toContain("尚未确认");
});

it("自我介绍明确未保存时保留缺项并允许直接重试，不要求额外刷新", async () => {
  const hook = await setup();
  const step = hook.result.current.data!.steps.find(item => item.key === "intro")!;
  vi.mocked(fetchSse).mockRejectedValueOnce(new SseServerError("达到模型输出上限，本次未保存", "not_saved"));
  await act(async () => { await hook.result.current.generateMaterial(step); });
  expect(hook.result.current.blocked).toBe(false);
  expect(hook.result.current.error).toBe("达到模型输出上限，本次未保存");
  expect(hook.result.current.data!.steps.find(item => item.key === "intro")!.done).toBe(false);
  expect(hook.result.current.notice).toBe("");
  const saved = fixture(); saved.steps.find(item => item.key === "intro")!.done = true;
  vi.mocked(fetchSse).mockResolvedValueOnce(undefined);
  vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
  await act(async () => { await hook.result.current.generateMaterial(step); });
  expect(fetchSse).toHaveBeenCalledTimes(2);
  expect(hook.result.current.data).toEqual(saved);
  expect(hook.result.current.notice).toBe("生成自我介绍完成");
});

it.each([new SseServerError("服务端处理失败"), new Error("流式响应意外中断")])("缺少未保存保证的失败仍需核对结果：%s", async reason => {
  const hook = await setup();
  const step = hook.result.current.data!.steps.find(item => item.key === "intro")!;
  vi.mocked(fetchSse).mockRejectedValueOnce(reason);
  await act(async () => { await hook.result.current.generateMaterial(step); });
  expect(hook.result.current.blocked).toBe(true);
  expect(hook.result.current.error).toContain("请先刷新清单");
  await act(async () => { await hook.result.current.generateMaterial(step); });
  expect(fetchSse).toHaveBeenCalledOnce();
});

it("生成拒绝跨岗位响应，卸载后迟到完成不会应用到下一岗位", async () => {
  const hook = await setup();
  const wrong = fixture(); wrong.application.id = 2;
  vi.mocked(jsonFetch).mockResolvedValueOnce(wrong);
  await act(async () => { await hook.result.current.generate(); });
  expect(hook.result.current.data!.application.id).toBe(1);
  expect(hook.result.current.blocked).toBe(true);
  vi.mocked(jsonFetch).mockResolvedValueOnce(fixture());
  await act(async () => { await hook.result.current.reload(); });
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  let operation: Promise<void> | undefined;
  act(() => { operation = hook.result.current.generate(); });
  const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal;
  hook.unmount(); expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(fixture()); await operation; });
});
