import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/safe-llm.ts",
      "src/**/__tests__/**/*.{ts,tsx}",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/llm",
              importNames: ["chat", "chatStream"],
              message: "生产模型调用必须通过 @/lib/safe-llm。",
            },
          ],
          patterns: [
            {
              group: ["**/llm", "**/llm.js", "./llm", "./llm.js", "../llm", "../llm.js"],
              importNames: ["chat", "chatStream"],
              message: "生产模型调用必须通过 safe-llm。",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^@\\/lib\\/llm(?:\\.js)?$/]",
          message: "生产模型调用禁止动态导入底层 llm，必须通过 @/lib/safe-llm。",
        },
        {
          selector: "ImportExpression[source.value=/^(?:\\.\\/|\\.\\.\\/)(?:.*\\/)?llm(?:\\.js)?$/]",
          message: "生产模型调用禁止动态导入底层 llm，必须通过 safe-llm。",
        },
        // 请求体必须经共享的有界解析（parseApiJson），直接调用 req.json() 会绕过体积上限。
        // 用 AST 选择器而非正则文本匹配，因此解构与计算属性等等价写法同样会被拦下。
        {
          selector: "CallExpression[callee.property.name='json'][callee.object.name=/^(req|request)$/]",
          message: "route handler 必须通过有界解析读取请求体，禁止直接调用 req.json()。",
        },
        {
          selector: "VariableDeclarator[init.name=/^(req|request)$/] > ObjectPattern > Property[key.name='json']",
          message: "route handler 禁止解构请求对象的 json 方法，必须通过有界解析读取请求体。",
        },
        {
          selector: "CallExpression[callee.computed=true][callee.object.name=/^(req|request)$/][callee.property.value='json']",
          message: "route handler 禁止用计算属性访问 json 方法，必须通过有界解析读取请求体。",
        },
        // 双重强转会同时绕过两个方向的结构兼容检查；生产代码应改用显式映射或单次窄化。
        // 只匹配 `x as unknown as T`（内层 `as unknown` 的父节点是又一个 as 表达式），
        // 单独的 `x as unknown` 是正常的拓宽写法，不在此列。
        {
          selector: "TSAsExpression > TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message: "生产代码禁止 `as unknown as` 双重强转，请改用显式映射函数或单次窄化。",
        },
        // 路由 handler 必须经统一错误包装，否则未预期异常会穿透成无 requestId 的裸 500。
        // 只用 AST 选择器：正则无法区分 try/finally、嵌套 try 与裸 rethrow，
        // 历史实现因此漏判了 57 个 handler。
        {
          selector: "ExportNamedDeclaration > FunctionDeclaration[id.name=/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/]",
          message: "路由 handler 必须经 withRouteErrorHandling 包裹，否则未预期异常会丢掉 requestId。",
        },
        {
          selector: "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/]:not([init.callee.name='withRouteErrorHandling'])",
          message: "路由 handler 必须经 withRouteErrorHandling 包裹，否则未预期异常会丢掉 requestId。",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 覆盖率 HTML 报告是 v8 生成的产物，不读 .gitignore，只能在这里排除；
    // 不排会连它一起 lint（11000+ 个文件，且报出无意义的 unused-disable 警告）。
    "coverage/**",
    // 本地 agent/工具的临时目录（同样不读 .gitignore）：内容非项目产物，不入 lint 范围
    ".superpowers/**",
    ".codex-*/**",
    ".playwright-mcp/**",
    ".test-artifacts/**",
  ]),
]);

export default eslintConfig;
