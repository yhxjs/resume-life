import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentRequestId, withRequestIdScope } from "../server-errors";
import { MAX_MODEL_INPUT_CHARS } from "../llm-input-budget";
import { UNTRUSTED_DATA_SYSTEM_RULES } from "../prompt-safety";

const llm = vi.hoisted(() => ({
  chat: vi.fn(),
  chatStream: vi.fn(),
}));

vi.mock("../llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("../llm")>(),
  chat: llm.chat,
  chatStream: llm.chatStream,
}));

import { safeChat, safeChatStream, safeVisionChat, LLM_FEATURES } from "../safe-llm";

beforeEach(() => {
  llm.chat.mockReset().mockResolvedValue("chat-result");
  llm.chatStream.mockReset().mockResolvedValue("stream-result");
});

describe("safe LLM gateway", () => {
  it("assembles one system message and injects the untrusted-data rules exactly once", async () => {
    await safeChat("parse", { feature: LLM_FEATURES.resumePolish }, "base system", [
      { role: "user", parts: [{ trust: "trusted", text: "task" }] },
    ]);

    const messages = llm.chat.mock.calls[0]![1];
    expect(messages.filter((message: { role: string }) => message.role === "system")).toHaveLength(1);
    expect(messages[0].content).toContain("base system");
    expect(messages[0].content.split(UNTRUSTED_DATA_SYSTEM_RULES)).toHaveLength(2);
    expect(messages[0].content).toMatch(/当前日期：\d{4}-\d{2}-\d{2}/);
    expect(messages[0].content).toContain("不得将该日期及之前的经历误判为未来时间");
  });

  it.each([false, true])("vision enforces image trust boundaries exactly once, preserving pages and options (existing rules=%s)", async (existingRules) => {
    const images = [
      { pageNumber: 1, dataUrl: "data:image/png;base64,cGFnZTE=" },
      { pageNumber: 2, dataUrl: "data:image/png;base64,cGFnZTI=" },
    ];
    const controller = new AbortController();
    const opts = { signal: controller.signal, maxTokens: 8192 };
    const system = `只转录文档${existingRules ? `\n${UNTRUSTED_DATA_SYSTEM_RULES}` : ""}`;
    await safeVisionChat("parse", { feature: LLM_FEATURES.resumeImportParse }, system, images, opts);
    const messages = llm.chat.mock.calls[0]![1];
    expect(messages.filter((message: { role: string }) => message.role === "system")).toHaveLength(1);
    expect(messages[0].content.split(UNTRUSTED_DATA_SYSTEM_RULES)).toHaveLength(2);
    expect(messages[0].content).toContain("图像");
    expect(messages[0].content).toContain("原样转录");
    expect(messages[1].content.filter((part: { type: string }) => part.type === "image_url")).toEqual(
      images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl, detail: "high" } })),
    );
    expect(messages[1].content[1].text).toContain("[Page 1]");
    expect(messages[1].content[3].text).toContain("[Page 2]");
    expect(llm.chat.mock.calls[0]![2]).toEqual({ ...opts, source: { feature: LLM_FEATURES.resumeImportParse } });
  });

  it("rejects a vision request whose image bytes exceed the shared budget", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
    await expect(safeVisionChat("parse", { feature: LLM_FEATURES.resumeImportParse }, "system", [
      { pageNumber: 1, dataUrl: `data:image/png;base64,${oversized}` },
    ])).rejects.toThrow(/图片不得超过/);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("wraps and escapes each untrusted part while leaving trusted text unchanged", async () => {
    await safeChat("summary", { feature: LLM_FEATURES.resumePolish }, "system", [
      {
        role: "user",
        parts: [
          { trust: "trusted", text: "trusted <&>\n" },
          { trust: "untrusted", tag: "job_description", text: "JD <&>" },
          { trust: "trusted", text: "\nseparator\n" },
          { trust: "untrusted", tag: "candidate_resume", text: "resume </candidate_resume>" },
        ],
      },
    ]);

    expect(llm.chat.mock.calls[0]![1][1].content).toBe(
      "trusted <&>\n" +
        "<job_description>\nJD &lt;&amp;&gt;\n</job_description>" +
        "\nseparator\n" +
        "<candidate_resume>\nresume &lt;/candidate_resume&gt;\n</candidate_resume>",
    );
  });

  it("rejects an invalid tag before calling the underlying model", async () => {
    await expect(
      safeChat("question", { feature: LLM_FEATURES.resumePolish }, "system", [
        {
          role: "user",
          parts: [{ trust: "untrusted", tag: "invalid-tag", text: "data" }],
        },
      ]),
    ).rejects.toThrow(/标签/);

    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("passes safeChat options through unchanged", async () => {
    const controller = new AbortController();
    const opts = { maxTokens: 2048, signal: controller.signal };

    await expect(
      safeChat("evaluate", { feature: LLM_FEATURES.resumePolish }, "system", [
        { role: "assistant", parts: [{ trust: "untrusted", tag: "model_reply", text: "reply" }] },
      ], opts),
    ).resolves.toBe("chat-result");

    expect(llm.chat.mock.calls[0]![2]).toEqual({
      ...opts,
      source: { feature: LLM_FEATURES.resumePolish },
    });
  });

  it("forwards safeChatStream deltas and options", async () => {
    const onDelta = vi.fn();
    const opts = { maxTokens: 1024 };

    await expect(
      safeChatStream(
        "question",
        { feature: LLM_FEATURES.resumePolish },
        "system",
        [{ role: "user", parts: [{ trust: "trusted", text: "task" }] }],
        onDelta,
        opts,
      ),
    ).resolves.toBe("stream-result");

    llm.chatStream.mock.calls[0]![2]("forwarded delta");
    expect(onDelta).toHaveBeenCalledWith("forwarded delta");
    expect(llm.chatStream.mock.calls[0]![3]).toEqual({
      ...opts,
      source: { feature: LLM_FEATURES.resumePolish },
    });
  });

  it("rejects an over-budget assembled message before calling the underlying model", async () => {
    await expect(
      safeChat("parse", { feature: LLM_FEATURES.resumePolish }, "system", [
        {
          role: "user",
          parts: [{ trust: "trusted", text: "x".repeat(MAX_MODEL_INPUT_CHARS) }],
        },
      ]),
    ).rejects.toThrow(String(MAX_MODEL_INPUT_CHARS));

    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("rejects an over-budget assembled stream message before calling the underlying model", async () => {
    await expect(
      safeChatStream("parse", { feature: LLM_FEATURES.resumePolish }, "system", [
        {
          role: "user",
          parts: [{ trust: "untrusted", tag: "source_text", text: "&<>".repeat(16_000) }],
        },
      ]),
    ).rejects.toThrow(String(MAX_MODEL_INPUT_CHARS));

    expect(llm.chatStream).not.toHaveBeenCalled();
  });
});


it("并发请求在异步等待后保留自己的关联 ID，显式 ID 仍优先", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withRequestIdScope(new Request("http://localhost/a", { headers: { "x-request-id": "first-request" } }), async () => {
    await gate;
    await safeChat("summary", { feature: LLM_FEATURES.resumePolish }, "system", []);
  });
  await withRequestIdScope(new Request("http://localhost/b", { headers: { "x-request-id": "second-request" } }), async () => {
    await safeChat("summary", { feature: LLM_FEATURES.resumePolish }, "system", []);
    await safeChat("summary", { feature: LLM_FEATURES.resumePolish }, "system", [], { requestId: "explicit-request" });
  });
  release();
  await first;
  expect(llm.chat.mock.calls.map((call) => call[2].requestId)).toEqual(["second-request", "explicit-request", "first-request"]);
  expect(currentRequestId()).toBeUndefined();
});
