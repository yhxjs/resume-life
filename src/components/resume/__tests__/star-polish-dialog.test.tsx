// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StarPolishDialog } from "../star-polish-dialog";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const mockPolishResult = {
  star: {
    situation: "系统老旧，加载耗时过长",
    task: "主导性能重构与指标量化",
    action: "设计分包加载与虚拟滚动方案",
    result: "首屏加载耗时从 3s 降至 0.8s",
  },
  quantifiedTips: [
    {
      dimension: "性能指标",
      metric: "首屏耗时",
      tip: "建议统计真实 P90 数据",
      example: "[请填入真实首屏耗时，例如：0.8s]",
    },
  ],
  draft: "· 主导前端架构重构，首屏加载降低 [请填入真实耗时]\n· 优化长列表滚动，内存占用下降 [请填入真实比例]",
  draftItems: [
    "主导前端架构重构，首屏加载降低 [请填入真实耗时]",
    "优化长列表滚动，内存占用下降 [请填入真实比例]",
  ],
  highlights: ["前端架构", "性能调优"],
};

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockImplementation(async () => ({ result: mockPolishResult }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("StarPolishDialog STAR 润色与量化扩写", () => {
  it("关闭弹窗后将焦点归还给原触发按钮", () => {
    render(<StarPolishDialog resumeId="1" moduleType="summary" currentText="自我评价" onApply={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "✨ AI 润色" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "✨ AI 润色" }));
  });

  it.each(["只选第二项", "删除首项", "重排后只选第二项", "合并多个来源", "连续两轮"])("二次精简保留原始来源：%s", async (scenario) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: {
      ...mockPolishResult,
      draftItems: ["生成经历甲", "生成经历乙"],
      draftItemDetails: [
        { text: "生成经历甲", sourceIndices: [1] },
        { text: "生成经历乙", sourceIndices: [2] },
      ],
    } } as never).mockResolvedValue({ result: {
      ...mockPolishResult, draftItems: ["精简后的经历"],
      draftItemDetails: [{ text: "精简后的经历", sourceIndices: scenario === "合并多个来源" ? [1, 2] : [1] }],
    } } as never);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="" currentItems={["原始经历甲", "原始经历乙"]} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByLabelText("勾选采纳第 2 项");
    if (scenario === "删除首项") fireEvent.click(screen.getAllByRole("button", { name: "× 删除" })[0]!);
    else if (scenario === "重排后只选第二项") {
      fireEvent.click(screen.getAllByTitle("上移此项")[1]!);
      fireEvent.click(screen.getByLabelText("勾选采纳第 2 项"));
    } else if (scenario !== "合并多个来源") fireEvent.click(screen.getByLabelText("勾选采纳第 1 项"));
    fireEvent.click(screen.getByRole("button", { name: "🪄 智能精简合并" }));
    await screen.findByLabelText("经历条目第 1 项");
    await waitFor(() => expect(screen.queryByLabelText("勾选采纳第 2 项")).toBeNull());
    if (scenario === "连续两轮") {
      fireEvent.click(screen.getByRole("button", { name: "🪄 智能精简合并" }));
      await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.queryByText("AI 深度精简合并中…")).toBeNull());
    }
    fireEvent.click(screen.getByRole("button", { name: "展开所有原文对比" }));
    const comparison = screen.getByTestId("source-comparison-0");
    expect(comparison.textContent).toContain("原始经历乙");
    if (scenario === "合并多个来源") {
      expect(comparison.textContent).toContain("原始经历甲");
      expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body)).sourceParagraphs).toEqual(["生成经历甲", "生成经历乙"]);
    } else expect(comparison.textContent).not.toContain("原始经历甲");
  });

  it.each(["Escape", "背景", "关闭", "取消"])("%s 关闭重开时，旧响应不能回填或被采纳", async (close) => {
    const pending = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    const onApply = vi.fn();
    const props = { resumeId: "1", moduleType: "work" as const, currentText: "旧描述", onApply };
    const view = render(<StarPolishDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    const signal = vi.mocked(jsonFetch).mock.lastCall![1]?.signal;
    if (close === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (close === "背景") fireEvent.click(screen.getByRole("dialog"));
    else fireEvent.click(screen.getByRole("button", { name: close === "关闭" ? "关闭弹窗" : "取消" }));
    view.rerender(<StarPolishDialog {...props} currentText="新描述" />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    expect((screen.getByRole("button", { name: "开始 AI 智能润色" }) as HTMLButtonElement).disabled).toBe(false);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ result: { ...mockPolishResult, draft: "旧结果", draftItems: ["旧结果"] } }));
    expect(screen.queryByText(/推荐排版内容/)).toBeNull();
    expect(screen.queryByText("旧结果")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply.mock.calls[0]![0]).not.toContain("旧结果");
  });

  it.each(["resolve", "reject"])("旧请求 %s/finally 不能清除新任务的加载态或错误", async (outcome) => {
    const old = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    const current = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="描述" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === "resolve") old.resolve({ result: mockPolishResult });
      else old.reject(new Error("旧请求失败"));
    });
    expect((screen.getByRole("button", { name: "AI 深度分析润色中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("旧请求失败")).toBeNull();
    expect(screen.queryByText(/推荐排版内容/)).toBeNull();
    await act(async () => current.resolve({ result: { ...mockPolishResult, draft: "新结果", draftItems: ["新结果"] } }));
    expect(screen.getByText(/推荐排版内容/)).toBeTruthy();
  });

  it("卸载后中止在途请求", async () => {
    const pending = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    const view = render(<StarPolishDialog resumeId="1" moduleType="work" currentText="描述" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    const signal = vi.mocked(jsonFetch).mock.lastCall![1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ result: mockPolishResult }));
  });

  it("生成期间展示加载中遮罩，且支持从遮罩内点击取消中止请求", async () => {
    const pending = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="描述" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    // 遮罩应出现并带有状态文案和取消按钮
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("AI STAR 原则深度润色中…")).toBeTruthy();
    const cancelBtn = screen.getByRole("button", { name: "取消生成" });
    expect(cancelBtn).toBeTruthy();

    // 点击遮罩内的取消按钮
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole("status")).toBeNull();
    const signal = vi.mocked(jsonFetch).mock.lastCall![1]?.signal;
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ result: mockPolishResult }));
  });

  it("点击生成后默认按多项展示并支持勾选采纳与写入", async () => {
    const onApply = vi.fn();
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText="负责前端开发"
        onApply={onApply}
      />
    );

    // 打开弹窗
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // 点击生成
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText(/推荐排版内容/)).toBeTruthy();
    });

    // 验证多项展示中渲染了条目序号与内容
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("全选 (2/2)")).toBeTruthy();

    // 默认点击写入
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [combinedText, items, mode] = onApply.mock.calls[0]!;
    expect(items).toEqual([
      "主导前端架构重构，首屏加载降低 [请填入真实耗时]",
      "优化长列表滚动，内存占用下降 [请填入真实比例]",
    ]);
    expect(mode).toBe("replace");
    expect(combinedText).toContain("主导前端架构重构");
  });

  it("支持单项取消勾选，仅写入选中的条目", async () => {
    const onApply = vi.fn();
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="projects"
        currentText=""
        onApply={onApply}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
    });

    // 取消第一项勾选
    const check1 = screen.getByLabelText("勾选采纳第 1 项");
    fireEvent.click(check1);

    expect(screen.getByText("全选 (1/2)")).toBeTruthy();

    // 点击写入
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [, items] = onApply.mock.calls[0]!;
    expect(items).toEqual(["优化长列表滚动，内存占用下降 [请填入真实比例]"]);
  });

  it("支持添加新项和删除单项", async () => {
    const onApply = vi.fn();
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText=""
        onApply={onApply}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
    });

    // 删除第 2 项
    const deleteButtons = screen.getAllByRole("button", { name: "× 删除" });
    fireEvent.click(deleteButtons[1]!);

    expect(screen.queryByText("#2")).toBeNull();
    expect(screen.getByText("全选 (1/1)")).toBeTruthy();

    // 点击添加新项
    fireEvent.click(screen.getByRole("button", { name: "+ 添加一项经历描述" }));
    expect(screen.getByText("#2")).toBeTruthy();
  });

  it("支持切换为整段编辑模式并保留换行与前缀", async () => {
    const onApply = vi.fn();
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText=""
        onApply={onApply}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
    });

    // 切换到整段编辑
    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));

    expect(screen.getByLabelText("推荐排版草稿")).toBeTruthy();

    // 写入
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("支持直接选择『🪄 智能精简合并』模式生成精炼条目", async () => {
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="projects"
        currentText="许多流水账步骤"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));

    // 切换到精简合并模式
    const condenseModeBtn = screen.getByRole("button", {
      name: "🪄 智能精简合并（提纯聚合，去粗取精）",
    });
    fireEvent.click(condenseModeBtn);

    // 按钮文案随之切换
    const generateBtn = screen.getByRole("button", { name: "开始 AI 智能精简合并" });
    fireEvent.click(generateBtn);

    expect(jsonFetch).toHaveBeenCalledWith(
      "/api/resumes/1/polish",
      expect.objectContaining({
        body: expect.stringContaining('"mode":"condense"'),
      })
    );
  });

  it("支持在已生成的多项列表中点击『🪄 智能精简合并』对勾选条目执行就地二次提纯", async () => {
    const condensedResult = {
      ...mockPolishResult,
      draft: "• 深度整合前端架构与长列表优化，系统响应与内存表现整体提升 [请填入真实数据]",
      draftItems: [
        "深度整合前端架构与长列表优化，系统响应与内存表现整体提升 [请填入真实数据]",
      ],
    };

    vi.mocked(jsonFetch)
      .mockImplementationOnce(async () => ({ result: mockPolishResult }) as never)
      .mockImplementationOnce(async () => ({ result: condensedResult }) as never);

    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="projects"
        currentText="流水账描述"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
      expect(screen.getByText("#2")).toBeTruthy();
    });

    // 点击列表工具条上的『🪄 智能精简合并』按钮
    const inPlaceCondenseBtn = screen.getByRole("button", { name: "🪄 智能精简合并" });
    fireEvent.click(inPlaceCondenseBtn);

    // 验证第二次请求使用了 mode: "condense"
    await waitFor(() => {
      expect(jsonFetch).toHaveBeenCalledTimes(2);
      expect(jsonFetch).toHaveBeenLastCalledWith(
        "/api/resumes/1/polish",
        expect.objectContaining({
          body: expect.stringContaining('"mode":"condense"'),
        })
      );
    });

    // 验证合并后条目更新为 1 条精华条目
    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
      expect(screen.queryByText("#2")).toBeNull();
      expect(screen.getByText("全选 (1/1)")).toBeTruthy();
    });
  });

  it("点击『🪄 智能精简合并』失败时，报错信息展示在智能精简合并按钮下方", async () => {
    vi.mocked(jsonFetch)
      .mockImplementationOnce(async () => ({ result: mockPolishResult }) as never)
      .mockImplementationOnce(async () => {
        throw new Error("精简合并服务响应超时，请稍后重试");
      });

    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="projects"
        currentText="流水账描述"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
    });

    // 点击智能精简合并按钮
    const inPlaceCondenseBtn = screen.getByRole("button", { name: "🪄 智能精简合并" });
    fireEvent.click(inPlaceCondenseBtn);

    // 报错信息应当出现在智能精简合并按钮下方
    await waitFor(() => {
      const errorEl = screen.getByTestId("condense-error");
      expect(errorEl).toBeTruthy();
      expect(errorEl.textContent).toContain("精简合并服务响应超时，请稍后重试");
    });

    // 重新点击开始润色，报错信息应当被清空
    vi.mocked(jsonFetch).mockImplementationOnce(async () => ({ result: mockPolishResult }) as never);
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    expect(screen.queryByTestId("condense-error")).toBeNull();
  });

  it("待润色内容草稿支持按多条展示，与简介编辑页一致", async () => {
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText=""
        currentItems={["负责前端架构重构", "优化长列表性能，帧率提升30%"]}
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));

    // 验证弹窗内展示了多行待润色内容草稿
    expect(screen.getByLabelText("待润色描述第 1 行")).toBeTruthy();
    expect(screen.getByLabelText("待润色描述第 2 行")).toBeTruthy();
    expect(screen.getByText("+ 添加一行描述")).toBeTruthy();
    expect(screen.getByRole("button", { name: "• 无序列表" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1. 有序列表" })).toBeTruthy();

    // 切换为有序列表
    fireEvent.click(screen.getByRole("button", { name: "1. 有序列表" }));
    expect(screen.getByText("1.")).toBeTruthy();
    expect(screen.getByText("2.")).toBeTruthy();

    // 点击添加一行
    fireEvent.click(screen.getByRole("button", { name: "+ 添加一行描述" }));
    expect(screen.getByLabelText("待润色描述第 3 行")).toBeTruthy();

    // 点击生成，验证发送的文本包含多行内容
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    expect(jsonFetch).toHaveBeenCalledWith(
      "/api/resumes/1/polish",
      expect.objectContaining({
        body: expect.stringContaining("负责前端架构重构"),
      })
    );
    expect(jsonFetch).toHaveBeenCalledWith(
      "/api/resumes/1/polish",
      expect.objectContaining({
        body: expect.stringContaining("优化长列表性能，帧率提升30%"),
      })
    );
  });

  it("待润色内容草稿支持删除和调整顺序", async () => {
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="projects"
        currentText=""
        currentItems={["第一项：组件库设计", "第二项：微前端架构"]}
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));

    // 验证有 2 行
    expect(screen.getByLabelText("待润色描述第 1 行")).toBeTruthy();
    expect(screen.getByLabelText("待润色描述第 2 行")).toBeTruthy();

    // 删除第 2 行
    const deleteButtons = screen.getAllByTitle("删除该行");
    expect(deleteButtons).toHaveLength(2);
    fireEvent.click(deleteButtons[1]!);

    // 删除后仅剩 1 行
    expect(screen.getByLabelText("待润色描述第 1 行")).toBeTruthy();
    expect(screen.queryByLabelText("待润色描述第 2 行")).toBeNull();
  });

  it("自我评价模块渲染『✨ AI 润色』按钮与对应标题和专属提示", () => {
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="summary"
        currentText="多年全栈开发经验"
        onApply={vi.fn()}
      />
    );

    // 触发按钮为 "✨ AI 润色"
    const triggerBtn = screen.getByRole("button", { name: "✨ AI 润色" });
    expect(triggerBtn).toBeTruthy();

    fireEvent.click(triggerBtn);

    // 弹窗标题为 "✨ 自我评价智能润色"
    expect(screen.getByText("✨ 自我评价智能润色")).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("自我评价智能润色");
  });

  it("自我评价模块待润色草稿与生成结果均采用多项展示形式", async () => {
    const summaryPolishResult = {
      star: null,
      quantifiedTips: [],
      draft: "• 精通前端工程化体系搭建\n• 具备高并发后端架构经验",
      draftItems: [
        "精通前端工程化体系搭建",
        "具备高并发后端架构经验",
      ],
      highlights: ["工程化", "高并发"],
    };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: summaryPolishResult } as never);

    const onApply = vi.fn();
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="summary"
        currentText=""
        currentItems={["5年全栈开发", "熟悉云原生"]}
        onApply={onApply}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ AI 润色" }));

    // 待润色草稿为多行条目
    expect(screen.getByLabelText("待润色自我评价第 1 行")).toBeTruthy();
    expect(screen.getByLabelText("待润色自我评价第 2 行")).toBeTruthy();
    expect(screen.getByText("+ 添加一行评价")).toBeTruthy();

    // 点击开始润色
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    // 生成结果默认为多项列表视图
    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
      expect(screen.getByText("#2")).toBeTruthy();
      expect(screen.getByLabelText("自我评价第 1 项")).toBeTruthy();
      expect(screen.getByLabelText("自我评价第 2 项")).toBeTruthy();
    });

    // 确认写入简历
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onApply).toHaveBeenCalledWith(
      expect.stringContaining("精通前端工程化体系搭建"),
      ["精通前端工程化体系搭建", "具备高并发后端架构经验"],
      "replace"
    );
  });

  it("生成失败时报错信息展示在生成按钮下方而非弹窗顶部", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("网络异常，润色服务不可用"));

    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText="负责核心系统研发"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    const generateBtn = screen.getByRole("button", { name: "开始 AI 智能润色" });
    fireEvent.click(generateBtn);

    const errorEl = await screen.findByText("网络异常，润色服务不可用");
    expect(errorEl).toBeTruthy();

    // 验证错误信息节点在生成按钮之后（位于按钮下方）
    expect(generateBtn.compareDocumentPosition(errorEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([false, true])("三种模式生成后定位内容遵循减少动效偏好 %s", async (reduce) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduce })));
    const behavior = reduce ? "auto" : "smooth";
    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    // 1. STAR 模式：生成成功后应跳转到 STAR 原则维度拆解
    const { unmount } = render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText="经历描述"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByTestId("star-breakdown-section")).toBeTruthy();
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior, block: "start" })
      );
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(
      screen.getByTestId("star-breakdown-section")
    );

    unmount();
    scrollIntoViewMock.mockClear();

    // 2. 深度量化扩写模式：生成成功后同样跳转到 STAR 原则维度拆解
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText="经历描述"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "📊 深度量化扩写（挖掘度量指标与业务收益）",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByTestId("star-breakdown-section")).toBeTruthy();
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior, block: "start" })
      );
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(
      screen.getByTestId("star-breakdown-section")
    );

    cleanup();
    scrollIntoViewMock.mockClear();

    // 3. 智能精简合并模式：生成成功后应跳转到推荐排版内容
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText="经历描述"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "🪄 智能精简合并（提纯聚合，去粗取精）",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能精简合并" }));

    await waitFor(() => {
      expect(screen.getByTestId("recommended-draft-section")).toBeTruthy();
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith(
        expect.objectContaining({ behavior, block: "start" })
      );
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(
      screen.getByTestId("recommended-draft-section")
    );
  });

  it("支持单项点击展开原文对比，向上展开来源原文卡片，并可再次点击收起", async () => {
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText=""
        currentItems={["负责前端性能重构，首屏加载优化"]}
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
    });

    // 初始状态下对比卡片未展开
    expect(screen.queryByTestId("source-comparison-0")).toBeNull();

    // 找到展开原文对比按钮并点击
    const expandBtn = screen.getByRole("button", { name: "展开第 1 项来源原文对比" });
    expect(expandBtn).toBeTruthy();
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expandBtn);

    // 展开后应显示来源原文对比卡片
    const comparisonCard = await screen.findByTestId("source-comparison-0");
    expect(comparisonCard).toBeTruthy();
    expect(comparisonCard.textContent).toContain("来源原文对比");
    expect(comparisonCard.textContent).toContain("负责前端性能重构，首屏加载优化");
    expect(expandBtn.getAttribute("aria-expanded")).toBe("true");

    // 再次点击收起
    fireEvent.click(expandBtn);
    expect(screen.queryByTestId("source-comparison-0")).toBeNull();
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
  });

  it("支持多来源段落展示与动态切换关联段落", async () => {
    const multiSourceResult = {
      ...mockPolishResult,
      draftItems: [
        "重构微服务接入网关并设计分布式限流熔断体系 [请填入真实数据]",
      ],
      draftItemDetails: [
        {
          text: "重构微服务接入网关并设计分布式限流熔断体系 [请填入真实数据]",
          sourceIndices: [1, 2], // 关联段落 1 和段落 2
        },
      ],
    };

    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: multiSourceResult } as never);

    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="projects"
        currentText=""
        currentItems={[
          "段落一：主导网关重构，统一鉴权与路由",
          "段落二：引入 Sentinel 实现高并发熔断限流治理",
          "段落三：梳理跨系统对账与补偿机制",
        ]}
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
    });

    // 展开对比卡片
    const expandBtn = screen.getByRole("button", { name: "展开第 1 项来源原文对比" });
    fireEvent.click(expandBtn);

    const comparisonCard = await screen.findByTestId("source-comparison-0");
    expect(comparisonCard).toBeTruthy();

    // 验证多来源段落正确呈现（段落 1 和段落 2）
    expect(comparisonCard.textContent).toContain("段落一：主导网关重构");
    expect(comparisonCard.textContent).toContain("段落二：引入 Sentinel");
    expect(comparisonCard.textContent).toContain("（已关联 2/3 个来源段落）");

    // 点击关联『段落 3』
    const linkP3Btn = screen.getByRole("button", { name: "点击关联段落 3" });
    fireEvent.click(linkP3Btn);

    // 验证现在关联了 3 个段落
    expect(comparisonCard.textContent).toContain("段落三：梳理跨系统对账与补偿机制");
    expect(comparisonCard.textContent).toContain("（已关联 3/3 个来源段落）");

    // 点击取消关联『段落 1』
    const unlinkP1Btn = screen.getByRole("button", { name: "点击取消关联段落 1" });
    fireEvent.click(unlinkP1Btn);
    expect(comparisonCard.textContent).not.toContain("段落一：主导网关重构");
    expect(comparisonCard.textContent).toContain("（已关联 2/3 个来源段落）");
  });

  it.each([
    { name: "仅保留第二项", draft: null, expected: ["乙"] },
    { name: "删除首项", draft: "• 润色结果乙", expected: ["乙"] },
    { name: "重排条目", draft: "• 润色结果乙\n• 润色结果甲", expected: ["乙", "甲"] },
    { name: "改写和新增条目", draft: "• 改写后的经历\n• 润色结果乙\n• 新增的经历", expected: [null, "乙", null] },
  ])("整段编辑往返后$name的来源不会错配", async ({ draft, expected }) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: {
      ...mockPolishResult,
      draftItems: ["润色结果甲", "润色结果乙"],
      draftItemDetails: [
        { text: "润色结果甲", sourceIndices: [1] },
        { text: "润色结果乙", sourceIndices: [2] },
      ],
    } } as never);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="" currentItems={["原始经历甲", "原始经历乙"]} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "展开所有原文对比" }));
    if (draft === null) fireEvent.click(screen.getByLabelText("勾选采纳第 1 项"));
    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
    if (draft !== null) {
      const editor = screen.getByLabelText("推荐排版草稿");
      editor.textContent = draft;
      fireEvent.input(editor);
    }
    fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
    expect(screen.queryByTestId("source-comparison-0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开所有原文对比" }));
    expected.forEach((source, idx) => {
      const comparison = screen.getByTestId(`source-comparison-${idx}`);
      if (source === null) {
        expect(comparison.textContent).toContain("来源待关联");
        expect(comparison.textContent).not.toContain("原始经历");
      } else {
        expect(comparison.textContent).toContain(`原始经历${source}`);
        expect(comparison.textContent).not.toContain(`原始经历${source === "甲" ? "乙" : "甲"}`);
      }
    });
  });

  it("整段内容清空后返回列表不会恢复旧结果", async () => {
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="经历" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
    const editor = screen.getByLabelText("推荐排版草稿");
    editor.textContent = "";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
    expect(screen.queryByText("#1")).toBeNull();
    expect(screen.queryByLabelText("经历条目第 1 项")).toBeNull();
  });

  it("支持通过顶部快捷按钮一键展开与收起所有条目的原文对比", async () => {
    render(
      <StarPolishDialog
        resumeId="1"
        moduleType="work"
        currentText="负责核心模块研发"
        onApply={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeTruthy();
      expect(screen.getByText("#2")).toBeTruthy();
    });

    // 初始均未展开
    expect(screen.queryByTestId("source-comparison-0")).toBeNull();
    expect(screen.queryByTestId("source-comparison-1")).toBeNull();

    // 点击『展开所有原文对比』
    const toggleAllBtn = screen.getByRole("button", { name: "展开所有原文对比" });
    fireEvent.click(toggleAllBtn);

    // 两个条目的对比区均已展开
    expect(await screen.findByTestId("source-comparison-0")).toBeTruthy();
    expect(await screen.findByTestId("source-comparison-1")).toBeTruthy();

    // 按钮文案切换为『收起所有原文对比』
    expect(screen.getByRole("button", { name: "收起所有原文对比" })).toBeTruthy();

    // 再次点击一键收起
    fireEvent.click(screen.getByRole("button", { name: "收起所有原文对比" }));
    expect(screen.queryByTestId("source-comparison-0")).toBeNull();
    expect(screen.queryByTestId("source-comparison-1")).toBeNull();
  });
});
