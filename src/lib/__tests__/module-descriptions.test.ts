import { describe, expect, it } from "vitest";
import {
  readDescribableItems,
  writeDescribableItem,
  writeDiagnosisValue,
} from "../module-descriptions";
import { normalizeContent } from "../modules";
import type { EducationItem, ProjectItem, WorkItem } from "../modules";

// descriptionItems 显式给空数组：真实数据由 normalizeContent 产出，
// 该函数保证每条记录都有 descriptionItems（见 modules.ts 的
// normalizeDescriptionItemsAndStyle），不会留 undefined。
// 用裸 description 的 fixture 会掩盖「写入被 descriptionItems 覆盖」这类缺陷。
const workContent: WorkItem[] = [
  {
    id: "w1",
    company: "字节跳动",
    title: "前端工程师",
    start: "2021-03",
    end: "2023-06",
    description: "主导订单链路重构",
    descriptionItems: [],
  },
  {
    id: "w2",
    company: "腾讯",
    title: "高级工程师",
    start: "2023-07",
    end: "至今",
    description: "",
    descriptionItems: [],
  },
];

const projectContent: ProjectItem[] = [
  {
    id: "p1",
    name: "实时数据同步平台",
    role: "技术负责人",
    start: "2023-03",
    end: "2024-06",
    description: "旧字段内容",
    descriptionItems: ["<strong>主导</strong>同步链路", "支撑日活 10 万+"],
    descriptionStyle: "unordered",
  },
  {
    id: "p2",
    name: "企业级微前端",
    role: "核心开发",
    start: "2022-01",
    end: "2022-12",
    description: "只有 description 的项目",
  },
];

describe("readDescribableItems", () => {
  it("work：读 description 与 company/title 上下文", () => {
    const items = readDescribableItems("work", workContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: "w1",
      title: "字节跳动 · 前端工程师",
      text: "主导订单链路重构",
      context: { company: "字节跳动", title: "前端工程师" },
    });
    expect(items[1]!.text).toBe("");
  });

  it("projects：优先读 descriptionItems，并带上 name/role 上下文", () => {
    const items = readDescribableItems("projects", projectContent);
    expect(items[0]!.text).toBe("<strong>主导</strong>同步链路\n支撑日活 10 万+");
    expect(items[0]!.context).toEqual({ name: "实时数据同步平台", role: "技术负责人" });
  });

  it("projects：无 descriptionItems 时回退 description", () => {
    const items = readDescribableItems("projects", projectContent);
    expect(items[1]!.text).toBe("只有 description 的项目");
  });

  it("空数组返回空", () => {
    expect(readDescribableItems("work", [])).toEqual([]);
    expect(readDescribableItems("projects", [])).toEqual([]);
  });

  it("非法 content 返回空数组", () => {
    expect(readDescribableItems("work", null)).toEqual([]);
    expect(readDescribableItems("work", { foo: 1 })).toEqual([]);
    expect(readDescribableItems("projects", "字符串")).toEqual([]);
  });

  it("缺 id 的条目被跳过", () => {
    expect(readDescribableItems("work", [{ company: "无 id" }])).toEqual([]);
  });

  it("当工作经历中残留公司与岗位抬头时自动剥离", () => {
    const rawWithHeader: WorkItem[] = [
      {
        id: "w1",
        company: "微财数科",
        title: "Java 开发工程师",
        start: "",
        end: "",
        description: "微财数科 | Java 开发工程师\n• 主导客服系统后端模块开发",
        descriptionItems: ["微财数科 | Java 开发工程师", "• 主导客服系统后端模块开发"],
      },
    ];
    const items = readDescribableItems("work", rawWithHeader);
    expect(items[0]!.text).toBe("• 主导客服系统后端模块开发");
  });
});

