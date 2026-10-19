// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MetricBeautifyDialog } from "../metric-beautify-dialog";
import { jsonFetch } from "@/lib/fetcher";
import type { DescribableItem } from "@/lib/module-descriptions";

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
  vi.mocked(jsonFetch).mockImplementation(async () => ({ result: { draft } }) as never);
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

  it("当模型草稿包含字面量 \\n 时能正确还原换行符，写入时拆分为多行", async () => {
    vi.mocked(jsonFetch).mockImplementation(
      async () =>
        ({
          result: {
            draft:
              "• 主导追番核心模块，提升 30% 效率。\\n• 设计账号认证，降低 20% 风险。",
          },
        }) as never
    );
    const onApply = openDialog();

    fireEvent.click(screen.getByRole("button", { name: "开始美化" }));
    await screen.findByText(/主导追番核心模块/);

    // 确认预览中不出现字面量 \n 字符
    expect(screen.queryByText(/\\n/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "写入选中 1 条" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const updates = onApply.mock.calls[0]![0] as { id: string; html: string }[];
    // 写入的 html 应该包含真实的换行符，并且不包含字面量 \\n 字符
    expect(updates[0]!.html).not.toContain("\\n");
    expect(updates[0]!.html).toContain("\n");
  });
});
