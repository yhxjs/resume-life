import { promisify } from "util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepoScanPrompt, type RepoTarget } from "./prompts";
import { extractJson } from "@/lib/llm";
import { isGeneratedProjectSummary, normalizeSummary, type ProjectSummary } from "@/lib/summary";
import { collectRepoSourceSnapshot } from "./source-snapshot";
import { runCliPrompt, textOnlyCliArgs } from "./cli-process";

const { execFile } = process.getBuiltinModule("child_process");
const execFileAsync = promisify(execFile);

export type CliType = "codex" | "claude";
export interface CliAvailability { available: boolean; path?: string; version?: string }
export interface DetectedClis { codex: CliAvailability; claude: CliAvailability; recommended: CliType | null }

/** 探测本机 CLI；检测失败不等于扫描执行失败。 */
export async function detectInstalledClis(): Promise<DetectedClis> {
  const result: DetectedClis = { codex: { available: false }, claude: { available: false }, recommended: null };
  for (const cli of ["codex", "claude"] as const) {
    try {
      const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [cli], { timeout: 5000, maxBuffer: 16_384 });
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const chosen = cli === "codex" ? lines.find((line) => line.endsWith(".cmd")) || lines[0]
        : lines.find((line) => line.endsWith(".exe")) || lines[0];
      if (chosen) result[cli] = { available: true, path: chosen };
    } catch { /* 未安装或探测不可用 */ }
  }
  result.recommended = result.claude.available ? "claude" : result.codex.available ? "codex" : null;
  return result;
}

export interface RunScanOptions {
  repoPath?: string;
  repoPaths?: string[];
  targets?: RepoTarget[];
  projectName: string;
  preferredCli?: "auto" | CliType;
  signal?: AbortSignal;
  onDelta?: (text: string, log?: string) => void;
}

export interface ScanResult { summary: ProjectSummary; cliUsed: CliType; rawOutput: string; logs: string[] }

const activeScans = new Set<string>();

/** 用受限源码材料进行文本分析，CLI 工作目录不含原仓库或其配置。 */
export async function runRepoScan(options: RunScanOptions): Promise<ScanResult> {
  const { projectName, preferredCli = "auto", signal, onDelta } = options;
  signal?.throwIfAborted();
  const paths = options.repoPaths?.length ? options.repoPaths : options.repoPath ? [options.repoPath] : [];
  if (!paths.length || !paths[0]) throw new Error("必须提供至少一个有效的本地代码仓库路径");
  const key = paths.map((value) => path.resolve(value)).sort().join("\0");
  if (activeScans.has(key)) throw new Error("该仓库扫描正在进行，请等待完成");
  if (activeScans.size >= 2) throw new Error("本机扫描繁忙，请等待当前任务完成");
  activeScans.add(key);
  let workdir: string | undefined;
  try {
    const clis = await detectInstalledClis();
    const chosen = preferredCli === "auto" ? clis.recommended : preferredCli;
    if (!chosen || !clis[chosen].available || !clis[chosen].path) throw new Error("本机未检测到指定 CLI，请先安装配置");
    const targets = options.targets?.length ? options.targets : paths.map((value) => ({ path: value }));
    const source = await collectRepoSourceSnapshot(targets, signal);
    const logs: string[] = [];
    const addLog = (value: string, delta?: string) => {
      const log = value.slice(0, 240);
      if (logs.length === 200) logs.shift();
      logs.push(log);
      onDelta?.(delta || log, log);
    };
    addLog(`[引擎选择] 使用 ${chosen === "claude" ? "Claude Code CLI" : "Codex CLI"} 分析受限源码材料`);
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-life-cli-"));
    const stdout = await runCliPrompt({
      command: clis[chosen].path!, args: textOnlyCliArgs(chosen), cwd: workdir,
      prompt: buildRepoScanPrompt(projectName, targets, source), timeoutMs: 5 * 60 * 1000, signal,
      onOutput(text, stderr) {
        for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(stderr ? -2 : -3)) {
          if (!line.startsWith("{") && !line.startsWith("}")) addLog(`[${stderr ? "提示" : "输出"}] ${line.slice(0, 80)}`, line.slice(0, 80));
        }
      },
    });
    const parsed = extractJson<unknown>(stdout);
    if (!isGeneratedProjectSummary(parsed)) throw new Error("CLI 输出未能生成有效的五维项目总结 JSON 格式");
    addLog("[完成] 五维 STAR 亮点总结提取成功");
    return { summary: normalizeSummary(parsed), cliUsed: chosen, rawOutput: stdout, logs };
  } finally {
    activeScans.delete(key);
    if (workdir) {
      if (path.dirname(workdir) !== os.tmpdir() || !path.basename(workdir).startsWith("resume-life-cli-")) throw new Error("CLI 临时目录边界无效");
      await fs.rm(workdir, { recursive: true, force: true });
    }
  }
}
