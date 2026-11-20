// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StarPolishDialog } from "../star-polish-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { normalizePolishResult } from "@/lib/polish";
import { stripRichText } from "@/lib/rich-text";

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
  describe.each(["work", "projects", "summary"] as const)("%s 的模型纯文本结果", (moduleType) => {
    it.each(["结构化条目", "仅整段"])("%s 在编辑、视图切换和二次精简后保留技术正文", async (shape) => {
      const texts = [
        String.raw`封装 Array<T> 与 <template>，记录 &amp; 和 C:\new\resume 字面量`,
        String.raw`文档保留 <strong>、<br> 与 &lt;tag&gt;，识别 /\r\n|\n/g，P99 < 200ms`,
      ];
      const condensed = String.raw`维护 Map<K, V> 与 <template>，记录 &amp;、<br>、&lt;tag&gt; 和 C:\new\resume`;
      const result = normalizePolishResult({
        draft: texts.map((text) => `• ${text}`).join("\n"),
        ...(shape === "结构化条目" ? { draftItems: texts.map((text, index) => ({ text, sourceIndices: [index + 1] })) } : {}),
      });
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result }).mockResolvedValueOnce({ result: normalizePolishResult({
        draft: `• ${condensed}`, draftItems: [{ text: condensed, sourceIndices: [1, 2] }],
      }) });
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType={moduleType} currentText="" currentItems={["原始经历甲", "原始经历乙"]} onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: moduleType === "summary" ? "✨ AI 润色" : "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#2");
      const label = moduleType === "summary" ? "自我评价" : "经历条目";
      for (const [index, text] of texts.entries()) {
        const editor = screen.getByLabelText(`${label}第 ${index + 1} 项`);
        await waitFor(() => expect(editor.textContent).toBe(text));
        expect(editor.querySelector("template, strong")).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      expect(screen.getByLabelText("推荐排版草稿").textContent).toContain(texts[0]);
      expect(screen.getByLabelText("推荐排版草稿").textContent).toContain(texts[1]);
      fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
      if (shape === "结构化条目") {
        fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
        expect(screen.getByTestId("source-comparison-0").textContent).toContain("原始经历甲");
        expect(screen.getByTestId("source-comparison-0").textContent).not.toContain("原始经历乙");
      }
      fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
      if (shape === "仅整段") {
        expect(jsonFetch).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("condense-error").textContent).toContain("当前草稿已保留");
        for (let index = 0; index < texts.length; index++) {
          fireEvent.click(within(screen.getByTestId(`source-comparison-${index}`))
            .getByRole("button", { name: `点击关联段落 ${index + 1}` }));
        }
        fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
      }
      const body = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body));
      expect(body.sourceParagraphs).toEqual(texts);
      expect(body.originalSourceParagraphs).toEqual(["原始经历甲", "原始经历乙"]);
      expect(body.text).toBe(texts.map((text) => `• ${text}`).join("\n"));
      await waitFor(() => expect(screen.queryByLabelText(`${label}第 2 项`)).toBeNull());
      expect(screen.getByLabelText(`${label}第 1 项`).textContent).toBe(condensed);
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledOnce();
      const [text, items] = onApply.mock.calls[0]!;
      expect(stripRichText(text)).toBe(`• ${condensed}`);
      expect(items.map(stripRichText)).toEqual([condensed]);
    });
  });

  describe.each(["分条", "整段"])("模型纯文本的%s写入", (viewMode) => {
    it.each(["replace", "append"])("%s 模式直接采纳时保留原始字符和换行", async (writeMode) => {
      const plain = String.raw`实现 Array<T>，记录 &amp;、<br> 与 C:\new\resume` + "\n维护 <template> 字面代码";
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: normalizePolishResult({
        draft: `• ${plain}`, draftItems: [{ text: plain, sourceIndices: [1] }],
      }) });
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType="work" currentText="已有原文" onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#1");
      if (viewMode === "整段") fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      if (writeMode === "append") fireEvent.click(screen.getByRole("radio", { name: "追加到现有内容末尾" }));
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledOnce();
      const [text, items, mode] = onApply.mock.calls[0]!;
      expect(stripRichText(text)).toBe(`${writeMode === "append" ? "已有原文\n\n" : ""}• ${plain}`);
      expect(items.map(stripRichText)).toEqual(viewMode === "整段" ? plain.split("\n") : [plain]);
      expect(mode).toBe(writeMode);
    });
  });

  describe.each(["work", "projects", "summary"] as const)("%s 原经历变化后的写入保护", (moduleType) => {
    it.each(["replace", "append"])("%s 模式保留草稿但阻止覆盖，重开后使用最新原文", async (writeMode) => {
      const onApply = vi.fn();
      const props = { resumeId: "1", moduleType, currentText: "旧原文", onApply };
      const view = render(<StarPolishDialog {...props} />);
      const trigger = moduleType === "summary" ? "✨ AI 润色" : "✨ STAR 润色与量化";
      fireEvent.click(screen.getByRole("button", { name: trigger }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#1");
      const editorLabel = moduleType === "summary" ? "自我评价第 1 项" : "经历条目第 1 项";
      const editor = screen.getByLabelText(editorLabel);
      editor.innerHTML = "手动<strong>改写的草稿</strong>";
      fireEvent.input(editor);
      if (writeMode === "append") fireEvent.click(screen.getByLabelText("追加到现有内容末尾"));
      view.rerender(<StarPolishDialog {...props} currentText="最新原文，尚未上线" />);
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", "原内容或职责信息已变化，当前草稿已保留；请关闭并重新打开，载入最新内容后再润色");
      expect(screen.getByLabelText(editorLabel).innerHTML).toBe("手动<strong>改写的草稿</strong>");
      const write = screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement;
      expect(write.disabled).toBe(true);
      fireEvent.click(write);
      expect(onApply).not.toHaveBeenCalled();
      expect((screen.getByRole("button", { name: "开始 AI 智能润色" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "智能精简合并" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      fireEvent.click(screen.getByRole("button", { name: trigger }));
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#1");
      expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.body)).text).toBe("• 最新原文，尚未上线");
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledOnce();
    });
  });

  it.each(["原文分条", "职责", "简历", "模块"])("%s变化也阻止旧草稿写入", async (change) => {
    const onApply = vi.fn();
    const props = { resumeId: "1", moduleType: "work" as const, currentText: "隐藏旧正文", currentItems: ["原文分条"], context: { company: "公司", title: "开发" }, onApply };
    const view = render(<StarPolishDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    view.rerender(<StarPolishDialog {...props}
      resumeId={change === "简历" ? "2" : "1"}
      moduleType={change === "模块" ? "projects" : "work"}
      currentItems={change === "原文分条" ? ["修改后的分条"] : props.currentItems}
      context={change === "职责" ? { company: "公司", title: "接口维护" } : props.context} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it.each(["生成", "二次精简"])("%s等待期间原经历变化，晚到结果仍不能写入", async (operation) => {
    const pending = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    if (operation === "二次精简") vi.mocked(jsonFetch).mockResolvedValueOnce({ result: mockPolishResult });
    vi.mocked(jsonFetch).mockImplementationOnce(() => pending.promise);
    const onApply = vi.fn();
    const props = { resumeId: "1", moduleType: "work" as const, currentText: "旧原文", onApply };
    const view = render(<StarPolishDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    if (operation === "二次精简") {
      await screen.findByText("#1");
      fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    }
    view.rerender(<StarPolishDialog {...props} currentText="新原文" />);
    await act(async () => pending.resolve({ result: mockPolishResult }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("原经历在首次生成前变化时不把旧待润色原文发给模型", async () => {
    const props = { resumeId: "1", moduleType: "work" as const, currentText: "旧原文", onApply: vi.fn() };
    const view = render(<StarPolishDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    view.rerender(<StarPolishDialog {...props} currentText="新原文" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    const generate = screen.getByRole("button", { name: "开始 AI 智能润色" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    fireEvent.click(generate);
    expect(jsonFetch).not.toHaveBeenCalled();
    expect(props.onApply).not.toHaveBeenCalled();
  });

  it("整段编辑保留手动草稿，目标变化后不能绕过写入保护", async () => {
    const onApply = vi.fn();
    const props = { resumeId: "1", moduleType: "work" as const, currentText: "旧原文", onApply };
    const view = render(<StarPolishDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
    const editor = screen.getByLabelText("推荐排版草稿");
    editor.innerHTML = "手动<strong>整段编辑</strong>";
    fireEvent.input(editor);
    view.rerender(<StarPolishDialog {...props} currentText="新原文" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByLabelText("推荐排版草稿").innerHTML).toBe("手动<strong>整段编辑</strong>");
    const write = screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement;
    expect(write.disabled).toBe(true);
    fireEvent.click(write);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("仅改变格式、无效旧正文及上下文字段顺序时继续采纳当前草稿", async () => {
    const onApply = vi.fn();
    const props = { resumeId: "1", moduleType: "work" as const, currentText: "旧冗余正文", currentItems: ["<strong>参与接口联调</strong>"], context: { company: "公司", title: "开发" }, onApply };
    const view = render(<StarPolishDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    view.rerender(<StarPolishDialog {...props} currentText="新冗余正文" currentItems={['<span style="color: #1d4ed8">参与接口联调</span>']} context={{ title: "开发", company: "公司" }} />);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  describe.each([
    { moduleType: "work", html: "<strong>封装 Array&lt;T&gt; 泛型组件</strong>", plain: "封装 Array<T> 泛型组件" },
    { moduleType: "projects", html: '<span style="color: #1d4ed8">处理 R&amp;amp;D 与 &amp;lt;tag&amp;gt; 字面量</span>', plain: "处理 R&amp;D 与 &lt;tag&gt; 字面量" },
    { moduleType: "summary", html: "<strong>编写 &lt;template&gt; 模板并保留 &quot;name&quot; 属性</strong>", plain: '编写 <template> 模板并保留 "name" 属性' },
  ] as const)("$moduleType 二次精简保留可见技术正文", ({ moduleType, html, plain }) => {
    it.each(["单项", "多项"])("%s精简只转换一次富文本，全文与来源段落一致", async (selection) => {
      const initial = {
        ...mockPolishResult,
        draftItems: ["可编辑草稿", "补充真实职责"],
        draftItemDetails: [
          { text: "可编辑草稿", sourceIndices: [1] },
          { text: "补充真实职责", sourceIndices: [2] },
        ],
      };
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: initial }).mockResolvedValueOnce({ result: {
        ...mockPolishResult,
        draft: "• 精简后的真实草稿",
        draftItems: ["精简后的真实草稿"],
        draftItemDetails: [{ text: "精简后的真实草稿", sourceIndices: selection === "单项" ? [1] : [1, 2] }],
      } });
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType={moduleType} currentText="" currentItems={["原始经历甲", "原始经历乙"]} onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: moduleType === "summary" ? "✨ AI 润色" : "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#2");
      const editor = screen.getByLabelText(moduleType === "summary" ? "自我评价第 1 项" : "经历条目第 1 项");
      editor.innerHTML = html;
      fireEvent.input(editor);
      expect(editor.textContent).toBe(plain);
      if (selection === "单项") fireEvent.click(screen.getByLabelText("勾选采纳第 2 项"));
      fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
      const body = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body));
      const expected = selection === "单项" ? [plain] : [plain, "补充真实职责"];
      await waitFor(() => expect(screen.queryByLabelText("勾选采纳第 2 项")).toBeNull());
      expect(body.text).toBe(expected.map((text) => `• ${text}`).join("\n"));
      expect(body.sourceParagraphs).toEqual(selection === "单项" ? undefined : expected);
      expect(body.originalSourceParagraphs).toEqual(
        selection === "单项" ? ["原始经历甲"] : ["原始经历甲", "原始经历乙"],
      );
      expect(body.mode).toBe("condense");
      fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
      const comparison = screen.getByTestId("source-comparison-0");
      expect(comparison.textContent).toContain("原始经历甲");
      expect(comparison.textContent).toContain(selection === "单项" ? "已关联 1/2 个来源段落" : "已关联 2/2 个来源段落");
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith("• 精简后的真实草稿", ["精简后的真实草稿"], "replace");
    });
  });

  describe.each([
    { boundary: "br", wrap: (a: string, b: string) => `• ${a}<br>• ${b}` },
    { boundary: "div", wrap: (a: string, b: string) => `• ${a}<div>• ${b}</div>` },
    { boundary: "p", wrap: (a: string, b: string) => `<p>• ${a}</p><p>• ${b}</p>` },
    { boundary: "编号括号", wrap: (a: string, b: string) => `1) ${a}<br>2) ${b}` },
    { boundary: "空格式行", wrap: (a: string, b: string) => `• ${a}<div><strong>&nbsp;</strong></div><div>• ${b}</div>` },
    { boundary: "跨行加粗", wrap: () => "<strong>• 参与 R&amp;D 联调<br>• 校验输入 &lt; 1</strong>" },
  ])("整段编辑的浏览器换行：$boundary", ({ boundary, wrap }) => {
    it.each(["切回列表", "直接写入"])("%s保持条目边界和富文本，列表来源仍对应原文", async (action) => {
      const draftItems = [
        "<strong>参与 R&amp;D 联调</strong>",
        boundary === "跨行加粗" ? "<strong>校验输入 &lt; 1</strong>" : '<span style="color: #1d4ed8">校验输入 &lt; 1</span>',
      ];
      const generatedItems = draftItems.map(stripRichText);
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: {
        ...mockPolishResult,
        draft: generatedItems.map((item) => `• ${item}`).join("\n"),
        draftItems: generatedItems,
        draftItemDetails: generatedItems.map((text, index) => ({ text, sourceIndices: [index + 1] })),
      } });
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType="work" currentText="" currentItems={["原文甲", "原文乙"]} onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#2");
      // 模型正文为纯文本；加粗和颜色来自用户在生成后的编辑操作。
      for (const [index, html] of draftItems.entries()) {
        const itemEditor = screen.getByLabelText(`经历条目第 ${index + 1} 项`);
        itemEditor.innerHTML = html;
        fireEvent.input(itemEditor);
      }
      fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      const rawHtml = wrap(draftItems[0]!, draftItems[1]!);
      const editor = screen.getByLabelText("推荐排版草稿");
      editor.innerHTML = rawHtml;
      fireEvent.input(editor);
      if (action === "切回列表") {
        fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
        expect(screen.getAllByLabelText(/^经历条目第 \d 项$/)).toHaveLength(2);
        fireEvent.click(screen.getByRole("button", { name: "展开所有原文对比" }));
        for (const [index, source] of ["原文甲", "原文乙"].entries()) {
          const comparison = screen.getByTestId(`source-comparison-${index}`);
          expect(comparison.textContent).toContain(source);
          expect(comparison.textContent).toContain("已关联 1/2 个来源段落");
          expect(comparison.textContent).not.toContain(index === 0 ? "原文乙" : "原文甲");
        }
      }
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith(
        action === "切回列表" ? draftItems.map((item) => `• ${item}`).join("\n") : rawHtml,
        draftItems,
        "replace",
      );
    });
  });

  describe.each(["列表重新生成", "整段重新生成", "二次精简"])("%s期间的写入保护", (operation) => {
    it.each(["成功", "失败", "空结果", "取消"])("阻止旧草稿写入，%s后恢复当前草稿的采纳", async (outcome) => {
      const oldText = "已核实的原草稿";
      const nextText = "已核实的新草稿";
      const oldResult = { ...mockPolishResult, draft: `• ${oldText}`, draftItems: [oldText] };
      const pending = Promise.withResolvers<{ result?: typeof oldResult }>();
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: oldResult }).mockImplementationOnce(() => pending.promise);
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType="work" currentText="真实原文" onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#1");
      const raw = operation === "整段重新生成";
      if (raw) fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      const write = screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement;
      expect(write.disabled).toBe(false);
      write.focus();
      fireEvent.click(screen.getByRole("button", { name: operation === "二次精简" ? "智能精简合并" : "开始 AI 智能润色" }));
      const signal = vi.mocked(jsonFetch).mock.calls[1]![1]?.signal;
      expect(write.disabled).toBe(true);
      fireEvent.click(write);
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(signal?.aborted).toBe(false);

      if (outcome === "取消") {
        fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
        expect(signal?.aborted).toBe(true);
      }
      await act(async () => {
        if (outcome === "失败") pending.reject(new Error("本次生成失败"));
        else if (outcome === "空结果") pending.resolve({});
        else pending.resolve({ result: { ...oldResult, draft: `• ${nextText}`, draftItems: [nextText] } });
      });
      if (outcome === "失败") expect(screen.getByText("本次生成失败")).toBeTruthy();
      if (outcome === "空结果") {
        expect(screen.getByText(operation === "二次精简" ? "精简合并结果为空，请重试" : "润色结果为空，请重试")).toBeTruthy();
      }
      const text = outcome === "成功" ? nextText : oldText;
      expect(screen.getByLabelText(raw && outcome !== "成功" ? "推荐排版草稿" : "经历条目第 1 项").textContent).toBe(raw && outcome !== "成功" ? `• ${text}` : text);
      expect(write.disabled).toBe(false);
      expect(screen.queryByRole("status")).toBeNull();
      expect(onApply).not.toHaveBeenCalled();
      fireEvent.click(write);
      expect(onApply).toHaveBeenCalledExactlyOnceWith(`• ${text}`, [text], "replace");
    });
  });

  it.each(["重新生成", "二次精简"])("%s刚启动、按钮状态尚未刷新时也不能写入旧草稿", async (operation) => {
    const pending = Promise.withResolvers<{ result: typeof mockPolishResult }>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: mockPolishResult }).mockImplementationOnce(() => pending.promise);
    const onApply = vi.fn();
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="真实原文" onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#2");
    const write = screen.getByRole("button", { name: "确认写入简历" });
    const generate = screen.getByRole("button", { name: operation === "二次精简" ? "智能精简合并" : "开始 AI 智能润色" });
    act(() => {
      fireEvent.click(generate);
      fireEvent.click(write);
    });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(vi.mocked(jsonFetch).mock.calls[1]![1]?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
    await act(async () => pending.resolve({ result: mockPolishResult }));
  });

  describe.each([
    { moduleType: "work", emptyHtml: "<strong>&nbsp;</strong>" },
    { moduleType: "projects", emptyHtml: "<div><br></div>" },
    { moduleType: "summary", emptyHtml: '<span style="color: #1d4ed8">&nbsp;<br></span>' },
  ] as const)("$moduleType 的空富文本草稿", ({ moduleType, emptyHtml }) => {
    it.each(["items", "raw"])("%s 视图禁止空标签写入，往返切换保持为空，重新填写保留格式", async (view) => {
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType={moduleType} currentText="已有原文" onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: moduleType === "summary" ? "✨ AI 润色" : "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#2");
      if (view === "raw") fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      const editors = view === "raw" ? [screen.getByLabelText("推荐排版草稿")]
        : screen.getAllByLabelText(moduleType === "summary" ? /^自我评价第 \d 项$/ : /^经历条目第 \d 项$/);
      for (const editor of editors) {
        editor.innerHTML = emptyHtml;
        fireEvent.input(editor);
      }
      const write = screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement;
      expect(write.disabled).toBe(true);
      fireEvent.click(write);
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBeTruthy();

      if (view === "items") fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
      expect(screen.queryByLabelText(moduleType === "summary" ? "自我评价第 1 项" : "经历条目第 1 项")).toBeNull();
      expect((screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
      const editor = screen.getByLabelText("推荐排版草稿");
      expect(editor.textContent).toBe("");
      const restored = '<strong>已核实的真实经历</strong>与<span style="color: #1d4ed8">职责</span>';
      editor.innerHTML = restored;
      fireEvent.input(editor);
      expect((screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith(restored, [restored], "replace");
    });
  });

  describe.each(["items", "raw"])("%s 视图混合空标签与有效内容", (view) => {
    it.each(["replace", "append"])("%s 仅采纳非空条目并保留有效内容的格式", async (mode) => {
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType="work" currentText="已有原文" onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      await screen.findByText("#2");
      const empty = "<strong>&nbsp;</strong>";
      const valid = '<strong>参与接口联调</strong>，<span style="color: #1d4ed8">尚未上线</span>';
      if (view === "raw") {
        fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
        const editor = screen.getByLabelText("推荐排版草稿");
        editor.innerHTML = `${empty}\n${valid}`;
        fireEvent.input(editor);
      } else {
        for (const [index, html] of [empty, valid].entries()) {
          const editor = screen.getByLabelText(`经历条目第 ${index + 1} 项`);
          editor.innerHTML = html;
          fireEvent.input(editor);
        }
      }
      if (mode === "append") fireEvent.click(screen.getByRole("radio", { name: "追加到现有内容末尾" }));
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      const text = view === "raw" ? `${empty}\n${valid}` : `• ${valid}`;
      expect(onApply).toHaveBeenCalledExactlyOnceWith(mode === "append" ? `已有原文\n\n${text}` : text, [valid], mode);
    });
  });

  describe.each(["work", "projects", "summary"] as const)("%s 的原文清空", (moduleType) => {
    it.each(["删除全部", "仅剩空白", "仅剩空富文本"])("%s后不发送隐藏旧原文，重新填写后仅使用当前内容", async (scenario) => {
      const emptyResult = {
        star: null,
        quantifiedTips: [],
        draft: "• 待补充真实内容",
        draftItems: ["待补充真实内容"],
        draftItemDetails: [{ text: "待补充真实内容", sourceIndices: [] }],
        highlights: [],
      };
      vi.mocked(jsonFetch).mockResolvedValueOnce({ result: emptyResult })
        .mockResolvedValueOnce({ result: {
          ...emptyResult,
          draft: "• 依据新原文整理的草稿",
          draftItems: ["依据新原文整理的草稿"],
          draftItemDetails: [{ text: "依据新原文整理的草稿", sourceIndices: [1] }],
        } });
      const onApply = vi.fn();
      render(<StarPolishDialog resumeId="1" moduleType={moduleType}
        currentText="隐藏的旧整段原文" currentItems={["可见原文甲", "可见原文乙"]} onApply={onApply} />);
      fireEvent.click(screen.getByRole("button", { name: moduleType === "summary" ? "✨ AI 润色" : "✨ STAR 润色与量化" }));
      const inputLabel = moduleType === "summary" ? "待润色自我评价" : "待润色描述";
      if (scenario === "删除全部") {
        fireEvent.click(screen.getAllByTitle("删除该行")[1]!);
        fireEvent.click(screen.getByTitle("删除该行"));
      } else {
        for (const editor of screen.getAllByLabelText(new RegExp(`${inputLabel}第`))) {
          editor.innerHTML = scenario === "仅剩空白" ? " &nbsp; \n " : "<p><br></p>";
          fireEvent.input(editor);
        }
      }
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      const emptyBody = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.body));
      expect(emptyBody.text).toBe("");
      expect(emptyBody.sourceParagraphs).toBeUndefined();
      await screen.findByText("#1");
      expect(screen.queryByRole("button", { name: "展开第 1 项来源原文对比" })).toBeNull();
      expect(onApply).not.toHaveBeenCalled();

      const editor = screen.getByLabelText(`${inputLabel}第 1 行`);
      editor.textContent = "重新填写的真实内容";
      fireEvent.input(editor);
      fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
      const nextBody = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]?.[1]?.body));
      expect(nextBody.text).toBe("• 重新填写的真实内容");
      expect(nextBody.sourceParagraphs).toBeUndefined();
      const resultLabel = moduleType === "summary" ? "自我评价第 1 项" : "经历条目第 1 项";
      await waitFor(() => expect(screen.getByLabelText(resultLabel).textContent).toBe("依据新原文整理的草稿"));
      fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
      const comparison = screen.getByTestId("source-comparison-0");
      expect(comparison.textContent).toContain("重新填写的真实内容");
      expect(comparison.textContent).toContain("已关联 1/1 个来源段落");
      expect(comparison.textContent).not.toContain("旧整段原文");
      expect(comparison.textContent).not.toContain("可见原文");
      fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
      expect(onApply).toHaveBeenCalledExactlyOnceWith("• 依据新原文整理的草稿", ["依据新原文整理的草稿"], "replace");
    });
  });

  it.each(["网络失败", "空结果", "取消"])("重新生成%s时，旧结果及后续精简仍使用旧原文", async (outcome) => {
    const oldResult = {
      ...mockPolishResult,
      draft: "• 已生成条目",
      draftItems: ["已生成条目"],
      draftItemDetails: [{ text: "已生成条目", sourceIndices: [2] }],
    };
    const pending = Promise.withResolvers<{ result?: typeof oldResult }>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: oldResult })
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ result: {
        ...oldResult,
        draft: "• 精简后的条目",
        draftItems: ["精简后的条目"],
        draftItemDetails: [{ text: "精简后的条目", sourceIndices: [1] }],
      } });
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText=""
      currentItems={["旧原文甲", "旧原文乙"]} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));

    const editor = screen.getByLabelText("待润色描述第 1 行");
    editor.textContent = "新原文";
    fireEvent.input(editor);
    fireEvent.click(screen.getAllByTitle("删除该行")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body)).text).toContain("新原文");

    if (outcome === "取消") {
      fireEvent.click(screen.getByRole("button", { name: "取消生成" }));
      expect(vi.mocked(jsonFetch).mock.calls[1]![1]?.signal?.aborted).toBe(true);
      await act(async () => pending.resolve({ result: { ...oldResult, draftItems: ["晚到的新结果"] } }));
    } else {
      await act(async () => {
        if (outcome === "网络失败") pending.reject(new Error("重新生成失败"));
        else pending.resolve({});
      });
      expect(screen.getByText(outcome === "网络失败" ? "重新生成失败" : "润色结果为空，请重试")).toBeTruthy();
    }
    expect(screen.getByLabelText("经历条目第 1 项").textContent).toBe("已生成条目");
    const comparison = screen.getByTestId("source-comparison-0");
    expect(comparison.textContent).toContain("旧原文乙");
    expect(comparison.textContent).toContain("已关联 1/2 个来源段落");
    expect(comparison.textContent).not.toContain("新原文");

    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    await waitFor(() => expect(screen.getByLabelText("经历条目第 1 项").textContent).toBe("精简后的条目"));
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[2]![1]?.body)).originalSourceParagraphs)
      .toEqual(["旧原文乙"]);
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
    expect(screen.getByTestId("source-comparison-0").textContent).toContain("旧原文乙");
    expect(screen.getByTestId("source-comparison-0").textContent).not.toContain("新原文");
  });

  it("重新生成成功时，结果和来源一起切换到本次提交的原文", async () => {
    const oldResult = {
      ...mockPolishResult,
      draft: "• 旧生成条目",
      draftItems: ["旧生成条目"],
      draftItemDetails: [{ text: "旧生成条目", sourceIndices: [1] }],
    };
    const pending = Promise.withResolvers<{ result: typeof oldResult }>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: oldResult }).mockImplementationOnce(() => pending.promise);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="旧原文" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
    const editor = screen.getByLabelText("待润色描述第 1 行");
    editor.textContent = "本次提交的原文";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    expect(screen.getByTestId("source-comparison-0").textContent).toContain("旧原文");
    expect(screen.getByTestId("source-comparison-0").textContent).not.toContain("本次提交的原文");

    await act(async () => pending.resolve({ result: {
      ...oldResult,
      draft: "• 新生成条目",
      draftItems: ["新生成条目"],
      draftItemDetails: [{ text: "新生成条目", sourceIndices: [1] }],
    } }));
    expect(screen.getByLabelText("经历条目第 1 项").textContent).toBe("新生成条目");
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
    expect(screen.getByTestId("source-comparison-0").textContent).toContain("本次提交的原文");
    expect(screen.getByTestId("source-comparison-0").textContent).not.toContain("旧原文");
  });

  it.each([
    { name: "缺少多来源映射且条目数相同", sources: ["原始经历甲", "原始经历乙"], items: ["生成甲", "生成乙"], indices: undefined },
    { name: "缺少多来源映射且条目数不同", sources: ["原始经历甲", "原始经历乙"], items: ["生成甲"], indices: undefined },
    { name: "单来源显式为空", sources: ["原始经历甲"], items: ["生成甲"], indices: [] },
    { name: "单来源越界", sources: ["原始经历甲"], items: ["生成甲"], indices: [9] },
  ])("$name时展示待关联，支持手动关联与取消最后一个来源", async ({ sources, items, indices }) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: {
      ...mockPolishResult,
      draftItems: items,
      draftItemDetails: items.map((text) => ({ text, sourceIndices: indices })),
    } } as never);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="" currentItems={sources} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
    const comparison = screen.getByTestId("source-comparison-0");
    expect(comparison.textContent).toContain("来源待关联");
    expect(comparison.textContent).not.toContain("原始经历");
    fireEvent.click(screen.getByRole("button", { name: "点击关联段落 1" }));
    expect(comparison.textContent).toContain("原始经历甲");
    fireEvent.click(screen.getByRole("button", { name: "点击取消关联段落 1" }));
    expect(comparison.textContent).toContain("来源待关联");
    expect(comparison.textContent).not.toContain("原始经历");
  });

  it.each([
    { name: "旧版缺少映射", indices: undefined, linked: true },
    { name: "明确无来源", indices: [], linked: false },
    { name: "映射越界", indices: [2], linked: false },
  ])("单项精简$name时保留正确的原始来源状态", async ({ indices, linked }) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: {
      ...mockPolishResult,
      draftItems: ["首次生成"],
      draftItemDetails: [{ text: "首次生成", sourceIndices: [1] }],
    } } as never).mockResolvedValueOnce({ result: {
      ...mockPolishResult,
      draftItems: ["精简后的内容"],
      draftItemDetails: [{ text: "精简后的内容", sourceIndices: indices }],
    } } as never);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="原始经历甲" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#1");
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    await waitFor(() => expect(screen.queryByText("AI 深度精简合并中…")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
    const comparison = screen.getByTestId("source-comparison-0");
    if (linked) expect(comparison.textContent).toContain("原始经历甲");
    else {
      expect(comparison.textContent).toContain("来源待关联");
      expect(comparison.textContent).not.toContain("原始经历甲");
    }
  });

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
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    await screen.findByLabelText("经历条目第 1 项");
    await waitFor(() => expect(screen.queryByLabelText("勾选采纳第 2 项")).toBeNull());
    if (scenario === "连续两轮") {
      fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
      await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(screen.queryByText("AI 深度精简合并中…")).toBeNull());
    }
    for (const call of vi.mocked(jsonFetch).mock.calls.slice(1)) {
      expect(JSON.parse(String(call[1]?.body)).originalSourceParagraphs).toEqual(
        scenario === "合并多个来源" ? ["原始经历甲", "原始经历乙"] : ["原始经历乙"],
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "展开所有原文对比" }));
    const comparison = screen.getByTestId("source-comparison-0");
    expect(comparison.textContent).toContain("原始经历乙");
    if (scenario === "合并多个来源") {
      expect(comparison.textContent).toContain("原始经历甲");
      expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body)).sourceParagraphs).toEqual(["生成经历甲", "生成经历乙"]);
    } else expect(comparison.textContent).not.toContain("原始经历甲");
  });

  it.each(["仅未关联项", "混合已关联项"])("精简%s时保留草稿并等待恢复来源关联", async selection => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ result: {
      ...mockPolishResult,
      draftItems: ["来源待确认的经历", "关联第二段的经历"],
      draftItemDetails: [
        { text: "来源待确认的经历", sourceIndices: [] },
        { text: "关联第二段的经历", sourceIndices: [2] },
      ],
    } } as never);
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="" currentItems={["原始经历甲", "原始经历乙"]} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByLabelText("勾选采纳第 2 项");
    if (selection === "仅未关联项") fireEvent.click(screen.getByLabelText("勾选采纳第 2 项"));
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));

    expect(jsonFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("condense-error").textContent).toContain("当前草稿已保留");
    expect(screen.getByLabelText("经历条目第 1 项").textContent).toBe("来源待确认的经历");
    expect(screen.getByLabelText("经历条目第 2 项").textContent).toBe("关联第二段的经历");
    fireEvent.click(within(screen.getByTestId("source-comparison-0")).getByRole("button", { name: "点击关联段落 1" }));
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body));
    expect(body.text).toContain("来源待确认的经历");
    expect(body.originalSourceParagraphs).toEqual(selection === "仅未关联项" ? ["原始经历甲"] : ["原始经历甲", "原始经历乙"]);
    expect(screen.queryByTestId("condense-error")).toBeNull();
  });

  it("整段仅改标点后精简保留草稿，重新关联后带原始事实继续", async () => {
    const original = "协助每周盘点并记录差异。";
    const edited = "协助每周盘点，记录差异。";
    vi.mocked(jsonFetch).mockResolvedValue({ result: {
      ...mockPolishResult, draft: `• ${original}`, draftItems: [original],
      draftItemDetails: [{ text: original, sourceIndices: [1] }],
    } });
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText={original} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByLabelText("经历条目第 1 项");
    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
    const editor = screen.getByLabelText("推荐排版草稿");
    editor.textContent = `• ${edited}`;
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("经历条目第 1 项").textContent).toBe(edited);
    expect(screen.getByTestId("condense-error").textContent).toContain("关联后再精简");
    fireEvent.click(screen.getByRole("button", { name: "点击关联段落 1" }));
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body))).toMatchObject({
      text: `• ${edited}`, originalSourceParagraphs: [original], mode: "condense",
    });
    await waitFor(() => expect(screen.getByLabelText("经历条目第 1 项").textContent).toBe(original));
  });

  it("真正没有原始资料时仍可精简待补框架", async () => {
    const text = "待补充";
    vi.mocked(jsonFetch).mockResolvedValue({ result: {
      star: null, quantifiedTips: [], draft: `• ${text}`, draftItems: [text],
      draftItemDetails: [{ text, sourceIndices: [] }], highlights: [],
    } });
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByLabelText("经历条目第 1 项");
    fireEvent.click(screen.getByRole("button", { name: "智能精简合并" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]![1]?.body)).originalSourceParagraphs).toEqual([]);
    expect(screen.queryByTestId("condense-error")).toBeNull();
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

  it("支持直接选择『智能精简合并』模式生成精炼条目", async () => {
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
      name: "智能精简合并（提纯聚合，去粗取精）",
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
    await screen.findByText("#2");
    expect((screen.getByRole("button", { name: "开始 AI 智能精简合并" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("支持在已生成的多项列表中点击『智能精简合并』对勾选条目执行就地二次提纯", async () => {
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

    // 点击列表工具条上的『智能精简合并』按钮
    const inPlaceCondenseBtn = screen.getByRole("button", { name: "智能精简合并" });
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

  it("点击『智能精简合并』失败时，报错信息展示在智能精简合并按钮下方", async () => {
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
    const inPlaceCondenseBtn = screen.getByRole("button", { name: "智能精简合并" });
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
    await waitFor(() => expect((screen.getByRole("button", { name: "开始 AI 智能润色" }) as HTMLButtonElement).disabled).toBe(false));
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
    await screen.findByText("#2");
    expect((screen.getByRole("button", { name: "开始 AI 智能润色" }) as HTMLButtonElement).disabled).toBe(false);
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
        name: "📊 量化建议（核对真实记录与统计口径）",
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
        name: "智能精简合并（提纯聚合，去粗取精）",
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

  it.each(["删除全部", "清空全部", "取消全部勾选", "仅勾选项被清空"])("%s后切换整段不会恢复旧内容，仍可重新填写", async (scenario) => {
    const onApply = vi.fn();
    render(<StarPolishDialog resumeId="1" moduleType="work" currentText="原始经历" onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "✨ STAR 润色与量化" }));
    fireEvent.click(screen.getByRole("button", { name: "开始 AI 智能润色" }));
    await screen.findByText("#2");

    if (scenario === "删除全部") {
      fireEvent.click(screen.getAllByRole("button", { name: "× 删除" })[1]!);
      fireEvent.click(screen.getByRole("button", { name: "× 删除" }));
    } else if (scenario === "清空全部") {
      for (const index of [1, 2]) {
        const editor = screen.getByLabelText(`经历条目第 ${index} 项`);
        editor.textContent = "";
        fireEvent.input(editor);
      }
    } else if (scenario === "取消全部勾选") {
      fireEvent.click(screen.getByLabelText("勾选采纳第 1 项"));
      fireEvent.click(screen.getByLabelText("勾选采纳第 2 项"));
    } else {
      fireEvent.click(screen.getByLabelText("勾选采纳第 1 项"));
      const editor = screen.getByLabelText("经历条目第 2 项");
      editor.textContent = "";
      fireEvent.input(editor);
    }
    expect((screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
    expect(screen.getByLabelText("推荐排版草稿").textContent).toBe("");
    expect((screen.getByRole("button", { name: "确认写入简历" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
    expect(screen.queryByLabelText("经历条目第 1 项")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "📄 整段编辑" }));
    const editor = screen.getByLabelText("推荐排版草稿");
    expect(editor.textContent).toBe("");
    editor.textContent = "重新填写的真实经历";
    fireEvent.input(editor);
    fireEvent.click(screen.getByRole("button", { name: "• 多项列表（推荐）" }));
    fireEvent.click(screen.getByRole("button", { name: "展开第 1 项来源原文对比" }));
    expect(screen.getByTestId("source-comparison-0").textContent).toContain("来源待关联");
    fireEvent.click(screen.getByRole("button", { name: "确认写入简历" }));
    expect(onApply).toHaveBeenCalledExactlyOnceWith("• 重新填写的真实经历", ["重新填写的真实经历"], "replace");
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
