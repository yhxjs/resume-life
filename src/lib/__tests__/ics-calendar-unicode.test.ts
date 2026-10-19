import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, it } from "vitest";

it("ICS 折行处理合法替换字符与多字节边界时必须前进并保持原文", async () => {
  const source = transpileModule(readFileSync(new URL("../ics-calendar.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const inputs = [
    "\uFFFD".repeat(26),
    "DESCRIPTION:" + "\uFFFD".repeat(80),
    "a".repeat(74) + "😀中文\uFFFD".repeat(30),
    "a".repeat(75),
    "中".repeat(25) + "😀",
  ];
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const exports = {};
    ${source}
    parentPort.postMessage("ready");
    parentPort.postMessage(workerData.map((line) => exports.foldIcsLine(line)));
  `, { eval: true, workerData: inputs });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outputs = await new Promise<string[]>((resolve, reject) => {
      worker.on("message", (value: "ready" | string[]) => {
        if (value === "ready") timer = setTimeout(() => reject(new Error("ICS 折行未在时限内完成")), 250);
        else resolve(value);
      });
      worker.once("error", reject);
    });
    for (const [index, output] of outputs.entries()) {
      const lines = output.split("\r\n");
      expect(lines[0]! + lines.slice(1).map((line) => line.slice(1)).join("")).toBe(inputs[index]);
      for (const line of lines) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
      for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
    }
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
