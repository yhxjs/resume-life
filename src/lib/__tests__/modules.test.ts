import { describe, it, expect } from "vitest";
import {
  isModuleKey,
  genModuleKey,
  resumeWordCount,
  normalizeContent,
  defaultContent,
  MODULE_KEYS,
  MODULE_LABELS,
  isLocalAvatarUrl,
  type ModuleData,
} from "../modules";
import { prepare } from "@/components/resume/doc-data";

describe("modules.ts 简历模块与内容清洗", () => {
  it("恢复后的版本化本机头像能进入编辑预览，任意查询参数不能进入", () => {
    const versioned = "/api/uploads/avatar.png?v=8f130bae-f339-493b-a69b-b41d9f471323";
    expect(isLocalAvatarUrl(versioned)).toBe(true);
    expect(normalizeContent("basic", { avatar: versioned }).avatar).toBe(versioned);
    expect(prepare("简历", [{ type: "basic", label: "基本信息", content: { avatar: versioned } }]).avatar)
      .toBe(versioned);
    const preparedWithGenderAge = prepare("简历", [
      {
        type: "basic",
        label: "基本信息",
        content: { name: "张三", gender: "男", age: "25岁", phone: "13800000000", email: "test@example.com" },
      },
    ]);
    expect(preparedWithGenderAge.contact).toBe("男 · 25岁 · 13800000000 · test@example.com");

    const preparedWithoutGenderAge = prepare("简历", [
      {
        type: "basic",
        label: "基本信息",
        content: { name: "张三", phone: "13800000000" },
      },
    ]);
    expect(preparedWithoutGenderAge.contact).toBe("13800000000");

    const preparedCustomOrder = prepare("简历", [
      {
        type: "basic",
        label: "基本信息",
        content: {
          name: "张三",
          gender: "男",
          age: "25岁",
          phone: "13800000000",
          email: "test@example.com",
          fieldOrder: ["phone", "email", "gender", "age", "location", "birthday", "links"],
        },
      },
    ]);
    expect(preparedCustomOrder.contact).toBe("13800000000 · test@example.com · 男 · 25岁");

    expect(isLocalAvatarUrl("/api/uploads/avatar.png?redirect=https://example.com")).toBe(false);
    expect(isLocalAvatarUrl("https://example.com/avatar.png?v=8f130bae-f339-493b-a69b-b41d9f471323")).toBe(false);
  });

  it("MODULE_KEYS 与 MODULE_LABELS 包含所有标准内置模块类型", () => {
    expect(MODULE_KEYS).toEqual(["basic", "education", "work", "projects", "skills", "summary", "custom"]);
    for (const key of MODULE_KEYS) {
      expect(MODULE_LABELS[key]).toBeTruthy();
      expect(isModuleKey(key)).toBe(true);
    }
    expect(isModuleKey("invalid_key")).toBe(false);
    expect(isModuleKey(123)).toBe(false);
    expect(isModuleKey(null)).toBe(false);
  });

  it("genModuleKey 生成以 mod_ 开头的稳定模块标识且递增不重复", () => {
    const k1 = genModuleKey();
    const k2 = genModuleKey();
    expect(k1).toMatch(/^mod_[a-z0-9]+_\d+$/);
    expect(k2).toMatch(/^mod_[a-z0-9]+_\d+$/);
    expect(k1).not.toBe(k2);
  });

  it("defaultContent 提供各模块的默认空数据结构", () => {
    expect(defaultContent("basic")).toEqual({
      name: "",
      phone: "",
      email: "",
      location: "",
      gender: "",
      age: "",
      birthday: "",
      links: "",
      fieldOrder: ["gender", "age", "phone", "email", "location", "birthday", "links"],
      avatar: "",
      avatarX: 0,
      avatarY: 0,
      avatarSize: 72,
      avatarShape: "rounded",
    });
    expect(defaultContent("education")).toEqual([]);
    expect(defaultContent("work")).toEqual([]);
    expect(defaultContent("projects")).toEqual([]);
    expect(defaultContent("skills")).toEqual({ items: [] });
    expect(defaultContent("summary")).toEqual({ text: "", descriptionItems: [], descriptionStyle: "unordered" });
    expect(defaultContent("custom")).toEqual([]);
  });

  it("resumeWordCount 准确统计中英文混合字数，并排除 id 字段", () => {
    const testModules: ModuleData[] = [
      {
        key: "basic",
        type: "basic",
        label: "基本信息",
        sort: 1,
        content: {
          name: "张三", // 2 汉字
          phone: "13800000000", // 1 英文/数字词
          email: "test@example.com", // 1 英文/数字词 (正则按单词连续匹配)
          location: "北京", // 2 汉字
          links: "https://github.com",
        },
      },
      {
        key: "projects",
        type: "projects",
        label: "项目经历",
        sort: 2,
        content: [
          {
            id: "it_excluded_id_12345", // 不计入字数
            name: "在线简历系统", // 6 汉字
            role: "全栈开发", // 4 汉字
            start: "2024-01", // 1 词
            end: "2024-06", // 1 词
            description: "采用 Next.js 构建高性能 Web 应用。", // 汉字 14 + Next.js(2词: Next, js) + Web(1词) + 标点
          },
        ],
      },
    ];

    const count = resumeWordCount(testModules);
    expect(count).toBeGreaterThan(20);
    // 确保 id 字符串里的字符绝对不影响字数
    const withDifferentId = JSON.parse(JSON.stringify(testModules));
    withDifferentId[1].content[0].id = "it_a_very_very_long_id_that_should_not_count_999999999";
    expect(resumeWordCount(withDifferentId)).toBe(count);
  });

  describe("normalizeContent 边界清洗与防御测试", () => {
    it("清洗 basic 模块：非字符串字段自动回退为空字符串，头像字段得到合法清洗", () => {
      const raw = {
        name: 123,
        phone: null,
        email: "alice@example.com",
        location: undefined,
        birthday: "1998-05",
        gender: "男",
        age: "26岁",
        avatar: "/api/uploads/my-avatar.png",
        avatarX: -25.4,
        avatarY: -15.8,
        avatarSize: 100,
        avatarShape: "rounded",
        extraUnknownField: "should_be_ignored",
      };
      const cleaned = normalizeContent("basic", raw);
      expect(cleaned).toEqual({
        name: "",
        phone: "",
        email: "alice@example.com",
        location: "",
        gender: "男",
        age: "26岁",
        birthday: "1998-05",
        links: "",
        fieldOrder: ["gender", "age", "phone", "email", "location", "birthday", "links"],
        avatar: "/api/uploads/my-avatar.png",
        avatarX: -25,
        avatarY: -16,
        avatarSize: 100,
        avatarShape: "rounded",
      });
    });

    it("清洗 basic 模块：fieldOrder 保持自定义顺序，自动补齐缺失项，去重并过滤非法字段", () => {
      const raw = {
        name: "李雷",
        fieldOrder: ["phone", "email", "phone", "invalid_field", 123, "gender"],
      };
      const cleaned = normalizeContent("basic", raw);
      expect(cleaned.fieldOrder).toEqual([
        "phone",
        "email",
        "gender",
        "age",
        "location",
        "birthday",
        "links",
      ]);
    });

    it("清洗 basic 模块：非法头像数值和形状被安全忽略或收敛，且正向X偏移被钳制为0防出界", () => {
      const raw = {
        avatar: 123,
        avatarX: 50, // 往右超出被钳制为 0
        avatarY: NaN,
        avatarSize: 9999, // 超出上限
        avatarShape: "unknown_shape",
      };
      const cleaned = normalizeContent("basic", raw);
      expect(cleaned.avatar).toBeUndefined();
      expect(cleaned.avatarX).toBe(0);
      expect(cleaned.avatarY).toBeUndefined();
      expect(cleaned.avatarSize).toBe(160); // 钳制在 160
      expect(cleaned.avatarShape).toBeUndefined();
    });

    it("basic 头像只接受本站上传地址", () => {
      expect(normalizeContent("basic", { avatar: "/api/uploads/photo.png" }).avatar).toBe("/api/uploads/photo.png");
      expect(normalizeContent("basic", { avatar: "/uploads/old-photo.jpg" }).avatar).toBeUndefined();
      for (const avatar of [
        "https://example.com/photo.png",
        "//example.com/photo.png",
        "/api/uploads/../private.png",
        "/api/uploads/photo.png?redirect=https://example.com",
        "data:image/svg+xml,<svg></svg>",
      ]) {
        expect(normalizeContent("basic", { avatar }).avatar).toBeUndefined();
      }
    });

    it("清洗 education/work/projects 列表：自动生成或保留唯一项 ID", () => {
      const rawEdu = [
        { school: "清华大学", degree: "硕士", field: "计算机", start: "2020", end: "2023", description: "优秀毕业生" },
        { id: "custom_edu_id", school: "北京大学", degree: "学士" },
        null, // 非法项
      ];
      const cleanedEdu = normalizeContent("education", rawEdu);
      expect(cleanedEdu).toHaveLength(3);
      expect(cleanedEdu[0]!.school).toBe("清华大学");
      expect(cleanedEdu[0]!.id).toMatch(/^it_/); // 自动补齐 ID
      expect(cleanedEdu[1]!.id).toBe("custom_edu_id"); // 保留已有 ID
      expect(cleanedEdu[1]!.field).toBe(""); // 缺失字段回退空串
      expect(cleanedEdu[2]!.school).toBe(""); // null 项优雅回退
    });

    it("清洗 skills 模块：过滤非字符串项", () => {
      const rawSkills = {
        items: ["React", 123, null, "TypeScript", false, "Next.js"],
      };
      const cleaned = normalizeContent("skills", rawSkills);
      expect(cleaned.items).toEqual(["React", "TypeScript", "Next.js"]);

      // 非法结构回退为空数组
      expect(normalizeContent("skills", null).items).toEqual([]);
      expect(normalizeContent("skills", { items: "not-array" }).items).toEqual([]);
    });

    it("summary 显式列表保留风格与空行，同步正文并拒绝非法字段", () => {
      const content = { text: "旧正文", descriptionItems: [" 第一项 ", "", "第二项"], descriptionStyle: "ordered" };
      expect(normalizeContent("summary", content)).toEqual({ ...content, text: "第一项\n第二项" });
      expect(normalizeContent("summary", { ...content, descriptionItems: [] })).toEqual({ ...content, text: "", descriptionItems: [] });
    });

    it("清洗 summary 模块：非法类型安全回退", () => {
      expect(normalizeContent("summary", { text: "自我介绍" })).toEqual({ text: "自我介绍", descriptionItems: ["自我介绍"], descriptionStyle: "unordered" });
      expect(normalizeContent("summary", { text: 12345 })).toEqual(defaultContent("summary"));
      expect(normalizeContent("summary", null)).toEqual(defaultContent("summary"));
    });

    it("prepare 格式化 summary 模块：多行文本拆解为多项 descriptionItems 并保留列表风格", () => {
      const preparedFromLines = prepare("简历", [
        {
          type: "summary",
          label: "自我评价",
          content: { text: "精通前端工程化体系搭建\n具备高并发后端架构经验" },
        },
      ]);
      const summarySection = preparedFromLines.sections.find((s) => s.label === "自我评价");
      expect(summarySection).toEqual({
        kind: "text",
        moduleKey: "summary",
        label: "自我评价",
        text: "精通前端工程化体系搭建\n具备高并发后端架构经验",
        descriptionItems: ["精通前端工程化体系搭建", "具备高并发后端架构经验"],
        descriptionStyle: "unordered",
      });

      const preparedFromItems = prepare("简历", [
        {
          type: "summary",
          label: "自我评价",
          content: {
            text: "条目一\n条目二",
            descriptionItems: ["条目一", "条目二"],
            descriptionStyle: "ordered",
          },
        },
      ]);
      const orderedSection = preparedFromItems.sections.find((s) => s.label === "自我评价");
      expect(orderedSection).toEqual({
        kind: "text",
        moduleKey: "summary",
        label: "自我评价",
        text: "条目一\n条目二",
        descriptionItems: ["条目一", "条目二"],
        descriptionStyle: "ordered",
      });
    });

    it("清洗 custom 模块：支持多项条目和自定义副项 subItems", () => {
      const rawCustom = [
        {
          title: "ACM-ICPC 区域赛金奖",
          subTitle: "国际大学生程序设计竞赛",
          start: "2023-11",
          description: "排名前 1%\n获得全球总决赛资格",
          subItems: [
            { label: "类别", value: "竞赛获奖" },
            { label: "编号", value: "GOLD-2023" },
          ],
          descriptionStyle: "ordered",
        },
      ];
      const cleaned = normalizeContent("custom", rawCustom);
      expect(cleaned).toHaveLength(1);
      expect(cleaned[0]!.title).toBe("ACM-ICPC 区域赛金奖");
      expect(cleaned[0]!.subTitle).toBe("国际大学生程序设计竞赛");
      expect(cleaned[0]!.start).toBe("2023-11");
      expect(cleaned[0]!.subItems).toHaveLength(2);
      expect(cleaned[0]!.subItems?.[0]!.label).toBe("类别");
      expect(cleaned[0]!.subItems?.[0]!.value).toBe("竞赛获奖");
      expect(cleaned[0]!.descriptionStyle).toBe("ordered");
      expect(cleaned[0]!.descriptionItems).toEqual(["排名前 1%", "获得全球总决赛资格"]);

      expect(normalizeContent("custom", { text: "非列表输入" })).toEqual([]);

      expect(normalizeContent("custom", null)).toEqual([]);
    });

    it("清洗 projects 模块：支持副项 subItems 清洗、多行描述 descriptionItems 与风格转换", () => {
      const rawProjects = [
        {
          name: "在线简历生成器",
          role: "技术负责人",
          start: "2023-01",
          end: "2024-06",
          description: "基于 Next.js 15 开发\n支持多端响应式与 A4 纸排版\n实现本地 SQLite 数据持久化",
          subItems: [
            { label: "技术栈", value: "Next.js, React 19, TypeScript" },
            { id: "custom_link_id", label: "项目链接", value: "https://github.com/example" },
            null, // 非法项
          ],
          descriptionStyle: "ordered",
        },
        {
          id: "p2",
          name: "旧版项目",
          role: "开发",
          description: "单行描述",
          // 无 subItems 和 descriptionItems
        },
      ];

      const cleaned = normalizeContent("projects", rawProjects);
      expect(cleaned).toHaveLength(2);

      const p1 = cleaned[0];
      expect(p1!.name).toBe("在线简历生成器");
      expect(p1!.subItems).toHaveLength(3);
      expect(p1!.subItems?.[0]!.label).toBe("技术栈");
      expect(p1!.subItems?.[0]!.value).toBe("Next.js, React 19, TypeScript");
      expect(p1!.subItems?.[0]!.id).toMatch(/^it_/);
      expect(p1!.subItems?.[1]!.id).toBe("custom_link_id");
      expect(p1!.subItems?.[2]!.label).toBe("");
      expect(p1!.descriptionStyle).toBe("ordered");
      expect(p1!.descriptionItems).toEqual([
        "基于 Next.js 15 开发",
        "支持多端响应式与 A4 纸排版",
        "实现本地 SQLite 数据持久化",
      ]);
      expect(p1!.description).toBe(
        "基于 Next.js 15 开发\n支持多端响应式与 A4 纸排版\n实现本地 SQLite 数据持久化"
      );

      const p2 = cleaned[1];
      expect(p2!.id).toBe("p2");
      expect(p2!.subItems).toEqual([]);
      expect(p2!.descriptionStyle).toBe("unordered");
      expect(p2!.descriptionItems).toEqual(["单行描述"]);
      expect(p2!.description).toBe("单行描述");
    });

    it("清洗 work 模块：支持副项 subItems 清洗、多行描述 descriptionItems 与风格转换", () => {
      const rawWork = [
        {
          company: "字节跳动",
          title: "高级前端工程师",
          start: "2021-03",
          end: "2024-05",
          description: "负责抖音电商核心链路架构\n主导前端性能治理优化\n推动工程化研发提效",
          subItems: [
            { label: "所属部门", value: "电商研发中台" },
            { id: "custom_tech_id", label: "核心技术", value: "React 19, TypeScript, Rust" },
            null, // 非法项
          ],
          descriptionStyle: "ordered",
        },
        {
          id: "w2",
          company: "腾讯科技",
          title: "前端开发",
          description: "老版本单行工作内容",
          // 缺失 subItems 与 descriptionItems
        },
      ];

      const cleaned = normalizeContent("work", rawWork);
      expect(cleaned).toHaveLength(2);

      // 工作 1
      const w1 = cleaned[0];
      expect(w1!.company).toBe("字节跳动");
      expect(w1!.title).toBe("高级前端工程师");
      expect(w1!.subItems).toHaveLength(3);
      expect(w1!.subItems?.[0]!.label).toBe("所属部门");
      expect(w1!.subItems?.[0]!.value).toBe("电商研发中台");
      expect(w1!.subItems?.[0]!.id).toMatch(/^it_/);
      expect(w1!.subItems?.[1]!.id).toBe("custom_tech_id");
      expect(w1!.subItems?.[2]!.label).toBe("");
      expect(w1!.descriptionStyle).toBe("ordered");
      // 换行文本自动拆分为多行
      expect(w1!.descriptionItems).toEqual([
        "负责抖音电商核心链路架构",
        "主导前端性能治理优化",
        "推动工程化研发提效",
      ]);
      expect(w1!.description).toBe(
        "负责抖音电商核心链路架构\n主导前端性能治理优化\n推动工程化研发提效"
      );

      const w2 = cleaned[1];
      expect(w2!.id).toBe("w2");
      expect(w2!.subItems).toEqual([]);
      expect(w2!.descriptionStyle).toBe("unordered");
      expect(w2!.descriptionItems).toEqual(["老版本单行工作内容"]);
      expect(w2!.description).toBe("老版本单行工作内容");
    });

    it("resumeWordCount 包含 subItems 且不因 descriptionItems 双重计数字数", () => {
      const modules: ModuleData[] = [
        {
          key: "projects",
          type: "projects",
          label: "项目经历",
          sort: 1,
          content: [
            {
              id: "p1",
              name: "电商平台", // 4
              role: "主程", // 2
              start: "2023", // 1
              end: "2024", // 1
              description: "第一行描述\n第二行描述", // 10
              subItems: [
                { id: "s1", label: "技术栈", value: "React" }, // 3 + 1
              ],
              descriptionItems: ["第一行描述", "第二行描述"], // 跳过，不重复计
              descriptionStyle: "ordered", // 跳过
            },
          ],
        },
      ];

      const countWithBoth = resumeWordCount(modules);

      // 如果移除 descriptionItems，字数应该完全一致
      const modulesWithoutItems = JSON.parse(JSON.stringify(modules));
      delete modulesWithoutItems[0].content[0].descriptionItems;
      const countWithout = resumeWordCount(modulesWithoutItems);

      expect(countWithBoth).toBe(countWithout);
    });
  });
});
