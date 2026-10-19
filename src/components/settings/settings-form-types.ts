import type { ApiFormat, OcrMode } from "@/lib/settings-constants";

export type Settings = {
  base_url: string;
  api_key: string;
  api_format: ApiFormat;
  model_parse: string;
  model_summary: string;
  model_question: string;
  model_evaluate: string;
  max_output_tokens: string;
  ocr_mode: OcrMode;
  proxy_enabled: boolean;
  proxy_url: string;
  proxy_username: string;
  proxy_password: string;
};

export type ProxyCandidate = {
  url: string;
  protocol: "http" | "https" | "socks5";
  source: "environment" | "windows" | "localhost";
  username?: string;
};

export type SettingsFieldSetter = (key: Exclude<keyof Settings, "proxy_enabled">, value: string) => void;

export type SettingsFeedback = { kind: "ok" | "err" | "info"; text: string };
