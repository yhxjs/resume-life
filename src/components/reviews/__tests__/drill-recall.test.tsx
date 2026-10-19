import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DrillPage from "@/app/drills/[id]/page";
import { jsonFetch } from "@/lib/fetcher";

let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => unknown> = [];
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[index]) : next; }];
  },
  useEffect: (effect: () => unknown) => { effects.push(effect); },
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "72" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/hooks/use-copy-feedback", () => ({ useCopyFeedback: () => ({ copiedText: "", copy: vi.fn() }) }));

type Props = { children?: ReactNode; onClick?: () => void; value?: unknown; href?: string };
function nodes(root: ReactNode): ReactElement<Props>[] {
  if (!isValidElement<Props>(root)) return [];
  return [root, ...Children.toArray(root.props.children).flatMap(nodes)];
}
function text(root: ReactNode): string {
  if (typeof root === "string" || typeof root === "number") return String(root);
  return isValidElement<Props>(root) ? Children.toArray(root.props.children).map(text).join("") : "";
}
function render() { cursor = 0; return DrillPage(); }

beforeEach(() => {
  slots = []; cursor = 0; effects = []; vi.clearAllMocks();
  vi.mocked(jsonFetch).mockResolvedValue({
    id: 72, source: "interview", focus: "缓存一致性", questions: [{
      id: 91, idx: 1, question: "如何处理缓存一致性？", answer: "历史回答秘密", reference: "参考答案秘密",
      comment: "批改点评秘密", scores: null, answered_at: "2026-09-25T08:00:00Z", kind: "tech",
      notebook_id: null, review_card_id: 301, review_mastery: "learning", next_review_date: "2026-09-27",
    }],
  });
});

describe("已答追练的独立回忆", () => {
  it("普通重答从空白开始，答案、点评和参考完全不进入重答视图", async () => {
    render(); effects[0]?.(); await Promise.resolve();
    const start = nodes(render()).find((node) => node.type === "button" && text(node).includes("重答本题"));
    expect(start).toBeDefined(); start!.props.onClick!();
    const tree = render();
    expect(nodes(tree).find((node) => node.type === "textarea")?.props.value).toBe("");
    expect(text(tree)).not.toContain("历史回答秘密");
    expect(text(tree)).not.toContain("参考答案秘密");
    expect(text(tree)).not.toContain("批改点评秘密");
  });

  it("已答追练展示掌握状态与独立复习入口", async () => {
    render(); effects[0]?.(); await Promise.resolve();
    const tree = render();
    expect(nodes(tree).some((node) => node.props.href === "/reviews?card=301")).toBe(true);
    expect(text(tree)).toContain("学习中");
    expect(text(tree)).toContain("2026-09-27");
  });
});
