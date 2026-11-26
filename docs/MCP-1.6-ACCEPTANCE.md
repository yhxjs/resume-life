# MCP 1.6 验收记录

验收日期：2026-11-26，Asia/Hong_Kong。范围为本机 stdio MCP；不增加远程 HTTP，不调用真实收费模型。MCP **1.6.0 / 169 个工具 / 28 项工作流**，数据库 **v14**。

## 来源与环境

- Git 基线：`8d0324ce6de167c6453b1a52577a52ba4fb99af2`。本轮验证包含工作区内尚未提交的 MCP 1.6 改动，不能仅凭该提交号重建结果。
- Windows 10 x64 `10.0.19045`；Node `24.21.0` / npm `11.19.0`。
- WSL Ubuntu x64，内核 `6.18.58.1-microsoft-standard-WSL2`；Node `24.21.0` / npm `11.19.0`。源码复制到 Linux 原生文件系统，单独执行 `npm ci`、准备 OCR 和 Chromium；不复用 Windows 的原生依赖。
- Linux E2E 固定快照：1,794 个受 Git 管理或未忽略的新文件，完整内容清单指纹 `769fa39dcd03d45a65333ed31930c974866ad9bee47b6c8e8f8c072229e08e10`；包含测试、排除 Markdown 文档的指纹 `3231e2d8c2efc8867edfc2da0faf5231b5342fd452e95932aaf8e0c6fa873a6b`；应用及构建输入指纹 `f41e0ec55b41b7c5e2c9941f8df49798a069b039b348620bbcba87861ba9cd1f`。
- 最终夹具复验快照：完整指纹 `9fd468f71bb56440e2bd5fbce802bea19c1e74633cc8f6ed552c399eb1f75787`，排除文档后的指纹 `ef52dc3fde6f9aedebdfeb8984d104976cacd0075ef357a8209138350b0f5c59`；仅 `tests/e2e/llm-usage.spec.ts` 的夹具适配变化，应用及单元测试源码相同。清单为 `mcp-1.6-linux-final-snapshot.json`。
- 覆盖率快照指纹为 `45b7c1849620c413e1104fb243324891519cda85c3f5bbf4bbb787a4277ed4fe`；之后只修复下述 E2E 夹具和定位，并更新文档，应用和单元测试源码相同。
- 指纹按相对路径与文件 SHA-256 的排序 JSON 计算，原清单保存在 `.test-artifacts/mcp-1.6-linux-snapshot.json`。应用指纹额外排除 `tests/`、`__tests__/`、`.test.` 文件；构建配置与依赖锁仍包括在内。

## Windows 已验证

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| MCP 集成测试 | 21 个文件，396 项通过 | `mcp-1.6-all.log` |
| 数据库迁移、备份旧版本等专项 | 7 个文件，200 项通过 | `mcp-1.6-domains.log` |
| 备份流测试 | 92 项通过 | `mcp-1.6-backup-stream.log` |
| 原生 CLI 进程 / 仓库流水线 | 2 个文件，15 项通过，包含 Linux 跳过的 5 项 Windows 专用测试 | `mcp-1.6-windows-process.log` |
| 全局 lint / typecheck | 通过 | `mcp-1.6-lint-full.log` / `mcp-1.6-types.log` |
| 生产构建 / 产物追踪 | 通过，检查 163 份 NFT | `mcp-1.6-windows-build.log` / `mcp-1.6-windows-build-trace.log` |
| 接入向导网页 E2E | 2 项通过 | `mcp-1.6-windows-e2e.log` |
| 真实 Codex CLI | 正式 stdio 入口修复后重新执行，退出 0、`ok:true` | `mcp-1.6-codex-final.log` |
| 官方 Inspector CLI | legacy + modern，20 次真实 CLI 调用，通过 | `mcp-hosts/windows-report.json` |
| 万级 / 十万级检索 | 全量分页无缺失、重复或乱序；快照中 65/65 次写入成功 | `mcp-search-benchmark-windows.json` |

以上证据均位于仓库忽略目录 `.test-artifacts/`。Windows 本轮网页检查为新增向导专项；完整网页回归由下面的 Linux 发布检查执行。

## Linux 完整发布检查

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| 依赖审计 / 公共资源 | 通过 | `mcp-1.6-linux-audit.log` / `mcp-1.6-linux-assets.log` |
| 全局 lint / typecheck | 通过 | `mcp-1.6-linux-lint.log` / `mcp-1.6-linux-types.log` |
| MCP 契约 / 示例 | 通过，169 个工具、28 项工作流 | `mcp-1.6-linux-contract.log` / `mcp-1.6-linux-example.log` |
| 生产构建 / 产物追踪 | 通过，检查 163 份 NFT | `mcp-1.6-linux-build.log` / `mcp-1.6-linux-build-trace.log` |
| 全量测试与覆盖率 | 643 个文件通过；14,634 项通过、5 项平台跳过；496.67 秒 | `mcp-1.6-linux-coverage.log` |
| 行 / 函数 / 分支覆盖率 | 90.10% / 85.68% / 82.76%，通过原有 85% / 78% / 77% 门槛 | 同上 |
| 语句覆盖率 | 87.37% | 同上 |
| 页面 / 布局覆盖 | 2,150 / 2,427 行，36 / 41 个文件，通过页面门槛 | `mcp-1.6-linux-page-coverage.log` |
| 完整网页 E2E | 执行 893 项，892 项通过，1 项用量统计夹具失败；耗时 22.5 分钟 | `mcp-1.6-linux-e2e.log` |
| 夹具修复后的复验 | 受影响文件 4 项全部通过；该文件 lint 与全局 typecheck 通过，未解决失败为 0 | `mcp-1.6-linux-final-fixture-e2e.log` / `mcp-1.6-linux-fixture-retest.json` |
| 官方 Inspector CLI | legacy + modern，20 次真实 CLI 调用，通过 | `mcp-hosts/linux-report.json` |
| 万级 / 十万级检索 | 全量分页与并发写入通过 | `mcp-search-benchmark-linux.json` |

