// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PreparationToolPage from "../page";
import ToolsPage from "../../page";
import { jsonFetch } from "@/lib/fetcher";
import { MANUAL_PLAN_STEP_KEYS, PLAN_STEP_KEYS, type PreparationPlan } from "@/lib/preparation-plan-types";

const navigation = vi.hoisted(() => ({ query: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(navigation.query), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/application/application-dialog", () => ({ ApplicationDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="投递资料"><button onClick={onClose}>关闭编辑</button></div> }));
beforeEach(() => { navigation.query = "applicationId=1"; navigation.push.mockReset(); vi.mocked(jsonFetch).mockReset(); });
afterEach(cleanup);

function fixture(): PreparationPlan {
  return {
    application: { id: 1, company: "甲公司", role: "前端工程师", jd: "React JD", resume_id: 2, resume_version_id: 3 } as PreparationPlan["application"],
    contextKey: "a".repeat(64), generatedAt: "2026-11-20T00:00:00Z", stale: false,
    steps: PLAN_STEP_KEYS.slice(0, 10).map((key, index) => ({ key, category: index < 5 ? "material" : "training", title: key, reason: `准备 ${key} 的理由`, minutes: [10, 20], done: index < 2, manual: MANUAL_PLAN_STEP_KEYS.includes(key as typeof MANUAL_PLAN_STEP_KEYS[number]), blocked: key === "intro-practice" ? "先准备自我介绍" : null, action: index < 2 ? "edit" : index < 5 ? "generate" : key === "interview" ? "visit" : "practice", actionLabel: index < 2 ? "调整资料" : index < 5 ? "立即生成" : "开始练习", href: key === "interview" ? "/interviews?applicationId=1" : null, instructions: ["先脱稿回答，再检查遗漏"] })),
  };
}

it("工具箱入口、无效岗位恢复和可搜索的岗位选择", async () => {
  const tool = render(<ToolsPage />);
  expect(screen.getByRole("link", { name: /上场计划/ }).getAttribute("href")).toBe("/tools/preparation");
  tool.unmount(); navigation.query = "applicationId=01";
  const invalid = render(<PreparationToolPage />);
  expect(screen.getByRole("alert").textContent).toContain("岗位编号无效");
  invalid.unmount(); navigation.query = "";
  vi.mocked(jsonFetch).mockResolvedValue({ items: [fixture().application], nextCursor: null, total: 1 });
  render(<PreparationToolPage />);
  expect((await screen.findByRole("link", { name: /甲公司/ })).getAttribute("href")).toBe("/tools/preparation?applicationId=1");
  fireEvent.change(screen.getByRole("textbox", { name: "查找投递岗位" }), { target: { value: "前端" } });
  await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toContain("q=%E5%89%8D%E7%AB%AF"));
  fireEvent.click(screen.getByRole("button", { name: "添加岗位" }));
  expect(screen.getByRole("dialog", { name: "投递资料" })).toBeTruthy();
});

it("生成清单显示缺项、总耗时与前置条件，手动训练确认后更新进度", async () => {
  const saved = fixture();
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...saved, generatedAt: null, steps: [] }).mockResolvedValueOnce(saved);
  render(<PreparationToolPage />);
  fireEvent.click(await screen.findByRole("button", { name: /生成本岗位准备清单/ }));
  const summary = await screen.findByRole("region", { name: "准备进度" });
  expect(summary.textContent).toContain("80–160 分钟");
  expect(within(screen.getByRole("region", { name: "待补资料" })).getAllByRole("listitem")).toHaveLength(5);
  expect((screen.getByRole("button", { name: "先准备自我介绍" }) as HTMLButtonElement).disabled).toBe(true);
  const focus = within(screen.getByRole("listitem", { name: "focus" }));
  fireEvent.click(focus.getByRole("button", { name: "开始练习" }));
  expect(focus.getByText("先脱稿回答，再检查遗漏")).toBeTruthy();
  const done = structuredClone(saved); done.steps.find(step => step.key === "focus")!.done = true;
  vi.mocked(jsonFetch).mockResolvedValueOnce(done);
  fireEvent.click(focus.getByRole("button", { name: "我已完成本项训练" }));
  await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3"));
  expect(screen.getByRole("link", { name: "开始练习 →" }).getAttribute("href")).toBe("/interviews?applicationId=1");
  vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
  fireEvent.click(focus.getByRole("button", { name: "恢复待练" }));
  await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2"));
});

it("资料逐项生成，已齐备资料可编辑；读取失败保留刷新入口", async () => {
  const saved = fixture();
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("资料读取失败")).mockResolvedValueOnce(saved);
  render(<PreparationToolPage />);
  fireEvent.click(await screen.findByRole("button", { name: "刷新清单" }));
  await screen.findByRole("region", { name: "准备进度" });
  const portrait = within(screen.getByRole("listitem", { name: "portrait" }));
  const refreshed = structuredClone(saved);
  Object.assign(refreshed.steps.find(step => step.key === "portrait")!, { done: true, action: "visit", actionLabel: "查看资料", href: "/tools/jd/5?applicationId=1" });
  vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(refreshed);
  fireEvent.click(portrait.getByRole("button", { name: "立即生成" }));
  await screen.findByText("生成考点画像完成");
  fireEvent.click(screen.getByText("已齐备资料 · 3 项"));
  expect(screen.getByRole("link", { name: /查看资料/ }).getAttribute("href")).toBe("/tools/jd/5?applicationId=1");
  fireEvent.click(screen.getAllByRole("button", { name: "调整资料" })[0]!);
  expect(screen.getByRole("dialog", { name: "投递资料" })).toBeTruthy();
});
