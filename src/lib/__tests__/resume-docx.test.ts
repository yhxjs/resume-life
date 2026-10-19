import { describe, expect, it } from "vitest";
import mammoth from "mammoth";
import JSZip from "jszip";
import sharp from "sharp";
import { resumeToDocx } from "../resume-docx";
import { defaultContent, type ModuleData } from "../modules";
import { BUILTIN_STYLES } from "../templates";

describe("resumeToDocx", () => {
  it("同一项目的标题、技术栈和说明保持为分页组，下一项目不被连带", async () => {
    const buffer = await resumeToDocx("简历", [{ key: "projects", type: "projects", label: "项目经历", sort: 0, content: [
      { name: "追番管理及社交平台", role: "个人独立开发", start: "2020", end: "2021",
        subItems: [{ label: "技术栈", value: "Spring Boot、Redis" }],
        descriptionItems: ["采用前后端分离架构", "设计并实现追番核心模块", "构建实时聊天能力"], descriptionStyle: "bullet" },
      { name: "下一项目", descriptionItems: ["独立完成交付"], descriptionStyle: "bullet" },
      { name: "仅标题" },
    ] }]);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([value]) => value);
    const paragraph = (text: string) => paragraphs.find((value) => value.includes(text));
    for (const text of ["追番管理及社交平台", "2020 ~ 2021", "技术栈", "采用前后端分离架构", "设计并实现追番核心模块"]) {
      expect(paragraph(text), `${text} 应与下一段同页`).toContain("<w:keepNext/>");
    }
    for (const text of ["技术栈", "采用前后端分离架构", "设计并实现追番核心模块", "构建实时聊天能力"]) {
      expect(paragraph(text), `${text} 自身不应拆到两页`).toContain("<w:keepLines/>");
    }
    expect(paragraph("构建实时聊天能力")).not.toContain("<w:keepNext/>");
    expect(paragraph("下一项目")).toContain("<w:keepNext/>");
    expect(paragraph("仅标题")).not.toContain("<w:keepNext/>");
  });

  it("左色条标题使用一致的段落位置，竖线只覆盖文字行且首模块留出顶栏间距", async () => {
    const style = BUILTIN_STYLES.banner_navy;
    const buffer = await resumeToDocx("简历", [
      { key: "education", type: "education", label: "教育经历", sort: 0, content: [{ school: "示例大学" }] },
      { key: "work", type: "work", label: "工作经历", sort: 1, content: [{ company: "示例公司" }] },
      { key: "projects", type: "projects", label: "项目经历", sort: 2, content: [{ name: "示例项目" }] },
    ], { style });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(([value]) => value);
    const titleProperties = ["教育经历", "工作经历", "项目经历"].map((label) => {
      const index = paragraphs.findIndex((paragraph) => paragraph.includes(label));
      expect(index).toBeGreaterThan(0);
      expect(paragraphs[index - 1]).toContain(`w:after="${Math.round(style.sectionGapBefore * 15)}"`);
      expect(paragraphs[index + 1]).toContain(`w:after="${Math.round(style.sectionGapAfter * 15)}"`);
      const properties = paragraphs[index]?.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0];
      expect(properties).toContain("<w:pBdr><w:left");
      expect(properties).toContain('w:lineRule="exact"');
      expect(properties).toContain('w:before="0"');
      expect(properties).toContain('w:after="0"');
      return properties;
    });
    expect(new Set(titleProperties).size).toBe(1);
    expect((await mammoth.extractRawText({ buffer })).value).toContain("项目经历");
  });

  it("项目符号和序号贴近左边界，标记后只留窄间距", async () => {
    const buffer = await resumeToDocx("简历", [
      { key: "work", type: "work", label: "工作经历", sort: 0, content: [
        { company: "微财数科", descriptionItems: ["负责客服系统后端"], descriptionStyle: "bullet" },
        { company: "另一家公司", descriptionItems: ["负责平台开发"], descriptionStyle: "ordered" },
      ] },
      { key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["TypeScript"] } },
    ], { style: BUILTIN_STYLES.twocol });
    const zip = await JSZip.loadAsync(buffer);
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    const levels = [...numbering.matchAll(/<w:lvl\b[^>]*>[\s\S]*?<\/w:lvl>/g)].map(([level]) => level);
    for (const format of ["bullet", "decimal"]) {
      const level = levels.find((value) => value.includes(`<w:numFmt w:val="${format}"/>`) && value.includes('<w:suff w:val="space"/>'));
      const indent = level?.match(/<w:ind w:left="(\d+)" w:hanging="(\d+)"\/>/);
      expect(indent, `${format} 列表应使用空格和显式窄缩进`).toBeTruthy();
      expect(Number(indent![1])).toBeLessThanOrEqual(240);
      expect(indent![1]).toBe(indent![2]);
    }
    const html = (await mammoth.convertToHtml({ buffer })).value;
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
  });

  it("日期与职位在同一个无边框表格行，日期单元格右对齐", async () => {
    const buffer = await resumeToDocx("简历", [{ key: "work", type: "work", label: "工作经历", sort: 0,
      content: [{ company: "锐捷网络", title: "C 软件工程师", start: "2023 年 07 月", end: "2024 年 01 月", description: "负责控制面" }],
    }]);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const row = [...xml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].find(([value]) => value.includes("锐捷网络"));
    expect(row?.[0]).toContain("2023 年 07 月 ~ 2024 年 01 月");
    expect(row?.[0].match(/<w:tc>/g)).toHaveLength(2);
    expect(row?.[0]).toContain('w:val="right"');
    expect(row?.[0]).toContain('w:cantSplit');
  });

  it("横幅模板保留页眉背景、姓名、配色和章节装饰", async () => {
    const buffer = await resumeToDocx("备用标题", [
      { key: "basic", type: "basic", label: "基本信息", sort: 0,
        content: { ...defaultContent("basic"), name: "王小明", phone: "13800000000" } },
      { key: "summary", type: "summary", label: "自我评价", sort: 1, content: { text: "熟悉业务系统" } },
    ], { style: BUILTIN_STYLES.banner_navy });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('w:fill="1E3A8A"');
    expect(xml).toContain('w:color w:val="FFFFFF"');
    expect(xml).toContain('w:color w:val="1E3A8A"');
    expect((await mammoth.extractRawText({ buffer })).value).toContain("王小明");
    expect((await mammoth.extractRawText({ buffer })).value).not.toContain("备用标题");
    expect((await mammoth.extractRawText({ buffer })).value).not.toContain("基本信息");
  });

  it("头像裁切为指定形状并嵌入横幅，同一文档仍保留正文", async () => {
    const avatar = await sharp({ create: { width: 160, height: 90, channels: 3, background: "#e63946" } }).png().toBuffer();
    const buffer = await resumeToDocx("简历", [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: {
        ...defaultContent("basic"), name: "李明", avatar: "/api/uploads/avatar.webp", avatarShape: "circle", avatarSize: 72,
      } },
      { key: "summary", type: "summary", label: "评价", sort: 1, content: { text: "持续改进" } },
    ], { style: BUILTIN_STYLES.banner_navy, avatar });
    const zip = await JSZip.loadAsync(buffer);
    const media = Object.keys(zip.files).find((name) => name.startsWith("word/media/") && name.endsWith(".png"));
    expect(media).toBeTruthy();
    const image = await zip.file(media!)!.async("nodebuffer");
    const meta = await sharp(image).metadata();
    expect(meta.width).toBe(meta.height);
    expect(meta.hasAlpha).toBe(true);
    expect((await sharp(image).raw().toBuffer({ resolveWithObject: true })).data[3]).toBe(0);
    expect((await mammoth.extractRawText({ buffer })).value).toContain("持续改进");
  });

  it("双栏模板把经历放主栏、技能与自评放侧栏", async () => {
    const buffer = await resumeToDocx("简历", [
      { key: "work", type: "work", label: "工作经历", sort: 0, content: [{ company: "示例公司" }] },
      { key: "skills", type: "skills", label: "专业技能", sort: 1, content: { items: ["TypeScript"] } },
      { key: "summary", type: "summary", label: "自我评价", sort: 2, content: { text: "团队协作" } },
    ], { style: BUILTIN_STYLES.twocol });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    const row = [...xml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].find(([value]) => value.includes("示例公司"));
    expect(row?.[0].match(/<w:tc>/g)).toHaveLength(2);
    expect(row?.[0].indexOf("示例公司")).toBeLessThan(row?.[0].indexOf("TypeScript") ?? 0);
    expect(row?.[0]).toContain("团队协作");
  });

  it("技能标签使用浅色底纹，文字和背景保持对比", async () => {
    const buffer = await resumeToDocx("简历", [
      { key: "skills", type: "skills", label: "专业技能", sort: 0, content: { items: ["TypeScript"] } },
    ], { style: BUILTIN_STYLES.modern });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('w:color w:val="2563EB"');
    expect(xml).toContain('w:fill="E4ECFD"');
  });
  it("生成可回读的 A4 DOCX，完整保留各类模块、顺序和富文本", async () => {
    const modules: ModuleData[] = [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: {
        ...defaultContent("basic"), name: "张三", phone: "13800000000", email: "test@example.com",
        location: "北京", birthday: "1995-01", links: "https://example.com?a=1&b=2",
      } },
      { key: "mod_work", type: "work", label: "相关经历", sort: 1, content: [{
        id: "w1", company: "研发 & 产品", title: "工程师", start: "2020-01", end: "至今",
        subItems: [{ id: "s1", label: "技术栈", value: "TypeScript" }],
        description: "不应重复的旧描述", descriptionStyle: "ordered",
        descriptionItems: ["<strong>架构优化</strong><br>多行描述", '<span style="color: #1d4ed8">重点成果</span>'],
      }, {
        id: "w2", company: "另一家公司", title: "开发", descriptionStyle: "ordered",
        descriptionItems: ["新列表从头编号"],
      }] },
      { key: "projects", type: "projects", label: "项目经历", sort: 2, content: [{
        id: "p1", name: "业务平台", role: "负责人", description: "独立完成\n持续维护",
      }] },
      { key: "education", type: "education", label: "教育经历", sort: 3, content: [{
        id: "e1", school: "示例大学", degree: "硕士", field: "计算机", start: "2017", end: "2020", description: "优秀毕业生",
      }] },
      { key: "skills", type: "skills", label: "专业技能", sort: 4, content: { items: ["React", "Node.js"] } },
      { key: "summary", type: "summary", label: "自我评价", sort: 5, content: { text: "善于沟通" } },
      { key: "mod_extra", type: "custom", label: "开源贡献", sort: 6, content: { text: "贡献 &lt;工具&gt;" } },
    ];
    const buffer = await resumeToDocx("张三的简历", modules);
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const { value: text } = await mammoth.extractRawText({ buffer });
    for (const value of ["张三", "13800000000", "test@example.com", "北京", "1995-01", "https://example.com?a=1&b=2",
      "相关经历", "研发 & 产品", "工程师", "2020-01", "至今", "技术栈", "TypeScript", "架构优化", "多行描述",
      "重点成果", "业务平台", "负责人", "独立完成", "持续维护", "示例大学", "硕士", "计算机", "优秀毕业生",
      "专业技能", "React", "Node.js", "自我评价", "善于沟通", "开源贡献", "贡献 <工具>"]) expect(text).toContain(value);
    expect(text).not.toContain("不应重复的旧描述");
    expect(text.indexOf("相关经历")).toBeLessThan(text.indexOf("项目经历"));
    expect(text.indexOf("项目经历")).toBeLessThan(text.indexOf("教育经历"));
    const { value: html } = await mammoth.convertToHtml({ buffer });
    expect(html).toContain("<strong>架构优化</strong><br />多行描述");
    expect(html).toContain("独立完成<br />持续维护");
    expect(html).toContain("<ol>");
    expect(html).toContain("React  Node.js");
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('w:color w:val="1D4ED8"');
    expect(xml).toContain('w:w="11906" w:h="16838"');
    const numbering = await zip.file("word/numbering.xml")!.async("string");
    expect(numbering.match(/<w:startOverride w:val="1"\/>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("空简历与空模块仍可打开，标题回退且不产生空章节", async () => {
    const buffer = await resumeToDocx(" ", [{ key: "work", type: "work", label: "工作经历", sort: 0, content: [] }]);
    expect((await mammoth.extractRawText({ buffer })).value.trim()).toBe("简历");
  });

  it("多行链接与子字段保留换行，纯文本中的标签和实体不被解析", async () => {
    const buffer = await resumeToDocx("简历", [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: {
        ...defaultContent("basic"), links: "https://example.com\r\nhttps://example.org?q=&amp;",
      } },
      { key: "work", type: "work", label: "工作经历", sort: 1, content: [{
        company: "示例公司", subItems: [{ label: "技术", value: "<Type>\nA & B" }],
      }] },
    ]);
    const { value: html } = await mammoth.convertToHtml({ buffer });
    expect(html).toContain("https://example.com<br />https://example.org?q=&amp;amp;");
    expect(html).toContain("&lt;Type&gt;<br />A &amp; B");
  });

  it("嵌套样式、RGB 颜色和特殊字符不破坏文档，也不输出脚本", async () => {
    const buffer = await resumeToDocx("研发 <工程师>", [{
      key: "summary", type: "summary", label: "评价", sort: 0,
      content: { text: '<strong>加粗<span style="color: rgb(29, 78, 216)">蓝色</span>继续加粗</strong><script>secret()</script>&amp;lt;' },
    }]);
    const text = (await mammoth.extractRawText({ buffer })).value;
    expect(text).toContain("研发 <工程师>");
    expect(text).toContain("加粗蓝色继续加粗&lt;");
    expect(text).not.toContain("secret");
    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file("word/document.xml")!.async("string")).toContain('w:color w:val="1D4ED8"');
  });

  it("DOCX 页眉联系方式遵循自定义 fieldOrder 顺序", async () => {
    const buffer = await resumeToDocx("测试", [
      {
        key: "basic",
        type: "basic",
        label: "基本信息",
        sort: 0,
        content: {
          ...defaultContent("basic"),
          name: "王小明",
          phone: "13800000000",
          location: "杭州",
          gender: "男",
          age: "26岁",
          fieldOrder: ["location", "phone", "gender", "age", "email", "birthday", "links"],
        },
      },
    ]);
    const { value: text } = await mammoth.extractRawText({ buffer });
    expect(text).toContain("王小明");
    expect(text).toContain("杭州 · 13800000000 · 男 · 26岁");
  });
});
