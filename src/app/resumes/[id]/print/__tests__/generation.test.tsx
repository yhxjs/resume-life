// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { jsonFetch } from "@/lib/fetcher";
import PrintPage from "../page";
import { BUILTIN_STYLES } from "@/lib/templates";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "1" }), useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/resume/template-picker", () => ({
  TemplatePicker: ({ onChange }: { onChange: (value: string) => void }) =>
    <button onClick={() => onChange("modern")}>切换测试模板</button>,
}));

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const document = (dataGeneration: string | null) => ({
  resume: { id: 1, title: "测试简历", template: "classic", dataGeneration, created_at: "", updated_at: "" }, modules: [],
});

describe("打印页模板保存的恢复世代", () => {
  it("损坏排版不能使用页面按钮或原生打印输出默认预览", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    vi.mocked(jsonFetch).mockImplementation(async (url) => url === "/api/templates" ? { items: [] } : {
      ...document(null), resume: { ...document(null).resume, styleCorrupted: true },
    });
    const view = render(<PrintPage />);
    expect((await screen.findAllByText(/排版数据损坏/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "浏览器打印" }));
    expect(screen.queryByRole("dialog", { name: "导出前检查" })).toBeNull();
    expect(print).not.toHaveBeenCalled();
    expect(view.container.querySelector(".export-print-blocked")).toBeTruthy();
    print.mockRestore();
  });

  it("已选坏模板显示修复提示并阻止打印", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url) => url === "/api/templates" ? {
      items: [{ id: 1, name: "损坏样式", style: BUILTIN_STYLES.classic, corrupted: true, created_at: "", updated_at: "" }],
    } : { ...document(null), resume: { ...document(null).resume, template: "custom:1" } });
    render(<PrintPage />);
    expect((await screen.findAllByText(/模板数据损坏/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "浏览器打印" }));
    expect(screen.queryByRole("dialog", { name: "导出前检查" })).toBeNull();
  });

  it("损坏模块显示警告并阻止页面和原生打印，不能进入跳过核对流程", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    vi.mocked(jsonFetch).mockImplementation(async (url) => url === "/api/templates" ? { items: [] } : {
      ...document(null), corruptedKeys: ["work"], warnings: ["工作经历无法解析，已显示为空"],
    });
    const view = render(<PrintPage />);
    expect((await screen.findAllByText(/部分模块数据损坏/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "浏览器打印" }));
    expect(screen.queryByRole("dialog", { name: "导出前检查" })).toBeNull();
    expect(print).not.toHaveBeenCalled();
    expect(view.container.querySelector(".export-print-blocked")).toBeTruthy();
    expect(Array.from(view.container.querySelectorAll("style")).some((style) => style.textContent?.includes(".paper { display: none"))).toBe(true);
    print.mockRestore();
  });

  it.each([null, "original-generation"])("加载世代 %j 后随模板 PATCH 原样发送", async (generation) => {
    vi.mocked(jsonFetch).mockImplementation(async (url, options) =>
      url === "/api/templates" ? { items: [] } : options?.method === "PATCH" ? {} : document(generation));
    render(<PrintPage />);
    fireEvent.click(await screen.findByRole("button", { name: "切换测试模板" }));
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(true));
    const [, options] = vi.mocked(jsonFetch).mock.calls.find(([, options]) => options?.method === "PATCH")!;
    expect(JSON.parse(String(options?.body))).toEqual({ template: "modern", dataGeneration: generation });
  });

  it("恢复后的旧页面保留旧世代，展示冲突而不自动重新读取令牌", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
      if (url === "/api/templates") return { items: [] };
      if (options?.method === "PATCH") throw new Error("数据已恢复，请刷新后重新操作");
      return document("old-generation");
    });
    render(<PrintPage />);
    fireEvent.click(await screen.findByRole("button", { name: "切换测试模板" }));
    expect(await screen.findByText("数据已恢复，请刷新后重新操作")).toBeTruthy();
    const calls = vi.mocked(jsonFetch).mock.calls;
    expect(calls.filter(([url, options]) => url === "/api/resumes/1" && options?.method !== "PATCH")).toHaveLength(1);
    const [, options] = calls.find(([, options]) => options?.method === "PATCH")!;
    expect(JSON.parse(String(options?.body)).dataGeneration).toBe("old-generation");
  });
});
