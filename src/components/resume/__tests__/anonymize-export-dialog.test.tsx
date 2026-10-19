import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnonymizeExportDialog } from "../anonymize-export-dialog";
import type { ModuleData } from "@/lib/modules";

const mockModules: ModuleData[] = [
  {
    key: "basic",
    type: "basic",
    label: "基本信息",
    sort: 0,
    content: {
      name: "张三",
      phone: "13800000000",
      email: "zhangsan@test.com",
      location: "北京市海淀区中关村",
      birthday: "1994-06-15",
      links: "github.com/zhangsan",
    },
  },
  {
    key: "work",
    type: "work",
    label: "工作经历",
    sort: 1,
    content: [
      {
        id: "w1",
        company: "字节跳动",
        title: "前端技术专家",
        description: "主导 Project-Zeus 架构演进与全量灰度",
      },
    ],
  },
  {
    key: "projects",
    type: "projects",
    label: "项目经历",
    sort: 2,
    content: [
      {
        id: "p1",
        name: "全栈简历生成系统",
        role: "核心架构师",
      },
    ],
  },
];

describe("AnonymizeExportDialog Component", () => {
  it("open 为 false 时不输出任何 DOM", () => {
    const html = renderToStaticMarkup(
      <AnonymizeExportDialog
        open={false}
        onClose={vi.fn()}
        resumeId={1}
        title="张三的前端简历"
        modules={mockModules}
      />
    );
    expect(html).toBe("");
  });

  it("open 为 true 时正常输出弹窗结构、自动识别实体与配置卡片", () => {
    const html = renderToStaticMarkup(
      <AnonymizeExportDialog
        open={true}
        onClose={vi.fn()}
        resumeId={1}
        title="张三的前端简历"
        modules={mockModules}
      />
    );

    expect(html).toContain("敏感隐私一键脱敏导出");
    expect(html).toContain("个人基本身份与联系方式 (自动识别)");
    expect(html).toContain("姓名脱敏");
    expect(html).toContain("手机号脱敏");
    expect(html).toContain("电子邮箱脱敏");
    expect(html).toContain("现居地址模糊");
    expect(html).toContain("隐藏外链/社交主页");
    expect(html).toContain("移除个人头像照片");
    expect(html).toContain("自动识别的公司与机构名称 (1)");
    expect(html).toContain("字节跳动");
    expect(html).toContain("自动识别的项目名称与代号 (1)");
    expect(html).toContain("全栈简历生成系统");
    expect(html).toContain("实时脱敏检测与对比摘要");
    expect(html).toContain("导出脱敏 Markdown");
    expect(html).toContain("导出脱敏 PDF");
  });
});
