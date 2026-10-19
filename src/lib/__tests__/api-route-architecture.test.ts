import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const API_DIR = path.join("src", "app", "api");
/** 与 eslint.config.mjs 中该规则的 message 保持一致的识别片段 */
const RULE_MARKER = "有界解析";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

function ruleErrors(results: ESLint.LintResult[]) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === "no-restricted-syntax" && message.message.includes(RULE_MARKER))
      .map((message) => `${path.relative(process.cwd(), result.filePath).replaceAll("\\", "/")}:${message.line}`)
  );
}

describe("API 请求体架构边界", () => {
  it("真实路由文件中不存在绕过有界解析的请求体读取", async () => {
    const results = await eslint.lintFiles([API_DIR]);
    expect(ruleErrors(results)).toEqual([]);
  }, 30_000);

  it("守卫能拦下解构形式的绕过写法", async () => {
    const [result] = await eslint.lintText(
      'export async function POST(req: Request) {\n  const { json } = req;\n  return Response.json(await json());\n}\n',
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(ruleErrors([result!])).not.toEqual([]);
  });

  it("守卫能拦下计算属性形式的绕过写法", async () => {
    const [result] = await eslint.lintText(
      'export async function POST(req: Request) {\n  return Response.json(await req["json"]());\n}\n',
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(ruleErrors([result!])).not.toEqual([]);
  });

  it("守卫能拦下直接调用的写法", async () => {
    const [result] = await eslint.lintText(
      "export async function POST(request: Request) {\n  return Response.json(await request.json());\n}\n",
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(ruleErrors([result!])).not.toEqual([]);
  });
});

const WRAP_MARKER = "withRouteErrorHandling";

function wrapErrors(results: ESLint.LintResult[]) {
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.ruleId === "no-restricted-syntax" && message.message.includes(WRAP_MARKER))
      .map((message) => `${path.relative(process.cwd(), result.filePath).replaceAll("\\", "/")}:${message.line}`)
  );
}

describe("API 路由错误包装", () => {
  it("所有导出处理函数都经 withRouteErrorHandling 包裹", async () => {
    const results = await eslint.lintFiles([API_DIR]);
    expect(wrapErrors(results)).toEqual([]);
  }, 30_000);

  it("守卫能拦下裸函数声明式导出", async () => {
    const [result] = await eslint.lintText(
      "export async function GET(req: Request) {\n  return Response.json({});\n}\n",
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(wrapErrors([result!])).not.toEqual([]);
  });

  it("守卫能拦下裸箭头函数式导出", async () => {
    const [result] = await eslint.lintText(
      "export const GET = async (req: Request) => Response.json({});\n",
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(wrapErrors([result!])).not.toEqual([]);
  });

  it("守卫能拦下裸函数表达式式导出", async () => {
    const [result] = await eslint.lintText(
      "export const POST = function (req: Request) { return Response.json({}); };\n",
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(wrapErrors([result!])).not.toEqual([]);
  });

  it("包裹式导出与非 handler 导出都不被拦下", async () => {
    const [result] = await eslint.lintText(
      'async function handleGet() { return Response.json({}); }\nexport const GET = withRouteErrorHandling("GET /api/x", handleGet);\nexport const STAGES = [1, 2, 3];\n',
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(wrapErrors([result!])).toEqual([]);
  });
});
