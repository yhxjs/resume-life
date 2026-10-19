import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FormatBeautifyDialog } from "../format-beautify-dialog";
import type { DescribableItem } from "@/lib/module-descriptions";

describe("FormatBeautifyDialog", () => {
  it("无条目时按钮处于禁用状态", () => {
    const html = renderToStaticMarkup(
      <FormatBeautifyDialog items={[]} onApply={vi.fn()} />
    );
    expect(html).toMatch(/<button[^>]*\sdisabled(?:=""|(?=[\s>]))/);
    expect(html).toContain("格式美化（0 条）");
  });

  it("有条目时按钮显示条目数且非禁用", () => {
    const mockItems: DescribableItem[] = [
      {
        id: "item-1",
        title: "字节跳动 · 前端开发",
        text: "<p>负责首屏优化，耗时从 2.5s 降至 0.8s，提升 30% 性能</p>",
        context: { company: "字节跳动", title: "前端开发" },
      },
      {
        id: "item-2",
        title: "腾讯 · 全栈开发",
        text: "<p>负责微服务建设，支撑日活 10 万+ 用户</p>",
        context: { company: "腾讯", title: "全栈开发" },
      },
    ];

    const html = renderToStaticMarkup(
      <FormatBeautifyDialog items={mockItems} onApply={vi.fn()} />
    );
    expect(html).not.toMatch(/<button[^>]*\sdisabled(?:=""|(?=[\s>]))/);
    expect(html).toContain("格式美化（2 条）");
    expect(html).toContain("仅对现有文本中的量化指标进行加粗和高亮排版");
  });
});
