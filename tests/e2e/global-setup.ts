import fs from "node:fs";
import path from "node:path";
import { cleanupPreviousPlaywrightResults } from "../support/test-artifacts";

const BASE_URL = "http://127.0.0.1:3319";
const AUTH_STATE_FILE = path.join("test-results", ".auth-state.json");

export default async function globalSetup(): Promise<void> {
  cleanupPreviousPlaywrightResults();
  // e2e 服务器用全新数据目录：先走一次初始化拿到会话 cookie，
  // 再以 storageState 注入给所有用例，业务 spec 无需感知登录墙。
  const response = await fetch(`${BASE_URL}/api/auth/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "e2e", password: "e2e-password-123" }),
  });
  if (!response.ok) {
    throw new Error(`e2e 初始化登录凭证失败：HTTP ${response.status} ${await response.text()}`);
  }
  const match = /resume_life_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("e2e 初始化响应缺少会话 cookie");
  fs.mkdirSync(path.dirname(AUTH_STATE_FILE), { recursive: true });
  fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify({
    cookies: [{
      name: "resume_life_session",
      value: match[1]!,
      domain: "127.0.0.1",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
    origins: [],
  }));
}
