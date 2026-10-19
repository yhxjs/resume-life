import { describe, it, expect } from "vitest";
import {
  maskPersonName,
  maskPhoneNumber,
  maskEmailAddress,
  maskLocationText,
  maskBirthdayText,
  maskLinksText,
  replaceSensitiveText,
  replaceSensitiveRichText,
  anonymizeResumeModules,
  anonymizeResumeData,
  extractResumeEntities,
  DEFAULT_ANONYMIZE_CONFIG,
  calculateAnonymizeStats,
  type AnonymizeConfig,
  type CustomSensitiveRule,
} from "../resume-anonymize";
import type { ModuleData } from "@/lib/modules";
import { stripRichText } from "../rich-text";
import { resumeToMarkdown } from "../resume-markdown";

describe("resume-anonymize 规则测试", () => {
  it("自定义规则覆盖默认遮盖后仍保留的邮箱域名", () => {
    const modules: ModuleData[] = [{ key: "basic", type: "basic", label: "基本信息", sort: 0,
      content: { email: "test@private-corp.example" } }];
    const config = { ...DEFAULT_ANONYMIZE_CONFIG,
      customRules: [{ id: "domain", source: "private-corp.example", replacement: "public.example" }] };
    expect(anonymizeResumeModules(modules, config)[0]!.content).toMatchObject({ email: "t***@public.example" });
    expect(calculateAnonymizeStats(modules, config)).toMatchObject({ replacedRulesCount: 1, replacedOccurrencesCount: 1 });
    expect(resumeToMarkdown("简历", anonymizeResumeModules(modules, config))).not.toContain("private-corp");
  });

  it("自定义规则覆盖所有基本文本字段但不改头像与字段顺序元数据", () => {
    const fields = ["name", "phone", "email", "location", "gender", "age", "birthday", "links"];
    const content = { ...Object.fromEntries(fields.map((key) => [key, "Sensitive"])),
      avatar: "/api/uploads/Sensitive.png", avatarX: 12, avatarShape: "circle", fieldOrder: ["email", "phone"] };
    const modules: ModuleData[] = [{ key: "basic", type: "basic", label: "基本信息", sort: 0, content }];
    const config = structuredClone(DEFAULT_ANONYMIZE_CONFIG);
    for (const field of ["name", "phone", "email", "location", "birthday", "links", "avatar"] as const) config[field].enabled = false;
    config.customRules = [{ id: "all", source: "Sensitive", replacement: "Public" }];
    const updated = anonymizeResumeModules(modules, config);
    expect(updated[0]!.content).toEqual({ ...content, ...Object.fromEntries(fields.map((key) => [key, "Public"])) });
    expect(calculateAnonymizeStats(modules, config)).toMatchObject({ replacedOccurrencesCount: fields.length });
    expect(modules[0]!.content).toEqual(content);
  });

  it("自定义规则替换模块标题，Markdown 不残留敏感词且原对象不变", () => {
    const modules: ModuleData[] = [{ key: "summary", type: "summary", label: "Synthetic-Zeus", sort: 0,
      content: { text: "Synthetic-Zeus" } }];
    const config = { ...DEFAULT_ANONYMIZE_CONFIG,
      customRules: [{ id: "audit", source: "synthetic-zeus", replacement: "MASKED" }] };
    const result = anonymizeResumeModules(modules, config);
    expect(result[0]!.label).toBe("MASKED");
    expect(resumeToMarkdown("合成简历", result)).not.toContain("Synthetic-Zeus");
    expect(modules[0]!.label).toBe("Synthetic-Zeus");
    expect(calculateAnonymizeStats(modules, config)).toMatchObject({ replacedRulesCount: 1, replacedOccurrencesCount: 2 });
  });

  it("统计只计实际字段替换，不计 key/id/颜色或被身份脱敏先移除的内容", () => {
    const modules: ModuleData[] = [
      { key: "Synthetic-Zeus", type: "summary", label: "摘要", sort: 0,
        content: { text: '<span style="color: #abcdef">Synthetic-<strong>Zeus</strong></span>' } },
      { key: "basic", type: "basic", label: "基本信息", sort: 1, content: { name: "Synthetic-Zeus" } },
    ];
    const config = { ...DEFAULT_ANONYMIZE_CONFIG, name: { enabled: true, mode: "placeholder" as const },
      customRules: [{ id: "a", source: "Synthetic-Zeus", replacement: "MASKED" },
        { id: "b", source: "#abcdef", replacement: "MASKED-COLOR" }] };
    expect(calculateAnonymizeStats(modules, config)).toMatchObject({ replacedRulesCount: 1, replacedOccurrencesCount: 1 });
  });

  it("重叠规则统计与实际按长词优先替换一致", () => {
    const modules: ModuleData[] = [{ key: "summary", type: "summary", label: "摘要", sort: 0,
      content: { text: "Synthetic-Zeus" } }];
    const config = { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [
      { id: "short", source: "Zeus", replacement: "SHORT" },
      { id: "long", source: "Synthetic-Zeus", replacement: "LONG" },
    ] };
    expect(calculateAnonymizeStats(modules, config)).toMatchObject({ replacedRulesCount: 1, replacedOccurrencesCount: 1 });
  });

  it("替换规则中的美元符号按字面值处理，不恢复原敏感词", () => {
    expect(replaceSensitiveText("姓名张三", [{ id: "name", source: "张三", replacement: "Candidate $&" }]))
      .toBe("姓名Candidate $&");
  });
  describe("姓名脱敏", () => {
    it("处理普通两字与三字中文姓名", () => {
      expect(maskPersonName("张三")).toBe("张*");
      expect(maskPersonName("李小明")).toBe("李**");
    });

    it("正确识别常见复姓", () => {
      expect(maskPersonName("诸葛孔明")).toBe("诸葛**");
      expect(maskPersonName("欧阳六六")).toBe("欧阳**");
    });

    it("处理英文或多段姓名", () => {
      expect(maskPersonName("John Doe")).toBe("J*** D**");
    });

    it("支持直接替换为占位符", () => {
      expect(maskPersonName("张三", "placeholder", "某候选人")).toBe("某候选人");
      expect(maskPersonName("李四", "keep")).toBe("李四");
    });
  });

  describe("联系方式脱敏", () => {
    it("手机号支持只保留前三位或隐藏中间四位", () => {
      expect(maskPhoneNumber("13812345678")).toBe("138********");
      expect(maskPhoneNumber("+86 13987654321")).toBe("139********");
      expect(maskPhoneNumber("13812345678", "mask_middle")).toBe("138****5678");
      expect(maskPhoneNumber("010-88889999", "mask_middle")).toBe("010****9999");
      expect(maskPhoneNumber("13812345678", "placeholder")).toBe("[手机号保密]");
      expect(maskPhoneNumber("13812345678", "remove")).toBe("");
    });

    it("邮箱脱敏保留首字母与域名", () => {
      expect(maskEmailAddress("developer@example.com")).toBe("d***@example.com");
      expect(maskEmailAddress("a@test.org")).toBe("*@test.org");
      expect(maskEmailAddress("test@qq.com", "placeholder")).toBe("[邮箱保密]");
      expect(maskEmailAddress("test@qq.com", "remove")).toBe("");
    });

    it.each(["developer.example.com", "审计测试邮箱", "@example.com"])("无法提取邮箱账号时默认保密：%s", (email) => {
      expect(maskEmailAddress(email)).toBe("[邮箱保密]");
      expect(maskEmailAddress(email, "placeholder")).toBe("[邮箱保密]");
      expect(maskEmailAddress(email, "remove")).toBe("");
    });

    it.each([
      "first@example.test / second@example.test",
      "first@example.test;second@example.test",
      "first@example.test,second@example.test",
      "first@second@example.test",
      "first@example.test 备用私人邮箱",
      "first@example.test（联系人张三）",
      "first@example.test/private-person",
      "first@example.test?name=张三",
      "first@example.test#张三",
      "first@",
      "联系人：first@example.test",
      "First Person <first@example.test>",
      "first@-example.test",
      "first@example-.test",
      "first@example..test",
    ])("字段并非完整单邮箱时不会从域名部分泄漏附加文本：%s", (email) => {
      expect(maskEmailAddress(email)).toBe("[邮箱保密]");
      expect(maskEmailAddress(email, "placeholder")).toBe("[邮箱保密]");
      expect(maskEmailAddress(email, "remove")).toBe("");
    });

    it.each([
      [" first.last+jobs@sub.example-test.com ", "f***@sub.example-test.com"],
      ["user@localhost", "u***@localhost"],
      ["a@x", "*@x"],
    ])("完整单邮箱仍保留安全域名：%s", (email, expected) => {
      expect(maskEmailAddress(email)).toBe(expected);
    });

    it("现居地智能提取城市", () => {
      expect(maskLocationText("北京市朝阳区酒仙桥路X号")).toBe("北京市");
      expect(maskLocationText("浙江省杭州市余杭区文一西路")).toBe("杭州市");
      expect(maskLocationText("广东省深圳市南山区")).toBe("深圳市");
      expect(maskLocationText("上海市浦东新区")).toBe("上海市");
      expect(maskLocationText("北京市", "placeholder")).toBe("[现居地保密]");
    });

    it.each(["审计街道42号9室", "42 Audit Street, Apt 9"])("无法识别城市时不泄漏原地址：%s", (address) => {
      expect(maskLocationText(address)).toBe("[现居地保密]");
    });

    it.each(["科技路42号便民市场附近", "市场路42号"])("地址中的市字不能把门牌误当城市：%s", (address) => {
      expect(maskLocationText(address)).toBe("[现居地保密]");
    });

    it("出生年月仅保留年份", () => {
      expect(maskBirthdayText("1996-08-15")).toBe("1996年");
      expect(maskBirthdayText("1998年5月")).toBe("1998年");
      expect(maskBirthdayText("1998", "placeholder")).toBe("[出生年月保密]");
    });

    it.each(["九六年八月十五日", "08-15", "96年5月"])("无法提取四位年份时默认保密：%s", (birthday) => {
      expect(maskBirthdayText(birthday)).toBe("[出生年月保密]");
      expect(maskBirthdayText(birthday, "placeholder")).toBe("[出生年月保密]");
      expect(maskBirthdayText(birthday, "remove")).toBe("");
    });

    it.each(["", "   "])("空邮箱和出生年月仍保持为空：%s", (value) => {
      expect(maskEmailAddress(value)).toBe("");
      expect(maskBirthdayText(value)).toBe("");
      expect(maskEmailAddress(value, "placeholder")).toBe("");
      expect(maskBirthdayText(value, "placeholder")).toBe("");
    });

    it("链接脱敏清空或保留主域名", () => {
      expect(maskLinksText("https://github.com/my-secret-id\nhttps://linkedin.com/in/secret")).toBe("");
      expect(maskLinksText("https://github.com/my-secret-id", "domain_only")).toBe("github.com/***");
    });
  });

  describe("敏感词与代号替换", () => {
    it("长词优先匹配替换", () => {
      const rules: CustomSensitiveRule[] = [
        { id: "1", source: "Project-Zeus", replacement: "[通用项目A]" },
        { id: "2", source: "Project-Zeus-Ultra", replacement: "[旗舰保密项目]" },
      ];
      const text = "在核心团队深度参与了 Project-Zeus-Ultra 和 Project-Zeus 的研发";
      const result = replaceSensitiveText(text, rules);
      expect(result).toBe("在核心团队深度参与了 [旗舰保密项目] 和 [通用项目A] 的研发");
    });

    it("富文本 AST 安全替换，保留 HTML 标签与行内样式", () => {
      const rules: CustomSensitiveRule[] = [
        { id: "1", source: "字节跳动", replacement: "[某头部大厂]" },
        { id: "2", source: "Project-X", replacement: "[保密中台]" },
      ];
      const html = '<p>在 <strong>字节跳动</strong> 负责 <span style="color: #1d4ed8">Project-X</span> 微服务架构</p>';
      const result = replaceSensitiveRichText(html, rules);
      expect(result).toContain("<strong>[某头部大厂]</strong>");
      expect(result).toContain('<span style="color: #1d4ed8">[保密中台]</span>');
      expect(result).not.toContain("字节跳动");
      expect(result).not.toContain("Project-X");
    });

    it("敏感词跨加粗节点仍会完整替换", () => {
      const result = replaceSensitiveRichText("Synthetic<strong>Secret</strong>", [
        { id: "secret", source: "SyntheticSecret", replacement: "[MASKED]" },
      ]);
      expect(stripRichText(result)).toBe("[MASKED]");
      expect(result).not.toContain("Synthetic");
      expect(result).not.toContain("Secret");
    });

    it("中文敏感词跨嵌套颜色和加粗节点，保留未命中部分的格式", () => {
      const html = '<strong>负责字<span style="color: #1d4ed8">节</span></strong><span style="color: #15803d">跳</span>动平台；字<strong>节跳</strong>动项目；<strong>已交付</strong>';
      const result = replaceSensitiveRichText(html, [
        { id: "company", source: "字节跳动", replacement: "[某企业]" },
      ]);
      expect(stripRichText(result)).toBe("负责[某企业]平台；[某企业]项目；已交付");
      expect(result).toContain("<strong>负责");
      expect(result).toContain("<strong>已交付</strong>");
      expect(result).not.toMatch(/[字节跳动]/);
    });

    it("同一段内多次跨节点匹配不会因替换长度变化丢失后续匹配", () => {
      const html = 'Synthetic<strong>Secret / Synthetic</strong>Secret<span style="color: #15803d"> 完成</span>';
      const result = replaceSensitiveRichText(html, [
        { id: "secret", source: "SyntheticSecret", replacement: "[M]" },
      ]);
      expect(stripRichText(result)).toBe("[M] / [M] 完成");
      expect(result).toContain('<span style="color: #15803d"> 完成</span>');
    });

    it("跨节点匹配仍遵守长词优先与大小写配置", () => {
      const html = "synthetic<strong>Secret</strong> Synthetic<strong>Secret</strong>";
      const result = replaceSensitiveRichText(html, [
        { id: "short", source: "Synthetic", replacement: "[SHORT]" },
        { id: "long", source: "SyntheticSecret", replacement: "[LONG]", matchCase: true },
      ]);
      expect(stripRichText(result)).toBe("[SHORT]Secret [LONG]");
    });

    it("跨节点匹配中的正则字符与替换美元符号按字面值处理，HTML 只作为文本输出", () => {
      const replacement = '<img src=x onerror=alert(1)> $& $1';
      const result = replaceSensitiveRichText("R&amp;<strong>D.Secret</strong> R&amp;DXSecret", [
        { id: "secret", source: "R&D.Secret", replacement },
      ]);
      expect(stripRichText(result)).toBe(`${replacement} R&DXSecret`);
      expect(result).toContain("&lt;img src=x onerror=alert(1)&gt; $&amp; $1");
      expect(result).not.toContain("<img");
    });

    it.each([
      "Synthetic<br>Secret",
      "<strong>Synthetic<br>Secret</strong>",
      "Synthetic\n<strong>Secret</strong>",
      "Synthetic\r\nSecret",
      "<p>Synthetic</p><p>Secret</p>",
      "<div>Synthetic</div><div>Secret</div>",
      "Synthetic<p>Secret</p>",
    ])("不会跨换行或段落误匹配：%s", (html) => {
      const result = replaceSensitiveRichText(html, [
        { id: "joined", source: "SyntheticSecret", replacement: "[MASKED]" },
        { id: "newline", source: "Synthetic\nSecret", replacement: "[MASKED]" },
      ]);
      expect(result).toContain("Synthetic");
      expect(result).toContain("Secret");
      expect(result).not.toContain("[MASKED]");
    });

    it.each(["\n", "\r\n", "\u2028", "\u2029"])("后续富文本规则不能跨替换值新增的换行：%j", (separator) => {
      const replacement = `X${separator}Y`;
      const rules = [
        { id: "original", source: "OriginalSecret", replacement },
        { id: "newline", source: replacement, replacement: "CROSSED" },
      ];
      const result = replaceSensitiveRichText("Original<strong>Secret</strong>", rules);
      expect(stripRichText(result)).toBe(replacement);
      expect(replaceSensitiveText("OriginalSecret", rules)).toBe("CROSSED");
    });
  });

  describe("模块数据全量不可变脱敏", () => {
    it("默认保密回退和跨格式替换会应用于模块，原始对象和规则保持不变", () => {
      const modules: ModuleData[] = [
        { key: "basic", type: "basic", label: "基本信息", sort: 0, content: { email: "私人邮箱未提供域名", birthday: "八月十五日" } },
        { key: "work", type: "work", label: "工作经历", sort: 1, content: [
          { id: "work-1", company: "公开企业", title: "开发", description: "Synthetic<strong>Secret</strong>", descriptionItems: ['Syn<span style="color: #1d4ed8">thetic</span>Secret'] },
        ] },
      ];
      const config = { ...DEFAULT_ANONYMIZE_CONFIG, customRules: [
        { id: "secret", source: "SyntheticSecret", replacement: "[MASKED]" },
      ] };
      const originalModules = structuredClone(modules);
      const originalConfig = structuredClone(config);
      const result = anonymizeResumeModules(modules, config);

      expect(result[0]!.content).toEqual({ email: "[邮箱保密]", birthday: "[出生年月保密]" });
      const work = result[1]!.content as Array<{ description: string; descriptionItems: string[] }>;
      expect(stripRichText(work[0]!.description)).toBe("[MASKED]");
      expect(stripRichText(work[0]!.descriptionItems[0]!)).toBe("[MASKED]");
      expect(modules).toEqual(originalModules);
      expect(config).toEqual(originalConfig);
    });

    it("确保原始模块对象不被改变，正确脱敏经历及基本信息", () => {
      const originalModules: ModuleData[] = [
        {
          key: "basic",
          type: "basic",
          label: "基本信息",
          sort: 0,
          content: {
            name: "李小明",
            phone: "13800138000",
            email: "ming@vip.com",
            location: "广东省深圳市南山区高新园",
            birthday: "1995-10-01",
            links: "https://github.com/ming-dev",
            avatar: "/api/uploads/avatar.png",
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
              title: "前端工程师",
              start: "2020-01",
              end: "2023-01",
              description: "主导 Project-Apollo 的开发与性能重构",
              subItems: [{ id: "s1", label: "核心产品", value: "字节跳动核心商业化系统" }],
            },
          ],
        },
      ];

      const config: AnonymizeConfig = {
        ...DEFAULT_ANONYMIZE_CONFIG,
        customRules: [
          { id: "r1", source: "字节跳动", replacement: "[某一线大厂]" },
          { id: "r2", source: "Project-Apollo", replacement: "[保密核心架构]" },
        ],
      };

      const result = anonymizeResumeModules(originalModules, config);

      // 验证深拷贝隔离
      expect(result).not.toBe(originalModules);
      expect(result[0]!.content).not.toBe(originalModules[0]!.content);

      // 验证原始对象未受污染
      const origBasic = originalModules[0]!.content as Record<string, unknown>;
      expect(origBasic.name).toBe("李小明");
      expect(origBasic.phone).toBe("13800138000");
      expect(origBasic.avatar).toBe("/api/uploads/avatar.png");

      // 验证脱敏后对象
      const newBasic = result[0]!.content as Record<string, unknown>;
      expect(newBasic.name).toBe("李**");
      expect(newBasic.phone).toBe("138********");
      expect(newBasic.email).toBe("m***@vip.com");
      expect(newBasic.location).toBe("深圳市");
      expect(newBasic.birthday).toBe("1995年");
      expect(newBasic.links).toBe("");
      expect(newBasic.avatar).toBeUndefined();

      // 验证经历中敏感词替换
      const newWork = result[1]!.content as Array<{ company: string; description: string; subItems?: Array<{ value: string }> }>;
      expect(newWork[0]!.company).toBe("[某一线大厂]");
      expect(newWork[0]!.description).toBe("主导 [保密核心架构] 的开发与性能重构");
      expect(newWork[0]!.subItems![0]!.value).toBe("[某一线大厂]核心商业化系统");
    });

    it("完整简历对象脱敏为标题添加 [脱敏版] 标识", () => {
      const fullResume = {
        resume: {
          id: 1,
          title: "李小明的求职简历",
          template: "classic",
          style_overrides: {},
          created_at: "",
          updated_at: "",
        },
        modules: [
          {
            key: "basic",
            type: "basic" as const,
            label: "基本信息",
            sort: 0,
            content: { name: "李小明" },
          },
        ],
        warnings: [],
        corruptedKeys: [],
      };

      const res = anonymizeResumeData(fullResume, {
        ...DEFAULT_ANONYMIZE_CONFIG,
        customRules: [{ id: "r1", source: "李小明", replacement: "李**" }],
      });

      expect(res.resume.title).toBe("[脱敏版] 李**的求职简历");
      expect(fullResume.resume.title).toBe("李小明的求职简历");
    });
  });

  describe("extractResumeEntities 自动提取实体", () => {
    it("自动从简历模块中提取工作单位、项目名称与毕业学校，并分配对应占位符", () => {
      const sampleModules: ModuleData[] = [
        {
          key: "work",
          type: "work",
          label: "工作经历",
          sort: 0,
          content: [
            { id: "w1", company: "北京字节跳动科技有限公司", title: "前端开发" },
            { id: "w2", company: "招商银行网络科技", title: "全栈工程师" },
            { id: "w3", company: "北京字节跳动科技有限公司", title: "实习生" }, // 重复公司去重
          ],
        },
        {
          key: "projects",
          type: "projects",
          label: "项目经历",
          sort: 1,
          content: [
            { id: "p1", name: "微前端底座平台", role: "负责人" },
            { id: "p2", name: "低代码搭建中台", role: "核心研发" },
          ],
        },
        {
          key: "education",
          type: "education",
          label: "教育经历",
          sort: 2,
          content: [
            { id: "e1", school: "清华大学", degree: "硕士" },
          ],
        },
      ];

      const entities = extractResumeEntities(sampleModules);

      // 公司提取去重验证
      const companies = entities.filter((e) => e.kind === "company");
      expect(companies).toHaveLength(2);
      expect(companies[0]!.source).toBe("北京字节跳动科技有限公司");
      expect(companies[0]!.defaultReplacement).toBe("[某头部互联网企业]");
      expect(companies[1]!.source).toBe("招商银行网络科技");

      // 项目提取验证
      const projects = entities.filter((e) => e.kind === "project");
      expect(projects).toHaveLength(2);
      expect(projects[0]!.source).toBe("微前端底座平台");
      expect(projects[0]!.defaultReplacement).toBe("[某核心业务项目1]");

      // 学校提取验证
      const schools = entities.filter((e) => e.kind === "school");
      expect(schools).toHaveLength(1);
      expect(schools[0]!.source).toBe("清华大学");
      expect(schools[0]!.defaultReplacement).toBe("[某高等院校1]");
    });
  });
});
