import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliPrompt } from "../repo-scanner/cli-process";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-native-cli-")); });
afterEach(() => {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-native-cli-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("真实无害 CLI 进程边界", () => {
  it.skipIf(process.platform !== "win32")("cmd 正确处理带空格与 & 的可执行路径，cwd 不被当作命令", async () => {
    const unusual = path.join(directory, "repo&echo.AUDIT_CMD_MARKER space");
    fs.mkdirSync(unusual);
    const command = path.join(unusual, "stub.cmd");
    fs.writeFileSync(command, "@echo off\r\necho SAFE_RESULT\r\n");
    const result = await runCliPrompt({ command, args: ["fixed-flag"], cwd: unusual, prompt: "synthetic", timeoutMs: 5000 });
    expect(result.trim()).toBe("SAFE_RESULT");
    expect(result).not.toContain("AUDIT_CMD_MARKER");
  });

  it("取消会真正结束本机子进程，并释放下一次调用的名额", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const task = runCliPrompt({ command: process.execPath,
      args: ["-e", "process.stdout.write('READY');setInterval(()=>{},1000)"], cwd: directory,
      prompt: "", timeoutMs: 5000, signal: controller.signal, onOutput: () => ready() });
    const rejected = expect(task).rejects.toThrow(/取消/);
    await started;
    controller.abort();
    await rejected;
    expect(await runCliPrompt({ command: process.execPath, args: ["-e", "process.stdout.write('ok')"],
      cwd: directory, prompt: "", timeoutMs: 5000 })).toBe("ok");
  });

  it.skipIf(process.platform !== "win32")("Windows 取消同时结束真实父子进程", async () => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<{ parent: number; descendant: number }>();
    let output = "";
    const code = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});child.once('spawn',()=>process.stdout.write(JSON.stringify({parent:process.pid,descendant:child.pid})+'\\n'));setInterval(()=>{},1000)";
    const task = runCliPrompt({ command: process.execPath, args: ["-e", code], cwd: directory,
      prompt: "", timeoutMs: 5000, signal: controller.signal, onOutput: (text) => {
        output += text;
        if (output.includes("\n")) ready.resolve(JSON.parse(output.trim()));
      } });
    const rejected = expect(task).rejects.toThrow(/取消/);
    const pids = await ready.promise;
    controller.abort();
    await rejected;
    for (const pid of [pids.parent, pids.descendant]) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });
});