describe("writeDescribableItem", () => {
  it("work：拆行写回 descriptionItems 并同步 description", () => {
    const next = writeDescribableItem("work", workContent, "w1", "<strong>新描述</strong>") as WorkItem[];
    expect(next[0]!.description).toBe("<strong>新描述</strong>");
    expect(next[0]!.descriptionItems).toEqual(["<strong>新描述</strong>"]);
    expect(next[0]!.company).toBe("字节跳动");
    expect(next[1]!.description).toBe("");
    expect(next[1]!.descriptionItems).toEqual([]);
  });

  it("work：多行描述剥掉行首符号后拆分写入 descriptionItems 并合并为 description", () => {
    const next = writeDescribableItem(
      "work",
      workContent,
      "w1",
      "• 主导订单链路重构\n- 支撑日活 10 万+"
    ) as WorkItem[];
    expect(next[0]!.description).toBe("主导订单链路重构\n支撑日活 10 万+");
    expect(next[0]!.descriptionItems).toEqual(["主导订单链路重构", "支撑日活 10 万+"]);
  });

  it("work：写入包含公司或岗位抬头的文本时自动清洗", () => {
    const next = writeDescribableItem(
      "work",
      workContent,
      "w1",
      "字节跳动 | 前端工程师\n• 主导订单链路重构\n- 支撑日活 10 万+"
    ) as WorkItem[];
    expect(next[0]!.description).toBe("主导订单链路重构\n支撑日活 10 万+");
    expect(next[0]!.descriptionItems).toEqual(["主导订单链路重构", "支撑日活 10 万+"]);
  });

  it("work：内容为空时 description 为空串，descriptionItems 为空数组", () => {
    const next = writeDescribableItem("work", workContent, "w1", "") as WorkItem[];
    expect(next[0]!.description).toBe("");
    expect(next[0]!.descriptionItems).toEqual([]);
  });

  it("work：更新的是被写入那条，其余条目不动", () => {
    const withItems: WorkItem[] = [
      { ...workContent[0]!, descriptionItems: ["旧行一", "旧行二"] },
      { ...workContent[1]!, descriptionItems: ["别人的行"] },
    ];
    const next = writeDescribableItem("work", withItems, "w1", "新描述") as WorkItem[];
    expect(next[0]!.descriptionItems).toEqual(["新描述"]);
    expect(next[0]!.description).toBe("新描述");
    expect(next[1]!.descriptionItems).toEqual(["别人的行"]);
  });

  it("projects：拆行写回 descriptionItems 并同步 description", () => {
    const next = writeDescribableItem(
      "projects",
      projectContent,
      "p1",
      "• 主导同步链路\n- 支撑日活 10 万+"
    ) as ProjectItem[];
    expect(next[0]!.descriptionItems).toEqual(["主导同步链路", "支撑日活 10 万+"]);
    expect(next[0]!.description).toBe("主导同步链路\n支撑日活 10 万+");
    expect(next[0]!.name).toBe("实时数据同步平台");
  });

  it("projects：内容为空时 descriptionItems 为空数组", () => {
    const next = writeDescribableItem("projects", projectContent, "p1", "") as ProjectItem[];
    expect(next[0]!.descriptionItems).toEqual([]);
    expect(next[0]!.description).toBe("");
  });

  it("work：写入后穿过生产 normalizeContent 仍是新描述与多行条目", () => {
    const stale: WorkItem[] = [
      { ...workContent[0]!, description: "旧描述", descriptionItems: ["更旧的一行"] },
    ];
    const written = writeDescribableItem("work", stale, "w1", "<strong>新描述</strong>") as WorkItem[];
    const normalized = normalizeContent("work", written) as WorkItem[];
    expect(normalized[0]!.description).toBe("<strong>新描述</strong>");
    expect(normalized[0]!.descriptionItems).toEqual(["<strong>新描述</strong>"]);
  });

  it("work：对同一 id 重复写入是幂等的", () => {
    const once = writeDescribableItem("work", workContent, "w1", "<strong>新描述</strong>");
    const twice = writeDescribableItem("work", once, "w1", "<strong>新描述</strong>");
    expect(twice).toEqual(once);
  });

  it("id 未命中时原样返回", () => {
    const next = writeDescribableItem("work", workContent, "不存在", "x");
    expect(next).toEqual(workContent);
  });

  it("非法 content 原样返回", () => {
    expect(writeDescribableItem("work", null, "w1", "x")).toBeNull();
  });

  it("不修改传入的数组", () => {
    const before = JSON.stringify(workContent);
    writeDescribableItem("work", workContent, "w1", "改了");
    expect(JSON.stringify(workContent)).toBe(before);
  });
});

