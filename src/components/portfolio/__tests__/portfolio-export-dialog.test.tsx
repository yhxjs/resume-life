// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PortfolioExportDialog } from "../portfolio-export-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sourceResponse(name: string) {
  return {
    ok: true,
    json: async () => ({
      resumes: [{ id: 1, title: "演示简历", versions: [] }],
      projects: [{ id: 101, name, summary: { overview: "原创演示项目" } }],
    }),
  };
}

describe("PortfolioExportDialog", () => {
  it("项目链接具有关联标签，非法协议在保存和导出前被拒绝", async () => {
    const beforeExport = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(sourceResponse("链接项目"));
    vi.stubGlobal("fetch", fetchMock);
    render(<PortfolioExportDialog isOpen onClose={vi.fn()} resumeId={1} beforeExport={beforeExport} />);
    await screen.findByText("链接项目");
    const input = screen.getByLabelText("链接项目 · 演示外链");
    fireEvent.change(input, { target: { value: "data:text/html,test" } });
    fireEvent.click(screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }));
    await screen.findByText(/演示外链必须是完整的 HTTP\/HTTPS/);
    expect(beforeExport).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });
  it("等待导出前保存完成后才发送 POST 和下载", async () => {
    let resolveSave!: () => void;
    const beforeExport = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve(
      url === "/api/portfolio/sources" ? sourceResponse("等待保存的项目")
        : { ok: true, blob: async () => new Blob(["zip"]) },
    ));
    const createObjectURL = vi.fn(() => "blob:export");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const onClose = vi.fn();
    render(<PortfolioExportDialog isOpen onClose={onClose} resumeId={1} beforeExport={beforeExport} />);
    await screen.findByText("等待保存的项目");
    fireEvent.click(screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }));
    expect(beforeExport).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/portfolio/export", expect.anything());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolveSave());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/portfolio/export", expect.objectContaining({ method: "POST" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("保存拒绝时保留弹窗与选择并显示错误，不请求导出或下载", async () => {
    const beforeExport = vi.fn().mockRejectedValue(new Error("草稿保存冲突，请刷新后重试"));
    const fetchMock = vi.fn().mockResolvedValue(sourceResponse("保留的项目"));
    const createObjectURL = vi.fn();
    const onClose = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    render(<PortfolioExportDialog isOpen onClose={onClose} resumeId={1} beforeExport={beforeExport} />);
    await screen.findByText("保留的项目");
    fireEvent.change(screen.getByDisplayValue("个人作品集"), { target: { value: "保留的标题" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "保留的项目" }));
    fireEvent.click(screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }));
    await screen.findByText("草稿保存冲突，请刷新后重试");
    expect(screen.getByDisplayValue("保留的标题")).toBeDefined();
    expect((screen.getByRole("checkbox", { name: "保留的项目" }) as HTMLInputElement).checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith("/api/portfolio/export", expect.anything());
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "生成并下载静态站点 Zip 包" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("打开时应正确拉取数据源并渲染项目选项", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "/api/portfolio/sources") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                resumes: [
                  { id: 1, title: "主简历", updated_at: "2026-09-29", versions: [] },
                ],
                projects: [
                  {
                    id: 101,
                    name: "微服务分布式网关",
                    summary: {
                      overview: "高性能网关系统",
                      architecture: "事件驱动",
                      highlights: "高可用",
                      responsibilities: "负责人",
                      challenges: "锁一致性",
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob()) });
      })
    );

    render(
      <PortfolioExportDialog
        isOpen={true}
        onClose={vi.fn()}
        resumeId={1}
        resumeTitle="主简历"
      />
    );

    expect(screen.getByText("正在加载数据源...")).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("微服务分布式网关")).toBeDefined();
    });

    expect(screen.getByText("生成并下载静态站点 Zip 包")).toBeDefined();
  });

  it("点击导出按钮应触发 /api/portfolio/export", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/portfolio/sources") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              resumes: [{ id: 1, title: "主简历", updated_at: "2026-09-29", versions: [] }],
              projects: [],
            }),
        });
      }
      if (url === "/api/portfolio/export") {
        return Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["mock-zip"], { type: "application/zip" })),
        });
      }
      return Promise.resolve({ ok: true });
    });

    vi.stubGlobal("fetch", fetchMock);
    const mockRevoke = vi.fn();
    const mockCreate = vi.fn(() => "blob:mock-url");
    vi.stubGlobal("URL", {
      createObjectURL: mockCreate,
      revokeObjectURL: mockRevoke,
    });

    render(
      <PortfolioExportDialog
        isOpen={true}
        onClose={vi.fn()}
        resumeId={1}
        resumeTitle="主简历"
      />
    );

    await waitFor(() => {
      expect(screen.queryByText("正在加载数据源...")).toBeNull();
    });

    const exportBtn = screen.getByText("生成并下载静态站点 Zip 包");
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/portfolio/export",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("加载失败后重开立即恢复加载态并清除旧错误", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("演示请求失败"))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const props = { onClose: vi.fn(), resumeId: 1 };
    const view = render(<PortfolioExportDialog {...props} isOpen={true} />);
    await screen.findByText("演示请求失败");
    view.rerender(<PortfolioExportDialog {...props} isOpen={false} />);
    view.rerender(<PortfolioExportDialog {...props} isOpen={true} />);
    expect(screen.getByText("正在加载数据源...")).toBeDefined();
    expect(screen.queryByText("演示请求失败")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("旧打开周期的迟到响应不能覆盖重新打开后的数据源", async () => {
    let resolveOld!: (value: ReturnType<typeof sourceResponse>) => void;
    let resolveNew!: (value: ReturnType<typeof sourceResponse>) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const props = { onClose: vi.fn(), resumeId: 1 };
    const view = render(<PortfolioExportDialog {...props} isOpen={true} />);
    view.rerender(<PortfolioExportDialog {...props} isOpen={false} />);
    view.rerender(<PortfolioExportDialog {...props} isOpen={true} />);
    await act(async () => resolveNew(sourceResponse("新周期演示项目")));
    expect(screen.getByText("新周期演示项目")).toBeDefined();
    await act(async () => resolveOld(sourceResponse("旧周期演示项目")));
    expect(screen.getByText("新周期演示项目")).toBeDefined();
    expect(screen.queryByText("旧周期演示项目")).toBeNull();
  });

  it("重开弹窗保留用户取消的项目选择和站点名称", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sourceResponse("可选演示项目")));
    const props = { onClose: vi.fn(), resumeId: 1 };
    const view = render(<PortfolioExportDialog {...props} isOpen={true} />);
    await screen.findByText("可选演示项目");
    const selectedProject = screen.getAllByRole("checkbox").find((element) => element.closest("label")?.textContent?.includes("可选演示项目"));
    expect(selectedProject).toBeDefined();
    fireEvent.click(selectedProject!);
    const titleInput = screen.getByDisplayValue("个人作品集");
    fireEvent.change(titleInput, { target: { value: "保留的演示站点名称" } });
    view.rerender(<PortfolioExportDialog {...props} isOpen={false} />);
    view.rerender(<PortfolioExportDialog {...props} isOpen={true} />);
    await screen.findByText("可选演示项目");
    const reopenedProject = screen.getAllByRole("checkbox").find((element) => element.closest("label")?.textContent?.includes("可选演示项目"));
    expect((reopenedProject as HTMLInputElement).checked).toBe(false);
    expect(screen.getByDisplayValue("保留的演示站点名称")).toBeDefined();
  });
});
