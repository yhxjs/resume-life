import { describe, expect, it } from "vitest";
import { safeLoginReturnPath } from "../login-return-path";

describe("登录回跳的真实 URL 语义", () => {
  it.each(["/\\audit.invalid", "//audit.invalid", "https://audit.invalid", "/\n/audit.invalid", "/%5caudit.invalid", "/%2f%2faudit.invalid"])("拒绝外站或含混路径 %s", (next) => {
    expect(safeLoginReturnPath(next, "http://127.0.0.1:3000")).toBe("/");
  });

  it("保留普通站内路径、查询和片段", () => {
    expect(safeLoginReturnPath("/resumes/1?tab=edit#basic", "http://127.0.0.1:3000"))
      .toBe("/resumes/1?tab=edit#basic");
  });
});
