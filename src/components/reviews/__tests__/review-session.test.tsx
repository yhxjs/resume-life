import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "../review-session";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { ReviewDetail } from "@/lib/spaced-repetition-card-types";

let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => unknown> = [];
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[index]) : next; }];
  },
  useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useEffect: (effect: () => unknown) => { effects.push(effect); },
}));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));

type Props = { children?: ReactNode; onClick?: () => void | Promise<void>; onChange?: (event: { target: { value: string } }) => void; value?: unknown; disabled?: boolean; role?: string; "aria-label"?: string };
function nodes(root: ReactNode): ReactElement<Props>[] {
  return isValidElement<Props>(root) ? [root, ...Children.toArray(root.props.children).flatMap(nodes)] : [];
}
function text(root: ReactNode): string {
  if (typeof root === "string" || typeof root === "number") return String(root);
  return isValidElement<Props>(root) ? Children.toArray(root.props.children).map(text).join("") : "";
}
const detail: ReviewDetail = {
  id: 301, source: "notebook", source_id: 91, source_label: "缓存追练", question: "如何处理缓存一致性？",
  answer: "原始答案秘密", reference: "标准参考秘密", comment: "历史点评秘密", mastery: "learning",
  interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 1, lapses: 0, next_review_date: "2026-09-27", last_reviewed_at: "2026-09-26T10:00:00Z",
  attempts: [{ id: 5, answer: "上次复习秘密", grade: "good", reviewed_at: "2026-09-26T10:00:00Z", interval_days: 1, next_review_date: "2026-09-27" }], nextCursor: null,
};
const onSaved = vi.fn();
function render() { cursor = 0; return ReviewSession({ cardId: 301, onSaved, onClose: vi.fn() }); }
function button(label: string) {
  const found = nodes(render()).find((node) => node.type === "button" && text(node).includes(label));
  expect(found, `应有按钮：${label}`).toBeDefined();
  return found!;
}
function input(value: string) {
  const field = nodes(render()).find((node) => node.type === "textarea");
  expect(field, "应有本次回答输入框").toBeDefined();
  field!.props.onChange!({ target: { value } });
}
async function loaded() { render(); effects[0]?.(); await Promise.resolve(); await Promise.resolve(); }
async function prepared() { await loaded(); input("独立回忆的本次答案"); button("查看参考并自评").props.onClick!(); button("基本掌握").props.onClick!(); }

beforeEach(() => {
  slots = []; cursor = 0; effects = []; vi.clearAllMocks();
  vi.mocked(jsonFetch).mockResolvedValue(detail);
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe("间隔复习会话", () => {
  it("默认输入空白，答案、参考、点评和历史回答均不渲染", async () => {
    await loaded();
    const tree = render();
    expect(nodes(tree).find((node) => node.type === "textarea")?.props.value).toBe("");
    for (const secret of [detail.answer, detail.reference, detail.comment, detail.attempts[0]?.answer]) expect(text(tree)).not.toContain(secret);
    expect(button("查看参考并自评").props.disabled).toBe(true);
    input("   "); expect(button("查看参考并自评").props.disabled).toBe(true);
  });

  it("先回忆才显示参考，自评后保存排期并通知列表刷新", async () => {
    await prepared();
    expect(text(render())).toContain(detail.reference);
    expect(text(render())).toContain(detail.comment);
    expect(text(render())).not.toContain(detail.answer);
    const card = { ...detail, next_review_date: "2026-10-03", review_count: 2 };
    const attempt = { ...detail.attempts[0], id: 6, answer: "独立回忆的本次答案", next_review_date: card.next_review_date };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ card, attempt });
    await button("保存本次复习").props.onClick!();
    const options = vi.mocked(jsonFetch).mock.calls.at(-1)![1]!;
    expect(JSON.parse(String(options.body))).toMatchObject({ answer: "独立回忆的本次答案", grade: "good", expected_review_count: 1, request_id: expect.any(String), time_zone: expect.any(String) });
    expect(text(render())).toContain("2026-10-03");
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("保存失败保留草稿，未修改的重试复用请求 ID，修改答案换新 ID", async () => {
    await prepared();
    vi.mocked(jsonFetch).mockRejectedValue(new Error("暂时保存失败"));
    await button("保存本次复习").props.onClick!();
    expect(nodes(render()).find((node) => node.type === "textarea")?.props.value).toBe("独立回忆的本次答案");
    expect(text(render())).toContain("暂时保存失败");
    await button("保存本次复习").props.onClick!();
    input("补充后的回忆"); await button("保存本次复习").props.onClick!();
    const bodies = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies[0].request_id).toBe(bodies[1].request_id);
    expect(bodies[2].request_id).not.toBe(bodies[1].request_id);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("进度冲突要求重载详情且保留草稿", async () => {
    await prepared();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("进度已变更", 409));
    await button("保存本次复习").props.onClick!();
    expect(button("重新加载最新进度")).toBeDefined();
    expect(button("保存本次复习").props.disabled).toBe(true);
    expect(nodes(render()).find((node) => node.type === "textarea")?.props.value).toBe("独立回忆的本次答案");
  });

  it("HTTP 环境缺少 randomUUID 时仍生成合法请求 ID 并可重试", async () => {
    await prepared();
    vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    vi.mocked(jsonFetch).mockRejectedValue(new Error("暂时保存失败"));
    await button("保存本次复习").props.onClick!();
    await button("保存本次复习").props.onClick!();
    const bodies = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(bodies[1].request_id).toBe(bodies[0].request_id);
    expect(button("保存本次复习").props.disabled).toBe(false);
  });

  it("生成请求 ID 失败后显示错误并恢复操作，草稿不丢失", async () => {
    await prepared();
    vi.stubGlobal("crypto", { randomUUID: () => { throw new Error("请求编号生成失败"); } });
    await button("保存本次复习").props.onClick!();
    expect(text(render())).toContain("请求编号生成失败");
    expect(button("保存本次复习").props.disabled).toBe(false);
    expect(button("返回复习列表").props.disabled).toBe(false);
    expect(nodes(render()).find((node) => node.type === "textarea")?.props.value).toBe("独立回忆的本次答案");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});
