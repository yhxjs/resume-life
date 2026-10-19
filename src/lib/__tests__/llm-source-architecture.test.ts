import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_TYPES, LLM_FEATURES } from "../llm-source";

const SRC = path.join(process.cwd(), "src");

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (/\.tsx?$/u.test(entry.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** 只剥离注释（不处理字符串字面量）后的源码，避免把注释里的示例当成真实调用点 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
}

describe("LLM 来源架构守卫", () => {
  it("每个生产调用点都传了 source（含 feature 的对象字面量）", () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      if (file.endsWith(path.join("lib", "safe-llm.ts"))) continue;
      if (file.endsWith(path.join("lib", "llm.ts"))) continue;
      const raw = fs.readFileSync(file, "utf8");
      const code = codeOf(raw);
      const callPattern = /\bsafe(?:Chat|ChatStream)\s*\(/gu;
      // 先收集去注释文本中的全部调用位置
      const positions: number[] = [];
      for (const match of code.matchAll(callPattern)) positions.push(match.index ?? 0);
      // 去注释后位置会漂移，故在原始源码上以同一正则重新匹配来取行号（匹配顺序一致、数量相同）
      const rawPositions: number[] = [];
      for (const match of raw.matchAll(callPattern)) rawPositions.push(match.index ?? 0);
      positions.forEach((start, i) => {
        // 每个窗口止于下一个调用点之前，避免相邻调用互相洗白
        const end = i + 1 < positions.length ? positions[i + 1] : code.length;
        const args = code.slice(start, end);
        if (!args.includes("feature:")) {
          const rawIndex = rawPositions[i] ?? start;
          offenders.push(`${path.relative(process.cwd(), file)}:${raw.slice(0, rawIndex).split("\n").length}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("LLM_FEATURES 覆盖全部 32 个功能（含连接测试），且取值唯一", () => {
    const labels = Object.values(LLM_FEATURES);
    expect(labels).toHaveLength(32);
    expect(new Set(labels).size).toBe(32);
    expect(labels).toContain("模型连接测试");
  });

  it("每个 EntityType 都在标题注册表中有条目", () => {
    expect(ENTITY_TYPES).toHaveLength(13);
    const registry = fs.readFileSync(path.join(SRC, "lib", "llm-entity-label.ts"), "utf8");
    for (const type of ENTITY_TYPES) {
      expect(registry, `注册表缺少 ${type}`).toMatch(new RegExp(`^\\s*${type}:`, "mu"));
    }
  });

  it("客户端可安全导入 llm-usage-range 与 llm-source（不含 node:sqlite）", () => {
    for (const file of ["llm-usage-range.ts", "llm-source.ts"]) {
      const source = fs.readFileSync(path.join(SRC, "lib", file), "utf8");
      expect(source, `${file} 不得依赖数据库`).not.toMatch(/node:sqlite|from "\.\/db"|from "@\/lib\/db"/u);
    }
  });
});
