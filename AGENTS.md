<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 项目架构约定

- **SQL 所有权**：applications/resumes/reviews/backup 等域的 SQL 收口在 `src/lib` 领域模块；`bank`/`notebook`/`interviews`/`intros`/`tools` 等域由 route 内联 SQL（见 `src/app/api`）。新增查询/写入路径优先落 `src/lib`；被 ≥2 个 route 共用的写路径**必须**落 lib，并沿用 `ApplicationInputError→400 / 其余→500` 的错误收口约定（参考 `src/lib/applications.ts` 头注）。多表写入一律用 `inTransaction`（BEGIN IMMEDIATE）包事务。
- **LLM 调用**必须走 `@/lib/safe-llm`（safeChat/safeChatStream），用户可控内容一律以 untrusted parts 传入；不要在任何 `*-llm.ts` 里新增「把用户文本手拼进带标签字符串」的辅助函数——`wrapUntrustedData` 负责转义标签边界。
- **分页参数**统一走 `parsePaginationParams`（`@/lib/cursor-pagination`），route 内不要重复解析 try/catch 与「分页参数无效」错误文案。
- **CLI 子进程**（repo-scanner）：提示词只走 stdin，不进命令行；Windows 下 `.cmd/.bat` 必须经 cmd.exe 中转时，argv 只允许固定旗标与带引号的路径。
