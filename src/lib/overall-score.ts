import { getDb } from "./db";
import type { DatabaseSync } from "node:sqlite";
import { DIMENSIONS, overallOf, safeScores, type ScoreMap } from "./scores";

const registered = new WeakSet<DatabaseSync>();

/**
 * 历史综合评分：跨「题目练习作答」与「模拟面试作答」两表取均分。
 * 读取失败返回 null，调用方据此降级（首页要能照常渲染并给出排障指引）。
 *
 * 与 `scores.ts` 分开是有原因的：这里 import 了 `getDb`，而 `scores.ts` 里其余
 * 全是纯函数，被九个客户端组件（练习详情、复盘、笔记本、诊断弹窗……）当作值导入。
 * 两者同处一个模块时，客户端打包会顺着 `scores.ts` 一路走到 `node:sqlite`，
 * `next build` 直接以 TurbopackInternalError 失败。凡是碰数据库的读取都留在本文件。
 */
export function getOverallScore(): number | null {
  try {
    const db = getDb();
    if (!registered.has(db)) {
      db.aggregate<string>("resume_life_overall_score", {
        start: () => JSON.stringify({ count: 0, sums: { depth: 0, structure: 0, authenticity: 0, completeness: 0 } as ScoreMap }),
        step: (state, value) => {
          const scores = typeof value === "string" ? safeScores(value) : null;
          if (!scores) return state;
          const aggregate = JSON.parse(state) as { count: number; sums: ScoreMap };
          aggregate.count += 1;
          for (const dimension of DIMENSIONS) aggregate.sums[dimension.key] += scores[dimension.key];
          return JSON.stringify(aggregate);
        },
        result: (state) => {
          const aggregate = JSON.parse(state) as { count: number; sums: ScoreMap };
          if (aggregate.count === 0) return null;
          const average = {} as ScoreMap;
          for (const dimension of DIMENSIONS) {
            average[dimension.key] = Math.round((aggregate.sums[dimension.key] / aggregate.count) * 10) / 10;
          }
          return overallOf(average);
        },
      });
      registered.add(db);
    }
    const row = db.prepare(
      `SELECT resume_life_overall_score(scores) AS total FROM (
         SELECT scores FROM drill_questions WHERE scores != '' AND answered_at != ''
         UNION ALL
         SELECT scores FROM interview_turns WHERE scores != '' AND answered_at != ''
       )`,
    ).get() as { total: number | null };
    return row.total;
  } catch {
    return null;
  }
}
