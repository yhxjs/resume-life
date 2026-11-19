import path from "node:path";
import fs from "node:fs";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const API_DIR = path.join("src", "app", "api");
const NUMERIC_ID_SEGMENT = /\[(?:id|qid|tid|mid|interviewId|versionId)\]/;
const NUMERIC_PATH_ID_COERCION = /Number\(\s*(?:id|rawId|rawAppId|rawInterviewId|tid|qid|mid|idParam|\(await params\)\.(?:id|qid|tid|mid|interviewId|versionId)|params\.(?:id|qid|tid|mid|interviewId|versionId)|raw\.(?:id|versionId))\s*\)/;
/** 与 eslint.config.mjs 中该规则的 message 保持一致的识别片段 */
const RULE_MARKER = "有界解析";

let eslint: ESLint;

function routeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(resolved) : entry.name === "route.ts" ? [resolved] : [];
  });
}

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

  it.each([
    ["直接调用", 'return Response.json(await request.formData());'],
    ["计算属性", 'return Response.json(await request["formData"]());'],
    ["解构", "const { formData } = req; return Response.json(await formData());"],
  ])("守卫能拦下无界 formData 的%s写法", async (_name, body) => {
    const [result] = await eslint.lintText(
      `export async function POST(req: Request, request: Request) {\n  ${body}\n}\n`,
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(ruleErrors([result!])).not.toEqual([]);
  });

  it.each([
    ["读取流", "return Response.json(request.body?.getReader());"],
    ["计算属性", 'return Response.json(req["body"]);'],
    ["解构", "const { body } = _req; return Response.json(body);"],
  ])("守卫能拦下原始 request.body 的%s写法", async (_name, body) => {
    const [result] = await eslint.lintText(
      `export async function POST(req: Request, request: Request, _req: Request) {\n  ${body}\n}\n`,
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(ruleErrors([result!])).not.toEqual([]);
  });

  it.each(["request-limits.ts", "backup-request.ts", "streaming-multipart.ts"])("允许领域解析器 %s 读取请求流", async (file) => {
    const [result] = await eslint.lintText(
      "export function readBoundedStream(request: Request) { return request.body?.getReader(); }",
      { filePath: path.join("src", "lib", file) }
    );
    expect(ruleErrors([result!])).toEqual([]);
  });

  it("路由仍可处理上游响应，或把请求交给有界解析器", async () => {
    const [result] = await eslint.lintText(
      "async function handlePost(request: Request) { const response = await parseMultipartUpload(request); return response.body ?? response.formData(); }\nexport const POST = withRouteErrorHandling('POST /api/probe', handlePost);",
      { filePath: path.join(API_DIR, "probe", "route.ts") }
    );
    expect(ruleErrors([result!])).toEqual([]);
  });
});

describe("API 数字 ID 规范解析", () => {
  it.each(["id", "rawId", "rawAppId", "rawInterviewId", "tid", "qid", "mid", "idParam", "(await params).id", "params.interviewId", "raw.versionId"])("守卫识别直接转换 %s", value => {
    expect(NUMERIC_PATH_ID_COERCION.test(`const result = Number(${value});`)).toBe(true);
  });

  it("所有数字动态 ID 路由都使用共享规范解析器，且不直接 Number 强转路径 ID", () => {
    const violations = routeFiles(API_DIR).flatMap((file) => {
      const relative = path.relative(process.cwd(), file).replaceAll("\\", "/");
      const source = fs.readFileSync(file, "utf8");
      const errors = [];
      const readOnlySource = ["src/app/api/resumes/[id]/copy/route.ts", "src/app/api/resumes/[id]/versions/[versionId]/route.ts"].includes(relative);
      const parser = readOnlySource ? "parseCanonicalStoredId(" : "parseCanonicalPositiveId(";
      if (NUMERIC_ID_SEGMENT.test(relative) && !source.includes(parser)) errors.push("缺少共享解析器");
      if (NUMERIC_PATH_ID_COERCION.test(source)) errors.push("直接 Number 强转路径 ID");
      return errors.map((error) => `${relative}: ${error}`);
    });
    expect(violations).toEqual([]);
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
