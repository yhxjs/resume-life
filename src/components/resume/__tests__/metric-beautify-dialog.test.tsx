// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MetricBeautifyDialog } from "../metric-beautify-dialog";
import { jsonFetch } from "@/lib/fetcher";
import type { DescribableItem } from "@/lib/module-descriptions";
import { normalizePolishResult } from "@/lib/polish";
import { stripRichText } from "@/lib/rich-text";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const items: DescribableItem[] = [
  {
    id: "item-1",
    title: "字节跳动 · 前端开发",
    text: "<p>负责首屏优化，耗时从 2.5s 降至 0.8s，提升 30% 性能</p>",
    context: { company: "字节跳动", title: "前端开发" },
  },
];

const draft = "主导首屏性能优化，将加载耗时从 2.5s 降至 0.8s，提升 30% 渲染性能";

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockImplementation(async () => ({ result: { draft } }) as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openDialog(onApply = vi.fn()) {
  render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={items} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（1 条）" }));
  return onApply;
}

describe("MetricBeautifyDialog AI 美化交互", () => {
  it("批量运行时从加载遮罩取消，停止后续条目且不写入", async () => {
    const pending = Promise.withResolvers<{ result: { draft: string } }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const onApply = vi.fn();
    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={[items[0]!, { ...items[0]!, id: "item-2" }]} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(screen.getByRole("status").contains(cancel)).toBe(true);
    fireEvent.click(cancel);
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { pending.resolve({ result: { draft: "已取消的草稿" } }); });
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each(["正文", "职责", "简历", "模块"])("生成后%s变化时阻止旧结果写入，重新生成使用最新材料", async (change) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "根据旧经历生成的草稿" } });
    const onApply = vi.fn();
    const props = { resumeId: "r-1", moduleType: "work" as const, items, onApply };
    const view = render(<MetricBeautifyDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（1 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "单条美化" }));
    await screen.findByText("根据旧经历生成的草稿");
    const latest = {
      ...props,
      resumeId: change === "简历" ? "r-2" : "r-1",
      moduleType: change === "模块" ? "projects" as const : "work" as const,
      items: [{ ...items[0]!,
        text: change === "正文" ? "只参与接口联调，尚未上线" : items[0]!.text,
        context: change === "职责" ? { ...items[0]!.context, title: "接口维护" } : items[0]!.context,
      }],
    };
    view.rerender(<MetricBeautifyDialog {...latest} />);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "原经历或职责信息已变化，请重新美化本条后再写入");
    expect(screen.queryByText("根据旧经历生成的草稿")).toBeNull();
    const write = screen.getByRole("button", { name: "写入选中 1 条" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onApply).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "根据最新材料生成的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "单条重跑" }));
    await screen.findByText("根据最新材料生成的草稿");
    expect(screen.queryByRole("alert")).toBeNull();
    const call = vi.mocked(jsonFetch).mock.calls.at(-1)!;
    expect(call[0]).toBe(`/api/resumes/${latest.resumeId}/polish`);
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      moduleType: latest.moduleType, context: latest.items[0]!.context,
    });
    if (change === "正文") expect(JSON.parse(String(call[1]?.body)).text).toBe("只参与接口联调，尚未上线");
    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith([{ id: "item-1", html: "根据最新材料生成的草稿" }]);
  });

  it.each(["单条", "批量"])("%s生成等待期间正文变化，晚到结果不能覆盖新内容", async (operation) => {
    const pending = Promise.withResolvers<{ result: { draft: string } }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    const onApply = vi.fn();
    const props = { resumeId: "r-1", moduleType: "work" as const, items, onApply };
    const view = render(<MetricBeautifyDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（1 条）" }));
    fireEvent.click(screen.getByRole("button", { name: operation === "单条" ? "单条美化" : "开始美化" }));
    view.rerender(<MetricBeautifyDialog {...props} items={[{ ...items[0]!, text: "等待期间修改的正文" }]} />);
    await act(async () => pending.resolve({ result: { draft: "晚到的旧结果" } }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "原经历或职责信息已变化，请重新美化本条后再写入");
    expect(screen.queryByText("晚到的旧结果")).toBeNull();
    const write = screen.getByRole("button", { name: "写入选中 1 条" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("取消勾选已变化的经历后，其他条目的有效结果仍可写入", async () => {
    const sourceItems = [items[0]!, { ...items[0]!, id: "item-2", title: "第二条经历" }];
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "草稿甲" } }).mockResolvedValueOnce({ result: { draft: "草稿乙" } });
    const onApply = vi.fn();
    const view = render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={sourceItems} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText("草稿乙");
    view.rerender(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={[{ ...sourceItems[0]!, text: "最新原文" }, sourceItems[1]!]} onApply={onApply} />);
    expect((screen.getByRole("button", { name: "写入选中 2 条" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "写入第 1 条" }));
    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith([{ id: "item-2", html: "草稿乙" }]);
  });

  it("仅调整原文富文本格式和标题展示时保留有效结果", async () => {
    const source = { ...items[0]!, text: "<strong>参与接口联调</strong>", context: { company: "公司", title: "开发" } };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "参与接口联调，完善接口文档" } });
    const onApply = vi.fn();
    const view = render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={[source]} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（1 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "单条美化" }));
    await screen.findByText("参与接口联调，完善接口文档");
    view.rerender(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={[{
      ...source, text: '<span style="color: #1d4ed8">参与接口联调</span>', title: "修改展示标题", context: { title: "开发", company: "公司" },
    }]} onApply={onApply} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith([{ id: "item-1", html: "参与接口联调，完善接口文档" }]);
  });

  describe.each([false, true])("已有草稿=%s 时保留生成期间的最新选择", (hasPrevious) => {
    it.each(["取消本条", "全不选", "取消后重新勾选", "只更改其他条目"])("单条生成期间%s，回包不覆盖选择且实际写入一致", async (selectionChange) => {
      const multiItems = [items[0]!, { ...items[0]!, id: "item-2", title: "第二条经历" }];
      const onApply = vi.fn();
      render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));
      if (hasPrevious) {
        vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "原有草稿甲" } })
          .mockResolvedValueOnce({ result: { draft: "可采纳草稿乙" } });
        fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
      } else {
        vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "可采纳草稿乙" } });
        fireEvent.click(screen.getAllByRole("button", { name: "单条美化" })[1]!);
      }
      await screen.findByText("可采纳草稿乙");
      const first = screen.getByRole("checkbox", { name: "写入第 1 条" }) as HTMLInputElement;
      const second = screen.getByRole("checkbox", { name: "写入第 2 条" }) as HTMLInputElement;
      if (selectionChange === "只更改其他条目") fireEvent.click(first);
      const pending = Promise.withResolvers<{ result: { draft: string } }>();
      vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
      fireEvent.click(screen.getAllByRole("button", { name: hasPrevious ? "单条重跑" : "单条美化" })[0]!);
      expect(first.disabled).toBe(false);
      if (selectionChange === "全不选") fireEvent.click(screen.getByRole("button", { name: "全不选" }));
      else if (selectionChange === "只更改其他条目") fireEvent.click(second);
      else {
        fireEvent.click(first);
        if (selectionChange === "取消后重新勾选") fireEvent.click(first);
      }
      await act(async () => pending.resolve({ result: { draft: "可采纳草稿甲" } }));
      expect(screen.getByText("可采纳草稿甲")).toBeTruthy();
      expect(first.checked).toBe(selectionChange === "取消后重新勾选" || selectionChange === "只更改其他条目");
      expect(second.checked).toBe(selectionChange === "取消本条" || selectionChange === "取消后重新勾选");
      expect(onApply).not.toHaveBeenCalled();
      if (selectionChange === "全不选") {
        const write = screen.getByRole("button", { name: "写入选中 0 条" }) as HTMLButtonElement;
        expect(write.disabled).toBe(true);
        fireEvent.click(write);
        expect(onApply).not.toHaveBeenCalled();
        fireEvent.click(second);
      }
      const expected = [
        ...(first.checked ? [{ id: "item-1", html: "可采纳草稿甲" }] : []),
        ...(second.checked ? [{ id: "item-2", html: "可采纳草稿乙" }] : []),
      ];
      fireEvent.click(screen.getByRole("button", { name: `写入选中 ${expected.length} 条` }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith(expected);
    });
  });

  describe.each([false, true])("已有结果=%s 时切换单条生成", (hasPrevious) => {
    it.each(["成功", "失败"])("清除已取消条目的忙碌状态，忽略旧请求的%s回包", async (outcome) => {
      const pending = Promise.withResolvers<{ result: { draft: string } }>();
      const multiItems = [items[0]!, { ...items[0]!, id: "item-2", title: "第二条经历" }];
      const onApply = vi.fn();
      render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));
      if (hasPrevious) {
        vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "原有草稿甲" } })
          .mockResolvedValueOnce({ result: { draft: "原有草稿乙" } });
        fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
        await screen.findByText("原有草稿乙");
      }
      vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce({ result: { draft: "当前草稿乙" } });
      const firstButton = screen.getAllByRole("button", { name: hasPrevious ? "单条重跑" : "单条美化" })[0]!;
      fireEvent.click(firstButton);
      const oldSignal = vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.signal;
      fireEvent.click(screen.getByRole("button", { name: hasPrevious ? "单条重跑" : "单条美化" }));
      await screen.findByText("当前草稿乙");
      expect(oldSignal?.aborted).toBe(true);
      expect(screen.queryAllByText("生成中…")).toHaveLength(0);
      if (hasPrevious) expect(screen.getByText("原有草稿甲")).toBeTruthy();
      await act(async () => {
        if (outcome === "成功") pending.resolve({ result: { draft: "过期草稿甲" } });
        else pending.reject(new Error("过期请求错误"));
      });
      expect(screen.queryByText("过期草稿甲")).toBeNull();
      expect(screen.queryByText(/过期请求错误/)).toBeNull();
      expect(screen.queryAllByText("生成中…")).toHaveLength(0);

      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "当前草稿甲" } });
      fireEvent.click(screen.getAllByRole("button", { name: hasPrevious ? "单条重跑" : "单条美化" })[0]!);
      await screen.findByText("当前草稿甲");
      fireEvent.click(screen.getByRole("button", { name: "写入选中 2 条" }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith([
        { id: "item-1", html: "当前草稿甲" },
        { id: "item-2", html: "当前草稿乙" },
      ]);
    });
  });

  it.each(["成功", "失败"])("单条重跑期间禁止写入隐藏的旧草稿，%s后恢复正确状态", async (outcome) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "原有草稿" } });
    const onApply = openDialog();
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText("原有草稿");
    const pending = Promise.withResolvers<{ result: { draft: string } }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "单条重跑" }));
    expect(screen.queryByText("原有草稿")).toBeNull();
    const write = screen.getByRole("button", { name: "写入选中 1 条" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      if (outcome === "成功") pending.resolve({ result: { draft: "重新生成的草稿" } });
      else pending.reject(new Error("本次生成失败"));
    });
    if (outcome === "失败") {
      expect(screen.getByText("失败：本次生成失败")).toBeTruthy();
      expect((screen.getByRole("button", { name: "写入选中 0 条" }) as HTMLButtonElement).disabled).toBe(true);
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "重新生成的草稿" } });
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await screen.findByText("重新生成的草稿");
    }
    const currentWrite = screen.getByRole("button", { name: "写入选中 1 条" }) as HTMLButtonElement;
    expect(currentWrite.disabled).toBe(false);
    fireEvent.click(currentWrite);
    expect(onApply).toHaveBeenCalledExactlyOnceWith([{ id: "item-1", html: "重新生成的草稿" }]);
  });

  it("单条生成切换到批量生成时取消旧请求，旧回包不解除本批的写入限制", async () => {
    const single = Promise.withResolvers<{ result: { draft: string } }>();
    const batch = Promise.withResolvers<{ result: { draft: string } }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => single.promise)
      .mockImplementationOnce(() => batch.promise)
      .mockResolvedValueOnce({ result: { draft: "批量草稿乙" } });
    const multiItems = [items[0]!, { ...items[0]!, id: "item-2", title: "第二条经历" }];
    const onApply = vi.fn();
    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));
    fireEvent.click(screen.getAllByRole("button", { name: "单条美化" })[0]!);
    const singleSignal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    const batchSignal = vi.mocked(jsonFetch).mock.calls[1]?.[1]?.signal;
    expect(singleSignal?.aborted).toBe(true);
    expect(batchSignal?.aborted).toBe(false);
    await act(async () => single.resolve({ result: { draft: "已取消的单条草稿" } }));
    expect(screen.queryByText("已取消的单条草稿")).toBeNull();
    expect((screen.getByRole("button", { name: "写入选中 0 条" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("等待中…")).toBeTruthy();
    await act(async () => batch.resolve({ result: { draft: "批量草稿甲" } }));
    expect(screen.getByText("批量草稿甲")).toBeTruthy();
    expect(screen.getByText("批量草稿乙")).toBeTruthy();
    expect(screen.queryAllByText("生成中…")).toHaveLength(0);
    expect(screen.queryByText("等待中…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "写入选中 2 条" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith([
      { id: "item-1", html: "批量草稿甲" },
      { id: "item-2", html: "批量草稿乙" },
    ]);
  });

  it("单条重跑时仍可取消，重开后的新草稿不受旧回包影响", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: { draft: "原有草稿" } });
    const onApply = openDialog();
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText("原有草稿");
    const pending = Promise.withResolvers<{ result: { draft: string } }>();
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ result: { draft: "重开后的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "单条重跑" }));
    const oldSignal = vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(oldSignal?.aborted).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（1 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "单条美化" }));
    await screen.findByText("重开后的草稿");
    await act(async () => pending.resolve({ result: { draft: "关闭前的旧草稿" } }));
    expect(screen.queryByText("关闭前的旧草稿")).toBeNull();
    expect(screen.queryAllByText("生成中…")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith([{ id: "item-1", html: "重开后的草稿" }]);
  });

  it("关闭并卸载时取消当前请求且不再排队下一条", async () => {
    let resolveFirst: ((value: { result: { draft: string } }) => void) | undefined;
    vi.mocked(jsonFetch)
      .mockImplementationOnce((_url, init) => {
        return new Promise((resolve) => {
          resolveFirst = resolve as never;
          expect(init?.signal).toBeInstanceOf(AbortSignal);
        });
      })
      .mockResolvedValueOnce({ result: { draft } } as never);

    const multiItems: DescribableItem[] = [
      { ...items[0]!, id: "item-1" },
      { ...items[0]!, id: "item-2", title: "第二条经历" },
    ];
    const { unmount } = render(
      <MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));

    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);

    resolveFirst?.({ result: { draft } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("打开后点击开始美化，展示预览并默认勾选成功条目", async () => {
    openDialog();

    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));

    // 生成完成后展示预览草稿，且成功条目自动勾选
    await screen.findByText(/主导首屏性能优化/);
    const checkbox = screen.getByRole("checkbox", { name: "写入第 1 条" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByRole("button", { name: "写入选中 1 条" })).toBeTruthy();
  });

  it("切换润色模式后重新生成，POST 请求体携带 quantify 模式", async () => {
    openDialog();

    fireEvent.click(screen.getByRole("button", { name: /深度量化扩写/ }));
    const quantify = screen.getByRole("button", { name: /深度量化扩写/ });
    expect(quantify.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText(/主导首屏性能优化/);

    await waitFor(() => {
      const call = vi.mocked(jsonFetch).mock.calls[0];
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ moduleType: "work", mode: "quantify" });
    });
  });

  it("点击写入选中条目，onApply 收到 id 与富文本 HTML 后关闭弹窗", async () => {
    const onApply = openDialog();

    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText(/主导首屏性能优化/);

    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const updates = onApply.mock.calls[0]![0] as { id: string; html: string }[];
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("item-1");
    expect(updates[0]!.html).toContain("2.5s");
    // 弹窗关闭后触发按钮重新可见
    expect(screen.getByRole("button", { name: "✨ AI 美化（1 条）" })).toBeTruthy();
  });

  it("当模型返回草稿中带有公司与职位抬头时自动剥离展示与写入", async () => {
    vi.mocked(jsonFetch).mockImplementation(
      async () =>
        ({
          result: {
            draft:
              "字节跳动 | 前端开发\n• 主导首屏性能优化，将加载耗时从 2.5s 降至 0.8s，提升 30% 渲染性能",
          },
        }) as never
    );
    const onApply = openDialog();

    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText(/主导首屏性能优化/);

    // 确认预览中不包含抬头行
    expect(screen.queryByText("字节跳动 | 前端开发")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const updates = onApply.mock.calls[0]![0] as { id: string; html: string }[];
    expect(updates[0]!.html).not.toContain("字节跳动 | 前端开发");
  });

  it("支持选择部分条目进行美化，未勾选的条目不发起生成请求", async () => {
    const multiItems: DescribableItem[] = [
      {
        id: "item-1",
        title: "经历一",
        text: "<p>实现性能优化</p>",
        context: { company: "公司A", title: "岗位A" },
      },
      {
        id: "item-2",
        title: "经历二",
        text: "<p>重构核心架构</p>",
        context: { company: "公司B", title: "岗位B" },
      },
    ];

    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));

    // 取消勾选第 2 条
    const checkbox2 = screen.getByRole("checkbox", { name: "写入第 2 条" });
    fireEvent.click(checkbox2);

    // 生成按钮应变为生成所选 1 条
    const genBtn = screen.getByRole("button", { name: "开始美化所选 (1 条)" });
    fireEvent.click(genBtn);

    await screen.findByText(/主导首屏性能优化/);

    // 仅针对第 1 条发起了请求
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.body));
    expect(callBody.text.trim()).toBe("实现性能优化");
  });

  it("支持全选与全不选切换，未勾选任何条目时生成按钮禁用", async () => {
    const multiItems: DescribableItem[] = [
      { id: "item-1", title: "经历一", text: "<p>内容一</p>", context: { company: "公司A" } },
      { id: "item-2", title: "经历二", text: "<p>内容二</p>", context: { company: "公司B" } },
    ];

    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));

    // 点击全不选
    const toggleAllBtn = screen.getByRole("button", { name: "全不选" });
    fireEvent.click(toggleAllBtn);

    // 此时已选 0 条，生成按钮应显示提示并禁用
    const genBtn = screen.getByRole("button", { name: "请选择条目" });
    expect(genBtn.hasAttribute("disabled")).toBe(true);

    // 再次点击切换为全选
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByRole("button", { name: "开始美化" })).toBeTruthy();
  });

  it("支持单条条目独立生成，且生成后自动勾选并可写入", async () => {
    const multiItems: DescribableItem[] = [
      { id: "item-1", title: "经历一", text: "<p>内容一</p>", context: { company: "公司A" } },
      { id: "item-2", title: "经历二", text: "<p>内容二</p>", context: { company: "公司B" } },
    ];
    const onApply = vi.fn();

    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));

    // 先全不选
    fireEvent.click(screen.getByRole("button", { name: "全不选" }));

    // 点击第 1 条的「单条美化」
    const singleBtns = screen.getAllByRole("button", { name: "单条美化" });
    fireEvent.click(singleBtns[0]!);

    await screen.findByText(/主导首屏性能优化/);
    expect(vi.mocked(jsonFetch)).toHaveBeenCalledTimes(1);

    // 第 1 条单测生成成功后自动选中
    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    const updates = onApply.mock.calls[0]![0] as { id: string; html: string }[];
    expect(updates[0]!.id).toBe("item-1");
  });

  it("重新生成选中的部分条目时，保留未选条目已生成的草稿", async () => {
    let callCount = 0;
    vi.mocked(jsonFetch).mockImplementation(async () => {
      callCount += 1;
      return { result: { draft: `生成结果 ${callCount}` } } as never;
    });

    const multiItems: DescribableItem[] = [
      { id: "item-1", title: "经历一", text: "<p>第一条</p>", context: { company: "公司A" } },
      { id: "item-2", title: "经历二", text: "<p>第二条</p>", context: { company: "公司B" } },
    ];

    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));

    // 先全部生成
    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText("生成结果 1");
    await screen.findByText("生成结果 2");

    // 取消勾选第 1 条，仅保留第 2 条
    const checkbox1 = screen.getByRole("checkbox", { name: "写入第 1 条" });
    fireEvent.click(checkbox1);

    // 重新生成所选 1 条
    const regenBtn = screen.getByRole("button", { name: "重新生成所选 (1 条)" });
    fireEvent.click(regenBtn);

    await screen.findByText("生成结果 3");

    // 第 1 条的结果仍然保留在界面上
    expect(screen.getByText("生成结果 1")).toBeTruthy();
    // 第 2 条的结果更新为生成结果 3
    expect(screen.getByText("生成结果 3")).toBeTruthy();
  });

  it("只勾选部分条目生成时，未选中的条目不显示等待中", async () => {
    let resolvePromise: (value: { result: { draft: string } }) => void;
    vi.mocked(jsonFetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve as never;
        })
    );

    const multiItems: DescribableItem[] = [
      { id: "item-1", title: "经历一", text: "<p>第一条</p>", context: { company: "公司A" } },
      { id: "item-2", title: "经历二", text: "<p>第二条</p>", context: { company: "公司B" } },
    ];

    render(<MetricBeautifyDialog resumeId="r-1" moduleType="work" items={multiItems} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ AI 美化（2 条）" }));

    // 取消勾选第 1 条，仅勾选第 2 条
    const checkbox1 = screen.getByRole("checkbox", { name: "写入第 1 条" });
    fireEvent.click(checkbox1);

    // 点击开始美化所选 1 条
    fireEvent.click(screen.getByRole("button", { name: "开始美化所选 (1 条)" }));

    // 第 2 条处于「生成中…」
    expect(screen.getByText("生成中…")).toBeTruthy();
    // 未勾选的第 1 条绝不应出现「等待中…」
    expect(screen.queryByText("等待中…")).toBeNull();

    // 完成请求
    resolvePromise!({ result: { draft: "完成草稿" } });
    await screen.findByText("完成草稿");
  });

  it("美化结果从归一化到预览和写入保留技术字面量，仅真实换行分行", async () => {
    const texts = [String.raw`维护 C:\new\resume，处理 /\r\n|\n/g`, "文档记录 <br>、<BR />、<template> 和 &amp; 字面量"];
    vi.mocked(jsonFetch).mockImplementation(
      async () =>
        ({
          result: normalizePolishResult({ draft: texts.map((text) => `• ${text}`).join("\r\n") }),
        }) as never
    );
    const onApply = openDialog();

    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    const preview = await screen.findByText(/维护 C:/);
    expect(preview.textContent).toBe(texts.map((text) => `• ${text}`).join("\n"));
    expect(preview.querySelector("template, br")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const updates = onApply.mock.calls[0]![0] as { id: string; html: string }[];
    expect(stripRichText(updates[0]!.html)).toBe(texts.map((text) => `• ${text}`).join("\n"));
  });
});
