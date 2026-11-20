/** 可供浏览器与服务端共用的 CLI 配置；不包含进程或文件系统依赖。 */
export type BuiltinCliType = "codex" | "claude";
export type CliType = BuiltinCliType | "custom";
export type PreferredCli = "auto" | CliType;

export interface CustomCliConfig {
  command: string;
  args: string[];
}

export class CliConfigError extends Error {}

/** 执行与界面预览共用参数，避免预览遗漏或漂移。 */
export function textOnlyCliArgs(cli: BuiltinCliType): string[] {
  return cli === "claude"
    ? ["-p", "--output-format", "text", "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]
    : ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "hooks",
      "--disable", "apps", "--disable", "plugins",
      "-c", "web_search='disabled'", "-c", "default_permissions='resume_life_scan'",
      "-c", "permissions.resume_life_scan.filesystem={':minimal'='read',':workspace_roots'='read'}"];
}

/** 参数按字符串引用展示；预览不是 shell 脚本，也不参与实际执行。 */
export function formatCliCommandPreview(config: CustomCliConfig): string {
  const displayArg = (arg: string) => {
    if (/^[\w./:\\=+-]+$/.test(arg)) return arg;
    // 保留 Windows 路径的可读性；仅转义引号边界，避免把路径显示成 JSON 的双反斜线。
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  };
  return `${[config.command, ...config.args].map(displayArg).join(" ")}\nstdin: {{PROMPT}}`;
}

export function parseCustomCliArgs(text: string): unknown {
  if (!text.trim()) return [];
  try { return JSON.parse(text); }
  catch { throw new CliConfigError('命令参数须为 JSON 字符串数组，例如 ["--mode", "text"]'); }
}

export function parseCustomCliConfig(value: unknown): CustomCliConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliConfigError("请填写自定义 CLI / SDK 命令配置");
  }
  const { command, args = [] } = value as Record<string, unknown>;
  if (typeof command !== "string" || !command.trim() || command.length > 2048 || /[\u0000-\u001f\u007f"]/u.test(command)) {
    throw new CliConfigError("可执行程序须为有效的命令名称或绝对路径，不要添加外层引号");
  }
  const executable = command.trim();
  // 不拆分 shell 命令行；路径中的空格保留，参数必须独立填写。
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(executable) && !/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(executable)) {
    throw new CliConfigError("请只填写可执行程序名称或绝对路径，将参数填入参数数组");
  }
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== "string" || arg.length > 4096 || /[\u0000-\u001f\u007f]/u.test(arg))) {
    throw new CliConfigError("命令参数须为最多 64 项的字符串数组，每项不超过 4096 字符且不含控制字符");
  }
  if (args.reduce((length, arg) => length + arg.length, executable.length) > 16_384) {
    throw new CliConfigError("自定义 CLI 命令和参数总长度不能超过 16384 字符");
  }
  if (/\.(cmd|bat)$/i.test(executable)) validateWindowsBatchCommand(executable, args);
  return { command: executable, args: [...args] };
}

/** cmd.exe 仅接受静态配置参数；提示词与仓库内容永远不进入这里。 */
export function validateWindowsBatchCommand(command: string, args: readonly string[]): void {
  if (/[%"\r\n\0]/.test(command) || args.some(arg => /[%"\r\n\0]/.test(arg))) {
    throw new CliConfigError("CLI 批处理命令包含不能安全引用的字符；请改用原生程序或通过 node / python 的绝对脚本路径调用 SDK");
  }
  // 批处理转发到原生程序时，末尾反斜杠可能转义闭合引号或被折半；无法统一保证原样传递。
  if (args.some(arg => arg.endsWith("\\"))) {
    throw new CliConfigError("CLI 批处理参数不能以反斜杠结尾；目录可使用正斜杠，或改用原生程序、node / python 直接运行 SDK 脚本");
  }
  if ([command, ...args].reduce((length, arg) => length + arg.length + 3, 2) > 8000) {
    throw new CliConfigError("CLI 批处理命令过长，请缩短固定参数或改用原生程序");
  }
}

export function parseCliSelection(preferredCli: unknown = "auto", customCli?: unknown): {
  preferredCli: PreferredCli; customCli?: CustomCliConfig;
} {
  if (preferredCli !== "auto" && preferredCli !== "codex" && preferredCli !== "claude" && preferredCli !== "custom") {
    throw new CliConfigError("preferredCli 必须是 auto、codex、claude 或 custom");
  }
  if (preferredCli === "custom") return { preferredCli, customCli: parseCustomCliConfig(customCli) };
  if (customCli !== undefined) throw new CliConfigError("自定义命令须选择 custom 客户端后使用");
  return { preferredCli };
}
