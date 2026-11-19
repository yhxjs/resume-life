import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("题库 HTTP 边界：坏材料不写入，坏筛选不扩大，修正材料后仍可正常导入", async ({ request }) => {
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const root = "/api/bank";
  const direction = "E2E题库材料边界 <T> &amp;";
  const list = async () => {
    const response = await request.get(`${root}?${new URLSearchParams({ direction })}`);
    expect(response.status()).toBe(200);
    return response.json();
  };
  try {
    const seeded = await request.post(root, { data: { direction, kind: "tech", text: "已有原题 <T> &amp;" } });
    expect(seeded.status()).toBe(201);
    const before = await list();
    const badValues: unknown[] = [null, 0, true, [], ["behavior"], {}];
    for (const field of ["direction", "kind", "text"]) {
      for (const value of badValues) {
        const response = await request.post(root, { data: { direction, kind: "behavior", text: "不得新增的题目", [field]: value } });
        expect(response.status(), `${field}=${JSON.stringify(value)}`).toBe(400);
        expect(await response.json()).toEqual({ error: expect.any(String) });
      }
    }
    expect(await list()).toEqual(before);
    for (const kind of ["legacy", "TECH", "tech,behavior", "null"]) {
      const response = await request.get(`${root}?${new URLSearchParams({ direction, kind })}`);
      expect(response.status(), kind).toBe(400);
    }
    const question = "C++  <T> &amp; 100%_path\\file？";
    const valid = await request.post(root, { data: { direction: `  ${direction}  `, kind: "behavior", text: `  ${question}  \n${question}` } });
    expect(valid.status()).toBe(201);
    expect(await valid.json()).toEqual({ count: 1 });
    const filtered = await request.get(`${root}?${new URLSearchParams({ direction, kind: " behavior " })}`);
    expect(filtered.status()).toBe(200);
    const page = await filtered.json();
    expect(page).toEqual({ items: [expect.objectContaining({ direction, kind: "behavior", question })], nextCursor: null });
    expect((await list()).items).toEqual([page.items[0], ...before.items]);
    const compatible = await request.post(root, { data: { direction, kind: "legacy", text: "兼容默认题型" } });
    expect(compatible.status()).toBe(201);
    expect((await list()).items[0]).toMatchObject({ direction, kind: "tech", question: "兼容默认题型" });
  } finally {
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
