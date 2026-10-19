// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PortfolioLivePreview } from "../portfolio-live-preview";
import type { PortfolioExportOptions } from "@/lib/portfolio-types";

const fetchMock = vi.fn();
const options: PortfolioExportOptions = { resumeId: 1, selectedProjects: [], themeMode: "dark" };
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({
    html: '<html><body><h1>真实简历</h1><a href="resume.html">完整简历</a><script>window.motionReady=true</script></body></html>',
    resumeHtml: "<html><body>完整经历</body></html>",
  }) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

it("将服务端生成的完整 HTML 与动效脚本放入隔离 iframe，并接通完整简历链接", async () => {
  render(<PortfolioLivePreview options={options} />);
  const frame = await screen.findByTitle("动态简历真实页面") as HTMLIFrameElement;
  expect(frame.srcdoc).toContain("真实简历");
  expect(frame.srcdoc).toContain("window.motionReady=true");
  expect(frame.srcdoc).toContain("URL.createObjectURL(new Blob(");
  expect(frame.srcdoc).toContain("\\u003chtml>");
  expect(frame.srcdoc).toContain("URL.revokeObjectURL(resumeUrl)");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(options);
  fireEvent.click(screen.getByRole("button", { name: "手机" }));
  expect(frame.style.width).toBe("390px");
  fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
  expect(screen.getByRole("dialog", { name: "真实页面预览" })).toBeDefined();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("预览失败提供重试", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "简历版本已删除" }) });
  render(<PortfolioLivePreview options={options} />);
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByText("简历版本已删除")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "重试预览" }));
  await screen.findByTitle("动态简历真实页面");
});

it("快速改变配置时取消旧请求，只使用最新配置", async () => {
  const { rerender } = render(<PortfolioLivePreview options={options} />);
  rerender(<PortfolioLivePreview options={{ ...options, siteSubtitle: "最新介绍" }} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body).siteSubtitle).toBe("最新介绍");
});
