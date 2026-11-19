// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { PRESET_REMEDIES } from "@/lib/career-gap-remedy";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.mocked(jsonFetch).mockResolvedValue({ items: [], nextCursor: null, total: 0 });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("空窗示例的复制边界", () => {
  it("失败只在对应示例旁显示，清除旧成功，成功重试不改写真实经历或生成记录", async () => {
    render(<Page />);
    await screen.findByText(/暂无沟通记录/);
    const draft = "实际经历 <T> &amp;\n没有学习或项目，到岗时间尚未确认。";
    fireEvent.change(screen.getByRole("textbox", { name: "真实经历与希望说明的问题" }), { target: { value: draft } });
    const preset = PRESET_REMEDIES[0]!;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(preset.title) }));
    const concise = within(screen.getByRole("region", { name: "精炼说明示例" }));
    fireEvent.click(concise.getByRole("button", { name: "复制示例" }));
    const copied = await concise.findByRole("button", { name: "已复制 ✓" });
    expect(writeText).toHaveBeenLastCalledWith(preset.quickScript);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(copied);
    expect((await concise.findByRole("alert")).textContent).toContain("手动复制");
    expect(concise.queryByRole("button", { name: "已复制 ✓" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "详细说明示例" })).queryByRole("alert")).toBeNull();
    fireEvent.click(concise.getByRole("button", { name: "复制示例" }));
    await concise.findByRole("button", { name: "已复制 ✓" });
    expect(concise.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("textbox", { name: "真实经历与希望说明的问题" }) as HTMLTextAreaElement).value).toBe(draft);
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("在途写入禁用两版复制，切换场景后不把旧失败放在新示例旁", async () => {
    let reject!: (reason: Error) => void;
    writeText.mockReturnValueOnce(new Promise<void>((_resolve, no) => { reject = no; }));
    render(<Page />);
    await screen.findByText(/暂无沟通记录/);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(PRESET_REMEDIES[0]!.title) }));
    fireEvent.click(within(screen.getByRole("region", { name: "详细说明示例" })).getByRole("button"));
    for (const button of screen.getAllByRole("button", { name: "复制示例" })) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(PRESET_REMEDIES[1]!.title) }));
    await act(async () => { reject(new Error("denied")); });
    expect(screen.queryByRole("alert")).toBeNull();
    const detail = within(screen.getByRole("region", { name: "详细说明示例" }));
    fireEvent.click(detail.getByRole("button"));
    await detail.findByRole("button", { name: "已复制 ✓" });
    expect(writeText).toHaveBeenLastCalledWith(PRESET_REMEDIES[1]!.deepScript);
  });
});
