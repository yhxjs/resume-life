import { describe, expect, it } from "vitest";
import { DuplicateModelJsonKeyError, parseModelJson } from "../model-json";

describe("parseModelJson", () => {
  it.each([
    '{"depth":8,"depth":2}',
    '{"depth":8,"depth":8}',
    '{"depth":8,"\\u0064epth":2}',
    '{"\\u0064epth":8,"depth":2}',
    '{"a":{"score":1,"score":9}}',
    '[{"score":1,"score":9}]',
    '{"a":[],"a":{}}',
    '{"":1,"":2}',
    '{"__proto__":1,"__proto__":2}',
    '{"constructor":1,"constructor":2}',
    '{"题":1,"\\u9898":2}',
    '{"😀":1,"\\ud83d\\ude00":2}',
    '{"a\\\"b":1,"a\\u0022b":2}',
    '{"a\\\\b":1,"a\\u005cb":2}',
  ])("拒绝同一对象中解码后重复的键：%s", raw => {
    expect(() => parseModelJson(raw)).toThrow(DuplicateModelJsonKeyError);
  });

  it.each([
    'null', 'true', '42', '-0', '"正文"', '[]', '{}',
    '[{"score":1},{"score":9}]',
    '{"a":{"score":1},"b":{"score":9}}',
    '{"score":1,"nested":{"score":9}}',
    '{"Depth":1,"depth":9}',
    '{"é":1,"e\\u0301":9}',
    '{"__proto__":{"x":1},"constructor":2}',
    ' \n{ "depth" \t\r\n : 8,"reference":"{\\\"depth\\\":1,\\\"depth\\\":2}"}\t ',
    '{"text":"\\\\\\\" } ] : \\n \\u0064epth","depth":8}',
  ])("合法 JSON 与原生解析结果一致：%s", raw => {
    expect(parseModelJson(raw)).toEqual(JSON.parse(raw));
  });

  it.each([
    '{"secret-canary":"private-output",}',
    '{"secret-canary":',
    '{"secret-canary":1} extra-private-output',
    '```json\n{"secret-canary":1}\n```',
  ])("拒绝非完整 JSON 且语法错误不泄漏模型正文：%s", raw => {
    let error: unknown;
    try { parseModelJson(raw); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).not.toBeInstanceOf(DuplicateModelJsonKeyError);
    expect((error as Error).message).toBe("模型输出不是有效 JSON");
  });

  it("重复字段错误不暴露敏感键名或正文", () => {
    let error: unknown;
    try { parseModelJson('{"private-key-canary":"private-output","private-key-canary":null}'); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DuplicateModelJsonKeyError);
    expect((error as Error).message).toBe("模型 JSON 对象包含重复字段");
    expect((error as Error).stack).not.toContain("private-key-canary");
    expect((error as Error).stack).not.toContain("private-output");
  });

  it("深层对象与数组迭代扫描，不增加递归调用栈限制", () => {
    const prefix = '[{"a":'.repeat(10_000);
    const suffix = '}]'.repeat(10_000);
    expect(() => parseModelJson(`${prefix}null${suffix}`)).not.toThrow();
    expect(() => parseModelJson(`${prefix}{"score":1,"score":2}${suffix}`)).toThrow(DuplicateModelJsonKeyError);
  });
});
