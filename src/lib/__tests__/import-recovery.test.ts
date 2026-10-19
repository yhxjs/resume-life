import { beforeEach, describe, expect, it, vi } from "vitest";

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  chat,
}));

import { POST } from "@/app/api/import/parse/route";

function upload(text: string, extractOnly = false, filename = "resume.txt") {
  const form = new FormData();
  form.append("file", new File([text], filename, { type: "text/plain" }));
  if (extractOnly) form.append("extractOnly", "true");
  return new Request("http://localhost/api/import/parse", { method: "POST", body: form });
}

describe("文件导入恢复", () => {
  beforeEach(() => { chat.mockReset(); });

  it("先提取原文，不配置或调用模型也能保留手工草稿", async () => {
    const response = await POST(upload("合成姓名\n项目经历：开发测试工具", true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ extractedText: "合成姓名\n项目经历：开发测试工具" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("模型不可用时返回完整提取文本，包括模型输入上限以外的内容", async () => {
    const source = "简历内容".repeat(16000) + "原文末尾";
    chat.mockRejectedValue(new Error("模拟上游不可用"));
    const response = await POST(upload(source));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText === source).toBe(true);
  });

  it.each(["not json", "null", "[]", "{}", '{"title":"空草稿"}', '{"work":[{}]}'])("模型输出 %s 时保留原文并返回可恢复错误", async (raw) => {
    chat.mockResolvedValue(raw);
    const response = await POST(upload("完整的合成原文"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("完整的合成原文");
  });

  it.each([
    ["work", '{"work":[{}]}'],
    ["projects", '{"projects":[{}]}'],
    ["education", '{"education":[{}]}'],
    ["skills", '{"skills":{}}'],
    ["summary", '{"summary":{}}'],
    ["basic", '{"basic":{}}'],
  ])("模型只回了一个空的 %s 模块时不算有内容（归一化后的枚举字段不作数）", async (_type, raw) => {
    // normalizeContent 会补齐 id、descriptionItems 与 descriptionStyle: "unordered"
    // 等机器字段；"unordered" 是真值字符串，曾被 hasContent 当成用户内容，
    // 于是空草稿被当成功返回 200，用户拿不到保留原文的恢复路径。
    chat.mockResolvedValue(raw);
    const response = await POST(upload("完整的合成原文"));
    expect(response.status).toBe(502);
    expect((await response.json()).extractedText).toBe("完整的合成原文");
  });

  it("有真实内容时照常返回草稿（机器字段豁免不误伤正常解析）", async () => {
    chat.mockResolvedValue('{"work":[{"company":"合成公司"}]}');
    const response = await POST(upload("简历原文"));
    expect(response.status).toBe(200);
    expect((await response.json()).modules.work[0].company).toBe("合成公司");
  });

  it("文件提取本身失败时不调用模型且不伪造原文", async () => {
    const response = await POST(upload("无效文件", true, "resume.unsupported"));
    expect(response.status).toBe(400);
    expect((await response.json()).extractedText).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });

  it("正常解析保留结构化草稿，并把请求取消信号传递给模型", async () => {
    chat.mockResolvedValue(JSON.stringify({ title: "合成简历", basic: { name: "合成人物" } }));
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "合成简历", modules: { basic: { name: "合成人物" } } });
    expect(chat.mock.calls[0]![2]).toMatchObject({ signal: request.signal });
  });

  it("支持解析多行工作内容与项目描述（descriptionItems与换行拆分）", async () => {
    chat.mockResolvedValue(
      JSON.stringify({
        title: "高级工程师简历",
        work: [
          {
            company: "示例科技",
            title: "全栈开发",
            description: "负责业务架构设计\n完成性能优化降低首屏50%",
            descriptionItems: ["负责业务架构设计", "完成性能优化降低首屏50%"],
          },
        ],
        projects: [
          {
            name: "大型中台项目",
            role: "核心成员",
            descriptionItems: ["搭建微前端基座", "实现全链路埋点方案"],
          },
        ],
      })
    );
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modules.work[0].descriptionItems).toEqual([
      "负责业务架构设计",
      "完成性能优化降低首屏50%",
    ]);
    expect(data.modules.projects[0].descriptionItems).toEqual([
      "搭建微前端基座",
      "实现全链路埋点方案",
    ]);
  });

  it("支持解析工作和项目经历中的技术栈等自定义副项(subItems)", async () => {
    chat.mockResolvedValue(
      JSON.stringify({
        title: "后端开发简历",
        work: [
          {
            company: "某某互联网公司",
            title: "Java资深开发",
            subItems: [
              {
                label: "技术栈",
                value: "Spring Boot、Dubbo、MySQL、MyBatis-Plus、Kafka、Redis、XXL-JOB、WebSocket",
              },
            ],
            descriptionItems: ["主导核心中台重构", "优化高并发消息消费链路"],
          },
        ],
        projects: [
          {
            name: "分布式任务调度系统",
            role: "架构师",
            subItems: [
              {
                label: "技术栈",
                value: "Spring Cloud, Kafka, Redis",
              },
            ],
            descriptionItems: ["支撑百万级定时调度任务", "可用性达到99.99%"],
          },
        ],
      })
    );
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modules.work[0].subItems).toHaveLength(1);
    expect(data.modules.work[0].subItems[0].label).toBe("技术栈");
    expect(data.modules.work[0].subItems[0].value).toBe(
      "Spring Boot、Dubbo、MySQL、MyBatis-Plus、Kafka、Redis、XXL-JOB、WebSocket"
    );
    expect(data.modules.projects[0].subItems).toHaveLength(1);
    expect(data.modules.projects[0].subItems[0].label).toBe("技术栈");
    expect(data.modules.projects[0].subItems[0].value).toBe("Spring Cloud, Kafka, Redis");
  });

  it("保持完整事项的语意连贯性，避免将同一任务的上下文按句号机械拆分", async () => {
    const singleTaskText =
      "主导订单接入系统重构，基于模板方法统一校验与建单流程。引入分布式锁防止重复提交，并配套异步队列与补偿机制。";
    chat.mockResolvedValue(
      JSON.stringify({
        title: "后端开发简历",
        work: [
          {
            company: "某某科技公司",
            title: "资深开发",
            descriptionItems: [singleTaskText],
          },
        ],
      })
    );
    const request = upload("简历原文");
    const response = await POST(request);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.modules.work[0].descriptionItems).toHaveLength(1);
    expect(data.modules.work[0].descriptionItems[0]).toBe(singleTaskText);
  });
});
