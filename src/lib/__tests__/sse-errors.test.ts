import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseResponse } from "../sse";

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSseResponse 的异常兜底", () => {
  it("handler 抛错时落 server-error 日志，并向客户端发含 requestId 的通用文案", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = createSseResponse(async () => {
      throw new Error("SQLITE_FULL: database or disk is full");
    });

    const text = await readAll(response);

    expect(text).toContain("event: error");
    expect(text).toMatch(/服务端处理失败（[A-Za-z0-9._:-]{1,128}）/);
    expect(text).not.toContain("SQLITE_FULL");

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[server-error]");
    expect(logged).toContain("sse.handler");
  });

  it("handler 正常结束时不受影响", async () => {
    const response = createSseResponse(async (emitter) => {
      emitter.sendDelta("hi");
      emitter.sendDone({ ok: true });
    });

    const text = await readAll(response);
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
  });

  it("传入的 requestId 同时出现在日志与错误事件里，客户端拿到的 ID 可被搜到", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = createSseResponse(async () => {
      throw new Error("SQLITE_FULL: database or disk is full");
    }, "client-supplied-id-42");

    const text = await readAll(response);

    expect(text).toContain("服务端处理失败（client-supplied-id-42）");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("client-supplied-id-42");
  });

  it("不传 requestId 时仍然发一个可搜的 ID（回退到自动生成）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = createSseResponse(async () => {
      throw new Error("synthetic failure");
    });

    const text = await readAll(response);
    const emitted = text.match(/服务端处理失败（([A-Za-z0-9._:-]{1,128})）/);

    expect(emitted).not.toBeNull();
  });
});