describe("writeDiagnosisValue", () => {
  it("work：写回 descriptionItems 并同步 description，穿过 normalizeContent 仍是新描述", () => {
    const stale: WorkItem[] = [
      { ...workContent[0]!, description: "旧描述", descriptionItems: ["更旧的一行"] },
    ];
    const next = writeDiagnosisValue("work", stale, "w1", "<strong>对齐 JD</strong>") as WorkItem[];
    expect(next[0]!.description).toBe("<strong>对齐 JD</strong>");
    expect(next[0]!.descriptionItems).toEqual(["<strong>对齐 JD</strong>"]);

    const normalized = normalizeContent("work", next) as WorkItem[];
    expect(normalized[0]!.description).toBe("<strong>对齐 JD</strong>");
    expect(normalized[0]!.descriptionItems).toEqual(["<strong>对齐 JD</strong>"]);
  });

  it("projects：拆行写回 descriptionItems 并同步 description", () => {
    const next = writeDiagnosisValue(
      "projects",
      projectContent,
      "p1",
      "• 主导同步链路\n- 支撑日活 10 万+"
    ) as ProjectItem[];
    expect(next[0]!.descriptionItems).toEqual(["主导同步链路", "支撑日活 10 万+"]);
    expect(next[0]!.description).toBe("主导同步链路\n支撑日活 10 万+");

    const normalized = normalizeContent("projects", next) as ProjectItem[];
    expect(normalized[0]!.descriptionItems).toEqual(["主导同步链路", "支撑日活 10 万+"]);
  });

  it("education 不含 descriptionItems，只写 description 也不会被覆盖", () => {
    // normalizeContent 的 education 分支不产出 descriptionItems，
    // 所以 JD 对教育经历的改写本来就落得住；这条钉住这个前提。
    const edu: EducationItem[] = [
      { id: "e1", school: "某大学", degree: "本科", field: "计算机", start: "", end: "", description: "旧备注" },
    ];
    const next = writeDiagnosisValue("education", edu, "e1", "新备注") as EducationItem[];
    expect(next[0]!.description).toBe("新备注");

    const normalized = normalizeContent("education", next) as EducationItem[];
    expect(normalized[0]!.description).toBe("新备注");
  });

  it("id 未命中时返回 null（调用方据此提示定位失败）", () => {
    expect(writeDiagnosisValue("work", workContent, "不存在", "x")).toBeNull();
    expect(writeDiagnosisValue("projects", projectContent, "不存在", "x")).toBeNull();
  });

  it("非法 content 返回 null", () => {
    expect(writeDiagnosisValue("work", null, "w1", "x")).toBeNull();
    expect(writeDiagnosisValue("projects", { foo: 1 }, "p1", "x")).toBeNull();
  });

  it("只改命中那条，其余条目不动", () => {
    const next = writeDiagnosisValue("work", workContent, "w1", "新描述") as WorkItem[];
    expect(next[1]).toEqual(workContent[1]);
    expect(next[0]!.company).toBe("字节跳动");
  });

  it("不修改传入的数组", () => {
    const before = JSON.stringify(workContent);
    writeDiagnosisValue("work", workContent, "w1", "改了");
    expect(JSON.stringify(workContent)).toBe(before);
  });
});
