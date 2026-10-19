import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

test("连接测试进行中禁止重复请求，完成后可再次测试", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/settings", (route) => route.fulfill({ json: {
    base_url: "https://synthetic.invalid/v1", api_key: "", api_format: "openai_chat",
    model_parse: "synthetic-model", model_summary: "", model_question: "", model_evaluate: "",
    ocr_mode: "auto", proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "",
  } }));
  let requests = 0;
  let release: (() => void) | undefined;
  await page.route("**/api/settings/test", async (route) => {
    requests += 1;
    if (requests === 1) await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { ok: true, reply: "synthetic-ok" } });
  });
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "测试连接", exact: true });
  await button.click();
  try {
    const busy = page.getByRole("button", { name: "测试中…", exact: true });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute("aria-busy", "true");
    await busy.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
    await expect.poll(() => requests).toBe(1);
  } finally {
    release?.();
  }
  await expect(button).toBeEnabled();
  await expect(page.getByText("连接成功，模型回复：synthetic-ok")).toBeVisible();
  await button.click();
  await expect.poll(() => requests).toBe(2);
  await expect(button).toBeEnabled();
});