覆盖率中的 5 项跳过均为原有 `skipIf(process.platform !== "win32")`：4 项原生批处理/取消进程树验证和 1 项 Claude CLI 空参数转发验证。对应两个测试文件已在 Windows 实跑，15 项全部通过。

原始完整运行报告为 `.test-artifacts/mcp-1.6-linux-release.json`，保留 E2E 的退出码 1 与 `passed:false`。最终复验报告为 `mcp-1.6-linux-fixture-retest.json`，退出码 0、`passed:true`、`unresolvedFailures:0`。本轮 E2E 证据由一次 893 项完整运行和一次受影响文件 4 项复验组成，未将原始失败改写为一次性全绿。

依赖审计和 CycloneDX SBOM 使用同一依赖锁，SBOM 含 647 个组件。`package-lock.json` SHA-256 为 `e6783835a3fb18e2a0c612d950b74aefe2592d25ed423080af7d7b6e1ab8caf9`；审计策略、补丁脚本、SBOM 和 picomatch 安全报告哈希保存在 `mcp-1.6-linux-supply-chain.json`。

完整覆盖率首次执行发现测试隔离问题：故意删除 `notebook_entries` 的用例恢复了表与索引，遗漏 v14 新增的检索触发器。补齐触发器恢复后，重新执行全量覆盖率、页面覆盖检查和完整 E2E。接入向导 E2E 同时将复制提示定位收窄到对应 `role=status`，避免新增任务状态摘要导致歧义。生产源码完全相同，因此保留前次成功的审计、资源、示例、检索、构建和 NFT 结果；报告明确标记 `reusedAfterTestOnlyFix`，未把失败用例改为跳过，也未降低覆盖率门槛。

完整 E2E 随后发现共用 `mockApi` 对新增诊断接口返回空对象，以及备份导出提示使用全页面唯一 `role=status` 的旧假设。补齐类型约束的合成诊断响应，收窄备份成功提示定位；先复跑两个失败用例，再从头执行全部 E2E。应用代码、单元测试和覆盖率输入未变，成功的覆盖率结果保留。原快照、失败轨迹和修复链保存在 `.test-artifacts/`，报告中的 `qaResumption` 记录每轮改变的文件及沿用检查的来源指纹。

完整运行中的唯一剩余失败来自 `llm-usage.spec.ts` 自己的 API 兜底夹具，同样把新增诊断接口返回为空对象。改为复用公共 `mockApi` 并让用量接口覆写后，四项用量测试全部通过（4.8 秒）。复验前后逐文件比对应用和单元测试输入，最终快照运行期间未变；最终 Windows 工作区与 Linux 快照的差异检查只允许文档变化，见 `mcp-1.6-final-source-check.json`。

## 功能验证重点

- 向导：实际配置可启动 stdio，读取状态并核对实例绑定；诊断和配置不含模型密钥，遵守权限预设。
- 持久流程：真实子进程在服务端提交后退出，恢复不产生第二次写入；上传、提取任务、预览、保存可继续；来源冲突进入 `needs_attention`，保留原始输入。
- 进度：记录真实阶段、数量、耗时、心跳与资源等待；超时即使由查询先发现也返回 `TIMEOUT`，已提交结果保持可恢复。
- 三方比较：服务端捕获可信 base，读取权限过滤，保留无冲突修改；冲突需明确选择，再预览、幂等保存；不修改已发布快照。
- 检索：领域版本失效规则、独立只读快照、权限和恢复世代隔离；两平台十万条完整遍历结果相同。完整方法和延迟见 [检索报告](MCP-SEARCH-BENCHMARK.md)。
- 协议：修复 ESM/CJS 类身份差异导致的 modern 工具发现失败；正式入口两代协议通过。真实 Host 和 SDK 探针的范围分别记录在 [兼容说明](MCP-COMPATIBILITY.md)。

## 复现命令

在各平台原生 Node 环境与隔离的数据目录执行：

```sh
npm ci
npm run setup:ocr
npx playwright install chromium
npm run audit:dependencies
npm run check:public-assets
npm run lint
npm run typecheck
npm run check:mcp:contract
npm run example:mcp
npm run benchmark:mcp:search
npm run build
npm run check:build-trace
npm run test:coverage
npm run check:page-coverage
npm run test:e2e
```

Linux 系统依赖缺失时按 README 安装 Chromium 的系统依赖。Inspector 的固定缓存安装和执行命令见兼容说明；Windows 已安装 Codex CLI 时执行 `npm run check:mcp:codex`。Host 脚本使用临时配置与合成数据库，不更改用户真实 Host 配置。这里的本地实跑不等于远端 GitHub Actions 已执行。

## 本轮范围决定

Tasks 已完成规范和 SDK 适配评估，**没有实现或宣告 Tasks 扩展支持**；继续提供持久 job 工具，验证未声明 Tasks 的客户端兼容回退。远程 HTTP 按用户要求排除。完整功能用法见 [MCP 文档](MCP.md)，范围勾选见 [实施计划](MCP-1.6-PLAN.md)。
