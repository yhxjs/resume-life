import { expect, test } from "@playwright/test";

test("生产认证 API 的成功响应禁止缓存", async ({ request }) => {
  const response = await request.get("/api/resumes");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(Array.isArray(await response.json())).toBe(true);
});

test("生产认证 API 的未登录响应禁止缓存", async ({ playwright }) => {
  const anonymous = await playwright.request.newContext({
    baseURL: "http://127.0.0.1:3319", storageState: { cookies: [], origins: [] },
  });
  try {
    const response = await anonymous.get("/api/resumes");
    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toContain("no-store");
  } finally { await anonymous.dispose(); }
});
