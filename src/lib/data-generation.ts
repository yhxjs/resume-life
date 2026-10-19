import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

export class DataGenerationConflictError extends Error {
  constructor() {
    super("数据已恢复，请刷新后重新操作");
    this.name = "DataGenerationConflictError";
  }
}

type GenerationScope = { read?: () => string | null; generation: string | null; invalidated?: boolean };
const scope = new AsyncLocalStorage<GenerationScope>();

/** 首次取库登记复核读函数；请求入口冻结的世代不能被覆盖。 */
export function trackDataGeneration(database: DatabaseSync): void {
  const current = scope.getStore();
  if (!current) return;
  if (!current.read) {
    const statement = database.prepare("SELECT data_generation FROM runtime_state WHERE id = 1");
    current.read = () => (statement.get() as { data_generation: string } | undefined)?.data_generation ?? null;
  }
  assertDataGeneration();
}

/** 不能只在 HTTP 返回时检查：模型返回与提交前都要检查，以免先写错数据再报告冲突。 */
export function assertDataGeneration(): void {
  const current = scope.getStore();
  if (!current?.read) return;
  if (current.invalidated || current.read() !== current.generation) {
    current.invalidated = true;
    throw new DataGenerationConflictError();
  }
}

export function withDataGenerationScope<T>(handler: () => T, generation: string | null): T {
  return scope.run({ generation }, handler);
}

/** 恢复端点是唯一获准替换世代的请求；其余并行请求仍保留各自旧世代。 */
export function withoutDataGenerationScope<T>(handler: () => T): T {
  return scope.exit(handler);
}
