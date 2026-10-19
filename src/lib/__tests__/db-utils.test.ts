import { describe, it, expect } from "vitest";
import { escapeLike, now } from "../db";
import { rollbackIgnoringAutoRollback } from "../db-schema";

describe("db.ts 基础工具函数", () => {
  it("escapeLike 转义 % _ 和 \\ 通配符，防范 SQL LIKE 注入", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("user_name")).toBe("user\\_name");
    expect(escapeLike("c:\\test\\path")).toBe("c:\\\\test\\\\path");
    expect(escapeLike("normal text")).toBe("normal text");
    expect(escapeLike("a".repeat(150)).length).toBe(150);
  });

  it("now 返回标准 ISO 格式时间戳字符串", () => {
    const timestamp = now();
    expect(typeof timestamp).toBe("string");
    expect(new Date(timestamp).toString()).not.toBe("Invalid Date");
  });

  it("回滚失败时保留原始错误，而不是被 ROLLBACK 的异常替换", () => {
    // SQLITE_FULL/IOERR 下 SQLite 已自动回滚，再执行 ROLLBACK 会抛 no-transaction-active；
    // 原始错误（如 ENOSPC）必须原样向上传播，回滚异常只挂到原错误上。
    const database = { exec: (statement: string) => {
      if (statement === "ROLLBACK") throw new Error("cannot rollback - no transaction is active");
    } };
    const original = new Error("disk I/O error");
    expect(() => rollbackIgnoringAutoRollback(database, original)).not.toThrow();
    expect(original.message).toBe("disk I/O error");
    expect((original as Error & { rollbackError?: unknown }).rollbackError).toBeInstanceOf(Error);
  });
});
