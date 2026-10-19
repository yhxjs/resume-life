import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ResumeExportCheckDialog } from "../resume-export-check-dialog";
import type { ModuleData } from "@/lib/modules";

const modules: ModuleData[] = [{ key: "work", type: "work", label: "工作经历", sort: 0,
  content: [{ id: "w1", company: "星河技术", description: "提升 40%，[待补充]" }] }];

describe("ResumeExportCheckDialog", () => {
  it("阻断问题展示条目、定位与逐条确认，禁止继续导出", () => {
    const html = renderToStaticMarkup(<ResumeExportCheckDialog open modules={modules}
      onClose={vi.fn()} onLocate={vi.fn()} onContinue={vi.fn()} />);
    expect(html).toContain("导出前检查");
    expect(html).toContain("星河技术");
    expect(html).toContain("定位条目");
    expect(html).toContain("我已核实");
    expect(html).toMatch(/disabled=""[^>]*>继续导出/);
  });
  it("只有警告时允许继续导出", () => {
    const html = renderToStaticMarkup(<ResumeExportCheckDialog open modules={[]}
      onClose={vi.fn()} onLocate={vi.fn()} onContinue={vi.fn()} />);
    expect(html).toContain("联系方式");
    expect(html).not.toMatch(/disabled=""[^>]*>继续导出/);
  });
  it("关闭时不渲染检查会话", () => {
    expect(renderToStaticMarkup(<ResumeExportCheckDialog open={false} modules={modules}
      onClose={vi.fn()} onLocate={vi.fn()} onContinue={vi.fn()} />)).toBe("");
  });
});
