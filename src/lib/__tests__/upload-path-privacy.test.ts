import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "../../proxy";

describe("上传路径隐私边界", () => {
  it("公开上传目录始终拒绝访问且不重写到私有 API", () => {
    expect(config.matcher).toEqual(["/((?!_next/|favicon.ico|logo.png|icon.png).*)"]);
    const response = proxy(new NextRequest("http://localhost/uploads/avatar.png"));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("私有 API 和阻断路径都拒绝非法 Host", () => {
    for (const pathname of ["/api/uploads/avatar.png", "/uploads/avatar.png"]) {
      const response = proxy(new NextRequest(`http://localhost${pathname}`, { headers: { host: "attacker.invalid" } }));
      expect(response.status).toBe(403);
    }
  });
});
