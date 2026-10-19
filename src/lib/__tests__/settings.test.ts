import { describe, it, expect } from "vitest";
import {
  maskApiKey,
  resolveIncomingApiKey,
  API_KEY_MASK_PREFIX,
  SETTINGS_FIELDS,
} from "../settings";
import {
  API_FORMAT_OPTIONS,
  type ApiFormat,
  VALID_API_FORMATS,
} from "../settings-constants";
import { parseHttpBaseUrl } from "../settings-request";

describe("settings.ts 安全脱敏与配置解析", () => {
  it("SETTINGS_FIELDS 完整覆盖大模型服务凭证与任务分工字段", () => {
    expect(SETTINGS_FIELDS).toContain("base_url");
    expect(SETTINGS_FIELDS).toContain("api_key");
    expect(SETTINGS_FIELDS).toContain("api_format");
    expect(SETTINGS_FIELDS).toContain("model_parse");
    expect(SETTINGS_FIELDS).toContain("model_summary");
    expect(SETTINGS_FIELDS).toContain("model_question");
    expect(SETTINGS_FIELDS).toContain("model_evaluate");
    expect(SETTINGS_FIELDS).toContain("max_output_tokens");
    expect(SETTINGS_FIELDS).toContain("ocr_mode");
  });

  it("resolveMaxOutputTokens 解析有效数字或回退为默认值 8192", async () => {
    const { resolveMaxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS } = await import("../settings");
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(8192);
    expect(resolveMaxOutputTokens("16384")).toBe(16384);
    expect(resolveMaxOutputTokens(4096)).toBe(4096);
    expect(resolveMaxOutputTokens("")).toBe(8192);
    expect(resolveMaxOutputTokens("invalid")).toBe(8192);
    expect(resolveMaxOutputTokens("8192junk")).toBe(8192);
    expect(resolveMaxOutputTokens("1.5")).toBe(8192);
    expect(resolveMaxOutputTokens("1e6")).toBe(8192);
    expect(resolveMaxOutputTokens(-10)).toBe(8192);
  });

  it("VALID_OCR_MODES 包含所有 OCR 模式定义", async () => {
    const { VALID_OCR_MODES, OCR_MODE_OPTIONS } = await import("../settings-constants");
    expect(VALID_OCR_MODES.has("auto")).toBe(true);
    expect(VALID_OCR_MODES.has("vision")).toBe(true);
    expect(VALID_OCR_MODES.has("local")).toBe(true);
    expect(VALID_OCR_MODES.has("off")).toBe(true);
    expect(OCR_MODE_OPTIONS.length).toBe(4);
  });

  it("maskApiKey 隐藏凭证主体，仅暴露安全前缀和后 4 位字符", () => {
    expect(maskApiKey("sk-proj-12345678abcdef")).toBe(`${API_KEY_MASK_PREFIX}cdef`);
    expect(maskApiKey("sk-1234")).toBe(`${API_KEY_MASK_PREFIX}1234`);
    expect(maskApiKey("")).toBe("");
  });

  it("resolveIncomingApiKey 识别脱敏占位符，保留服务端旧密钥防误覆盖", () => {
    const originalSavedKey = "sk-live-super-secret-key-9988";
    const maskedInput = `${API_KEY_MASK_PREFIX}9988`;

    // 用户未修改 API Key 直接保存时，前端回传带脱敏前缀的占位符，系统必须保留原密钥
    expect(resolveIncomingApiKey(maskedInput, originalSavedKey)).toBe(originalSavedKey);

    // 用户输入了全新的未脱敏 Key 时，系统应正确采纳新输入
    const newlyEnteredKey = "sk-new-brand-key-0000";
    expect(resolveIncomingApiKey(newlyEnteredKey, originalSavedKey)).toBe(newlyEnteredKey);

    // 用户清空 Key
    expect(resolveIncomingApiKey("", originalSavedKey)).toBe("");
  });

  it("VALID_API_FORMATS 包含所有支持的上游协议格式", () => {
    const validKeys: ApiFormat[] = ["openai_chat", "openai_responses", "anthropic_messages"];
    for (const key of validKeys) {
      expect(VALID_API_FORMATS.has(key)).toBe(true);
      const option = API_FORMAT_OPTIONS.find((opt) => opt.key === key);
      expect(option).toBeDefined();
      expect(option?.endpointPath).toBeTruthy();
      expect(option?.defaultBaseUrl).toBeTruthy();
    }
  });

  it.each(["https://model.invalid/v1", "http://127.0.0.1:11434/v1"])(
    "parseHttpBaseUrl 接受 HTTP(S)：%s",
    (value) => {
      expect(parseHttpBaseUrl(value).href).toBe(new URL(value).href);
    },
  );

  it.each(["file:///tmp/model", "ftp://model.invalid/v1", "not a URL"])(
    "parseHttpBaseUrl 拒绝非 HTTP(S) 或无效地址：%s",
    (value) => {
      expect(() => parseHttpBaseUrl(value)).toThrow("Base URL");
    },
  );
});
