# 贡献指南

感谢你为简历奕生（resume-life）贡献代码、测试或文档。

## 开发边界

- 项目面向本机单用户使用，提供单用户本地登录，不引入注册、多用户、租户体系、远程托管或自动发布服务。
- 使用 Node.js `24.21.0`，并保持 `package.json` 中的版本范围。
- 不提交真实简历、求职记录、数据库、上传头像、OCR 模型、API Key 或含个人信息的截图。
- 新增数据库写入优先放在 `src/lib` 领域模块；多表写入使用现有事务工具。
- LLM 调用使用 `@/lib/safe-llm`；用户内容作为不可信输入传递。
- 分页使用 `parsePaginationParams`；CLI 提示词只通过 stdin 传入。

## 本地准备

先使用自己的 Node 版本管理器准备 Node.js 24.21.0，并通过 `node --version` 确认。

```powershell
node --version
npm ci
npm run setup:ocr
npx playwright install chromium
```

POSIX shell：

```bash
npm ci
npm run setup:ocr
npx playwright install chromium
```

## 验证顺序

先运行定向测试，再运行发布检查：

```bash
npm test -- <changed-test-file>
npm run lint
npm run typecheck
npm run build
npm run check:build-trace
npm run test:coverage
npm run check:page-coverage
npm run check:release
```

完整检查可能需要 Chromium、SQLite、OCR 语言包和可联网的依赖安装环境。没有 Linux 实际执行结果时，不要在描述中声称 Linux 已验证。

## 提交变更

提交信息应说明行为变化和验证命令。保持变更聚焦，不降低覆盖率阈值、不删除真实后端契约测试，也不要用跳过测试掩盖失败。

## 拉取请求

请说明：变更动机、影响范围、脱敏后的复现步骤、运行环境、实际验证结果和已知限制。UI 变更只使用虚构数据截图；涉及隐私或安全问题时不要公开提交详情。
