import { getDb, inTransaction } from "./db";
import {
  VALID_API_FORMATS,
  type ApiFormat,
  VALID_OCR_MODES,
  type OcrMode,
  resolveMaxOutputTokens,
} from "./settings-constants";
import { normalizeProxyConfig, PROXY_PASSWORD_MASK_PREFIX, resolveIncomingProxyPassword } from "./proxy-config";
import { decryptSecret, encryptSecret, SettingsSecretError } from "./secret-store";
import { parseHttpBaseUrl } from "./model-base-url";

export * from "./settings-constants";

export const SETTINGS_FIELDS = [
  "base_url",
  "api_key",
  "api_format",
  "model_parse",
  "model_summary",
  "model_question",
  "model_evaluate",
  "max_output_tokens",
  "ocr_mode",
  "proxy_url",
  "proxy_username",
  "proxy_password",
] as const;

export type SettingsPayload = Record<(typeof SETTINGS_FIELDS)[number], string> & {
  proxy_enabled: boolean;
};

/** 脱敏占位前缀：GET 返回与 PUT 识别「保持旧值」都靠它 */
export const API_KEY_MASK_PREFIX = "•••";

/** 对外展示用：只保留末 4 位供辨认 */
export function maskApiKey(key: string): string {
  return key ? API_KEY_MASK_PREFIX + key.slice(-4) : "";
}

/** PUT 收到脱敏占位符时表示「未修改」，回退为库里的旧值 */
export function resolveIncomingApiKey(incoming: string, savedKey: string): string {
  return incoming.startsWith(API_KEY_MASK_PREFIX) ? savedKey : incoming;
}

/** 只有明确填写新凭证或清空时才容许替换失效旧值；脱敏占位符仍须读取旧值。 */
export function readSettings(replacements: Pick<Partial<SettingsPayload>, "api_key" | "proxy_password"> = {}): SettingsPayload {
  const result = {} as SettingsPayload;
  for (const f of SETTINGS_FIELDS) {
    result[f] = "";
  }
  result.api_format = "openai_chat";
  result.ocr_mode = "auto";
  result.max_output_tokens = "8192";
  result.proxy_enabled = false;

  const db = getDb();
  const row = db.prepare("SELECT * FROM settings WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  for (const f of SETTINGS_FIELDS) {
    if (row && (typeof row[f] === "string" || typeof row[f] === "number")) {
      if (f === "api_key" || f === "proxy_password") {
        try {
          result[f] = decryptSecret(row[f] as string);
        } catch (error) {
          const incoming = replacements[f];
          const maskPrefix = f === "api_key" ? API_KEY_MASK_PREFIX : PROXY_PASSWORD_MASK_PREFIX;
          if (!(error instanceof SettingsSecretError) || typeof incoming !== "string" || incoming.startsWith(maskPrefix)) throw error;
          result[f] = "";
        }
      } else {
        result[f] = String(row[f]);
      }
    }
  }
  result.max_output_tokens = String(resolveMaxOutputTokens(result.max_output_tokens));
  if (row && (row.proxy_enabled === 0 || row.proxy_enabled === 1)) {
    result.proxy_enabled = row.proxy_enabled === 1;
  }
  if (!VALID_API_FORMATS.has(result.api_format as ApiFormat)) {
    result.api_format = "openai_chat";
  }
  if (!VALID_OCR_MODES.has(result.ocr_mode as OcrMode)) {
    result.ocr_mode = "auto";
  }
  return result;
}

export function writeSettings(values: Partial<SettingsPayload>) {
  if (values.base_url) parseHttpBaseUrl(values.base_url);
  return inTransaction(() => {
    const db = getDb();
    const ts = new Date().toISOString();
    const saved = readSettings(values);
    const safeFormat: string = values.api_format && VALID_API_FORMATS.has(values.api_format as ApiFormat)
      ? values.api_format
      : "openai_chat";
    const safeOcrMode: string = values.ocr_mode && VALID_OCR_MODES.has(values.ocr_mode as OcrMode)
      ? values.ocr_mode
      : "auto";
    const proxyEnabled = values.proxy_enabled ?? saved.proxy_enabled;
    const incomingProxyPassword = values.proxy_password === undefined
      ? saved.proxy_password
      : resolveIncomingProxyPassword(values.proxy_password, saved.proxy_password);
    const normalizedProxy = normalizeProxyConfig({
      enabled: proxyEnabled,
      url: values.proxy_url ?? saved.proxy_url,
      username: values.proxy_username ?? saved.proxy_username,
      password: incomingProxyPassword,
    });
    const safeValues: SettingsPayload = {
      base_url: values.base_url ?? "",
      api_key: values.api_key ?? "",
      api_format: safeFormat,
      model_parse: values.model_parse ?? "",
      model_summary: values.model_summary ?? "",
      model_question: values.model_question ?? "",
      model_evaluate: values.model_evaluate ?? "",
      ocr_mode: safeOcrMode,
      max_output_tokens: String(resolveMaxOutputTokens(values.max_output_tokens ?? saved.max_output_tokens)),
      proxy_url: normalizedProxy.url,
      proxy_username: normalizedProxy.username,
      proxy_password: normalizedProxy.password,
      proxy_enabled: normalizedProxy.enabled,
    };
    safeValues.api_key = resolveIncomingApiKey(safeValues.api_key, saved.api_key);

    db.prepare(
      `INSERT INTO settings (id, ${SETTINGS_FIELDS.join(", ")}, proxy_enabled, updated_at)
       VALUES (1, ${SETTINGS_FIELDS.map(() => "?").join(", ")}, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ${SETTINGS_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")},
         proxy_enabled = excluded.proxy_enabled,
         updated_at = excluded.updated_at`
    ).run(
      ...SETTINGS_FIELDS.map((f) => f === "api_key" || f === "proxy_password"
        ? encryptSecret(safeValues[f])
        : safeValues[f]),
      safeValues.proxy_enabled ? 1 : 0,
      ts,
    );
  });
}

