"use client";

import { errorMessage } from "@/lib/error-message";
import { formatCliCommandPreview, parseCustomCliArgs, parseCustomCliConfig, textOnlyCliArgs, type BuiltinCliType, type PreferredCli } from "@/lib/repo-scanner/cli-config";

export function CliCommandPreview({ selected, detected, detecting, custom }: {
  selected: PreferredCli;
  detected: {
    codex: { available: boolean; path?: string };
    claude: { available: boolean; path?: string };
    recommended: BuiltinCliType | null;
  } | null;
  detecting: boolean;
  custom: { command: string; argsText: string };
}) {
  let command = "";
  let message = "";
  if (selected === "custom") {
    if (!custom.command.trim()) message = "填写可执行程序和参数后显示最终命令。";
    else {
      try {
        command = formatCliCommandPreview(parseCustomCliConfig({ command: custom.command, args: parseCustomCliArgs(custom.argsText) }));
      } catch (error) { message = `暂无法生成预览：${errorMessage(error)}`; }
    }
  } else {
    const cli = selected === "auto" ? detected?.recommended : selected;
    if (cli) command = formatCliCommandPreview({ command: detected?.[cli].path || cli, args: textOnlyCliArgs(cli) });
    else message = detecting ? "正在检测可用客户端，完成后显示推荐命令。" : "暂无可用的推荐客户端，可选择自定义 CLI / SDK。";
  }

  return <section aria-label="最终命令预览" className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
    <div className="text-xs font-medium text-ink">最终命令预览</div>
    {command ? <>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-card p-2.5 font-mono text-xs text-ink"><code>{command}</code></pre>
      <p className="text-[11px] text-muted">{"{{PROMPT}} 为提示词占位符，通过标准输入（stdin）传入。引号用于区分参数，预览仅展示调用结构。"}</p>
    </> : <p className="text-xs text-muted">{message}</p>}
  </section>;
}
