import { parseCustomCliConfig, type CustomCliConfig } from "./repo-scanner/cli-config";

export const CUSTOM_CLI_PROFILES_KEY = "resume_life_custom_cli_profiles";
export const MAX_CUSTOM_CLI_PROFILES = 20;
export interface CustomCliProfile extends CustomCliConfig { id: string; name: string }

/** 客户端命令是当前浏览器的机器偏好，不与项目资料一起备份或恢复。 */
export function loadCustomCliProfiles(): CustomCliProfile[] {
  try {
    const raw = localStorage.getItem(CUSTOM_CLI_PROFILES_KEY);
    if (!raw || raw.length > 1_000_000) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const profiles: CustomCliProfile[] = [];
    for (const value of parsed.slice(0, MAX_CUSTOM_CLI_PROFILES)) {
      if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id || value.id.length > 100 ||
          typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || profiles.some(profile => profile.id === value.id)) continue;
      try { profiles.push({ id: value.id, name: value.name.trim(), ...parseCustomCliConfig(value) }); }
      catch { /* 损坏配置不回填到命令输入框。 */ }
    }
    return profiles;
  } catch { return []; }
}

export function saveCustomCliProfiles(profiles: CustomCliProfile[]): void {
  if (profiles.length > MAX_CUSTOM_CLI_PROFILES) throw new Error(`最多保存 ${MAX_CUSTOM_CLI_PROFILES} 个客户端`);
  if (profiles.length) localStorage.setItem(CUSTOM_CLI_PROFILES_KEY, JSON.stringify(profiles));
  else localStorage.removeItem(CUSTOM_CLI_PROFILES_KEY);
}
