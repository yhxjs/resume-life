# MCP 本机 Host 兼容验证与 Tasks 评估

核查日期：2026-11-26。范围仅限本机 stdio、合成数据和独立 Host 配置。本页记录 Inspector 验收及协议扩展评估；Codex 的真实 Host 验收由 `check:mcp:codex` 单独负责。

当前结论：正式 stdio 入口修复后，Windows 与 WSL Ubuntu 上官方 Inspector CLI 的 legacy（2025-11-25）与 modern（2026-07-28）验收均通过，SDK 的两种协议 fallback 也通过。Tasks 扩展仍未实现、未声明支持，继续使用现有持久 job 工具。本页记录修复事实、实际覆盖范围及后续 Tasks 适配的缺口；不把基础协议兼容等同于 Tasks 支持。

## 实际运行者与固定版本

| 项目 | 本次版本 / 结果 | 用途 |
| --- | --- | --- |
| 操作系统 | Windows `win32/x64`，`10.0.19045`；WSL Ubuntu `linux/x64`，内核 `6.18.58.1-microsoft-standard-WSL2` | 两个实际验收平台 |
| 项目 Node / npm | `24.21.0` / `11.19.0` | 运行检查脚本及真实 MCP 服务 |
| MCP 服务 / 数据库 | `1.6.0` / `14` | 从实际 `get_mcp_status` 返回值确认 |
| `@modelcontextprotocol/inspector` | **`2.16.0`** | 第二个真实 Host，执行官方 CLI launcher |
| Inspector 执行 Node | **`24.22.1`**，来自 `node-win-x64@24.22.1` / `node-linux-x64@24.22.1` | 只为子进程提供满足 engine 的运行时 |
| `@modelcontextprotocol/core/client/server` | **各 `2.4.0`** | 项目和 Inspector 缓存两处均核对 |
| `@modelcontextprotocol/ext-tasks` | **`0.2.3`** | Tasks requester 的兼容回退探针 |
| 本机 Codex CLI | `0.171.0-alpha.13.2` | Windows 的真实验收见 `check:mcp:codex` 和发布验收记录 |
| 本机 Claude Code | `2.1.327` | 本任务只查询版本，未计入已验收 Host |

PATH 中未发现全局 Inspector 或 Gemini CLI，因此安装 Inspector 到忽略目录。脚本会拒绝 Inspector、ext-tasks 或两处 SDK 的版本不符，并将实际版本写入报告的 `pinnedPackages`。这固定了被测协议包；没有声称 npm 的所有间接依赖都被冻结。

Inspector 自带的 SDK 不改变其真实 Host 身份：本次工具发现、错误解析、文件读取和重启由官方 CLI 自己完成。另用 SDK 创建合成资料、检查旧协议和 Tasks fallback；这些程序不计作第三个真实 Host，也不代替 Codex 验收。

## 可复现准备与命令

在已经安装项目依赖的仓库根目录执行。安装缓存需要联网；实际验证不调用模型、不启动 remote HTTP、不登录外部 Host。脚本不自动下载依赖，普通 CI 可以只跑专用测试；准备好缓存的 CI/WSL runner 再显式执行 Host 验收。

### Windows x64 / PowerShell

```powershell
npm install --prefix .test-artifacts/mcp-hosts/inspector-2.16.0 --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @modelcontextprotocol/inspector@2.16.0 @modelcontextprotocol/ext-tasks@0.2.3 @modelcontextprotocol/core@2.4.0 @modelcontextprotocol/client@2.4.0 @modelcontextprotocol/server@2.4.0 node-win-x64@24.22.1

npm run check:mcp:hosts -- --inspector-root .test-artifacts/mcp-hosts/inspector-2.16.0 --inspector-node .test-artifacts/mcp-hosts/inspector-2.16.0/node_modules/node-win-x64/bin/node.exe --report .test-artifacts/mcp-hosts/windows-report.json
```

本次 Windows 缓存最初由相同安装选项安装 Inspector `2.16.0` 与 `node-win-x64@24.22.1`，解析到 ext-tasks `0.2.3` 和 SDK `2.4.0`；上面的复跑命令显式固定这些包，避免将来间接版本漂移。实际执行的验收命令就是上面的 `npm run check:mcp:hosts -- ...`。

项目允许 Node `>=24.21.0 <25`；Inspector `2.16.0` 要求 `^22.23.4 || ^24.22.1 || >=26.12.1`。因此，项目 Node `24.21.0` 可以启动 MCP 服务，却不满足该 Inspector 的 engine。用 `24.21.0` 下载缓存时 npm 可能提示 `EBADENGINE`；实际 Inspector 由缓存内的 `24.22.1` 执行，脚本还会先检查其版本。若安装环境启用了严格 engine 检查，使用满足 engine 的 Node/npm 安装缓存。

`--inspector-node` 只决定 Inspector 的解释器，服务仍使用启动检查脚本的 `process.execPath`。不修改 PATH、全局 Node 或用户 npm 设置。若当前 Node 已满足两者要求，可以省略 `--inspector-node`。

### Linux x64 / WSL Ubuntu

Linux 必须使用 Linux 自己安装的项目依赖，不能复用 Windows 的原生依赖或 `node.exe`。在主线准备好的 Linux checkout 中执行：

```sh
npm install --prefix .test-artifacts/mcp-hosts/inspector-2.16.0 --no-save --package-lock=false --ignore-scripts --no-audit --no-fund @modelcontextprotocol/inspector@2.16.0 @modelcontextprotocol/ext-tasks@0.2.3 @modelcontextprotocol/core@2.4.0 @modelcontextprotocol/client@2.4.0 @modelcontextprotocol/server@2.4.0 node-linux-x64@24.22.1

npm run check:mcp:hosts -- --inspector-root .test-artifacts/mcp-hosts/inspector-2.16.0 --inspector-node "$PWD/.test-artifacts/mcp-hosts/inspector-2.16.0/node_modules/node-linux-x64/bin/node" --report .test-artifacts/mcp-hosts/linux-report.json
```

上述 Linux 命令已在 WSL Ubuntu 的原生目录与原生依赖中实跑通过。其他架构需提供该架构可执行的合格 Node 路径。也可在用户缓存安装相同固定包，把包含 `node_modules` 的目录作为 `--inspector-root`。

脚本使用 Node 路径 API、`shell:false` 和绝对服务入口；Windows 超时终止进程树，POSIX 超时终止子进程组。每次运行创建独立临时 HOME、配置目录、数据库和产物目录，结束后关闭客户端并删除该临时根目录。报告中的临时配置路径是运行证据，结束后不能直接复用；重新执行脚本会重新生成配置。

### 不需要 Inspector 缓存的代码检查

```sh
npm test -- src/mcp/hosts-compatibility.test.ts
node node_modules/eslint/bin/eslint.js scripts/check-mcp-hosts.mjs src/mcp/hosts-compatibility.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

本次 7 项专用测试、上述 lint 和全局 TypeScript 检查均通过。测试覆盖环境隔离、engine 边界、CLI 失败与工具失败的区分、结构化结果一致性、分页产物完整性、无 shell 参数传递及超时结束。

## Windows / Linux 实跑证据与覆盖边界

最终报告：`.test-artifacts/mcp-hosts/windows-report.json`，时间 `2026-11-26T03:59:02.063Z`（香港时间 11:59:02），退出码 **0**，`ok:true`，共执行 20 次真实 Inspector CLI 调用。此前 11:50:24 的实跑因 modern 发现缺陷返回退出码 1、`ok:false`；主线修复正式入口后重新运行相同完整脚本，所有检查通过，没有非预期失败。检查脚本及专用测试未因该修复改变，成功标准仍要求两种 era 全部通过。

Linux 报告：`.test-artifacts/mcp-hosts/linux-report.json`，时间 `2026-11-26T04:03:51.080Z`（香港时间 12:03:51），退出码 **0**，`ok:true`。相同脚本在 Linux 原生 Node、SQLite 与 Inspector 下执行 20 次真实 CLI 调用，完整覆盖下表相同检查；两种 era 均发现 102 个工具、读取相同 25,779 字节产物，旧协议握手、Tasks fallback 与 job 重连检查全部通过。

| 执行者 | 协议 / 内容 | Windows 与 Linux 结果 |
| --- | --- | --- |
| Inspector CLI | `--protocol-era legacy` / `2025-11-25` | 通过 |
| Inspector CLI | 只读工具发现与 `readOnlyHint` | 两种 era 各 102 个，与当前 readonly 预设完整比对 |
| Inspector CLI | `get_resume` 不存在 id / 非法 id | 两种 era 均通过：`NOT_FOUND` / `INVALID_ARGUMENT`；`isError:true`、结构化 error、requestId 均有效；CLI 按约定退出 5 |
| Inspector CLI | `read_export_artifact` | 两种 era 均通过：4 页，25,779 字节，逐页验证 ID、偏移、base64、长度和 SHA-256；最终与 SDK 生成的合成原文逐字节一致 |
| Inspector CLI | 每次调用退出后重新启动 CLI 与服务 | 两种 era 均通过：workspace binding 一致；已完成 job 和导出文件仍可读取 |
| Inspector CLI | `--protocol-era modern` / pinned `2026-07-28` | 修复后的正式入口通过完整验收 |
| SDK 2.4.0 + ext-tasks 0.2.3 | legacy Tasks requester | 服务未声明 Tasks，`get_mcp_status` 回退到 `immediate`，结果通过 |
| SDK 2.4.0 + ext-tasks 0.2.3 | pinned `2026-07-28` / modern Tasks requester | 通过；服务未声明 Tasks，普通调用回退到 `immediate`，未产生 task handle |
| 原始 stdio 请求，仅用 SDK transport 分帧 | `2024-11-05`、`2025-03-26`、`2025-06-18` | 各自精确版本握手、工具发现和首次调用通过 |
| SDK 2.4.0 | 现有 job 重连、同键重放、取消已完成任务 | 同一 jobId、仍为 succeeded、保留结果 |

合成 Markdown 的 SHA-256：`9f5e31cdfeb8b555455d97f7b505846017337bd8e61c0f0f04024f5f6f391bc3`。报告保留固定包版本、OS/架构、两种 Node 版本、脚本命令，以及每次 Inspector 的实际 executable/argv/退出码；不输出完整环境或模型密钥。

本次发现只验证授权的 102 个 read 工具，不代表 64 个 write 和 3 个 llm 工具都通过 Inspector 实调。写入只用于 SDK 创建隔离合成资料和 Markdown 导出，没有真实模型请求。重启验证针对已提交结果；没有声称本次 Host 脚本测过运行中强杀、同时多写客户端、PDF/OCR、用户的外部 Host 配置或远程连接。

实际子进程环境只带必要的 OS/PATH 信息及固定合成配置；HOME/XDG/APPDATA/CODEX_HOME 均重定向。没有继承 `NODE_OPTIONS`、`MCP_CATALOG_PATH` 或模型 token；Inspector 使用显式临时 `--config`、内存 secret store。脚本比较配置前后哈希，并确认没有生成默认 catalog。`workspaceBinding` 仅用来核对同一数据实例，未当作凭证或权限。

## modern 发现缺陷的修复记录

首次验收时，生产入口 `src/mcp/stdio.ts` 向 ESM `serveStdio` 返回由 tsx/CJS 加载的高层 `McpServer`。SDK `2.4.0` 内部以 `product instanceof McpServer` 决定是否取 `product.server`；两种模块实例的类身份不同，modern 分支得到高层 wrapper，安装 `server/discover` handler 时访问缺失的 `_supportedProtocolVersions`，抛出 `undefined.includes`。legacy 分支未触发该安装路径，因此仍能工作。

正式入口已使用以下写法：

```ts
serveStdio(() => createResumeLifeMcpServer(config).server, {
  onerror: error => { logServerError("mcp.transport", error); },
});
```

临时诊断入口显式返回底层 `.server` 后，SDK pinned `2026-07-28` 的发现和 `get_mcp_status` 先行通过；之后主线将相同修复应用到正式入口。11:59 的完整复验使用 `scripts/mcp.mjs` 正式入口，两种 Inspector era 和两种 SDK probe 均已通过。未将发现失败改为预期拒绝，也未放宽成功标准。SDK 固定版本的低层 `Server` 属于 `serveStdio` 允许返回的类型。

本地诊断证据：`.test-artifacts/mcp-hosts-modern-failure.log`（调用栈）和 `.test-artifacts/mcp-hosts-modern-factory-proposal.log`（临时入口成功结果）。修复 modern 基础发现不会自动实现 Tasks 扩展。

## Tasks 决策：保留现有 job API，暂不声明扩展支持

本轮评估依据官方规范、扩展包文档及本机安装的 SDK `2.4.0` / ext-tasks `0.2.3`，不是套用旧 SDK 的示例。服务目前不声明 `capabilities.tasks` 或 `extensions["io.modelcontextprotocol/tasks"]`，工具没有启用 Tasks execution；测试对此作显式断言。已有 `start_mcp_job`、`get_mcp_job`、`list_mcp_jobs`、`get_mcp_job_result`、`cancel_mcp_job` 继续作为普通工具使用。

### 两代协议不能混用

| 项目 | 2025-11-25 实验性 Tasks（V1） | 2026-07-28 Tasks 扩展（V2） |
| --- | --- | --- |
| 声明 | `capabilities.tasks`、工具 `execution.taskSupport` | `extensions["io.modelcontextprotocol/tasks"]` |
| 请求选择 | task-augmented 请求参数 | 服务按请求决定；客户端在本次请求 `_meta` 中声明扩展能力 |
| 初始响应 | Task handle | `resultType:"task"` 与 seed `task` |
| 生命周期方法 | `tasks/get`、`tasks/result`、`tasks/list`、`tasks/cancel` | `tasks/get`、`tasks/update`、`tasks/cancel`；无 list/result 方法 |
| 结果读取 | 独立 `tasks/result` | `tasks/get` 的终态内联原请求结果或 JSON-RPC error |
| 取消 | V1 cancel 结果 | V2 返回 `resultType:"complete"` 的空确认，状态最终一致 |

官方 V2 规范要求每次请求都检查客户端能力；没有声明的调用不能收到 task handle。创建响应前任务必须已经可查询；未知 task ID 与缺失扩展能力分别有协议错误要求。工具的 `isError:true` 结果属于 `completed`，只有 JSON-RPC 执行错误属于 `failed`。`notifications/cancelled` 不能用于取消任务；取消确认也不能抹去已经提交的结果。[S1][S2]

### SDK 与包能提供什么

- SDK `2.4.0` 支持两代基础协议，core 仍导出 V1 Task schemas；这些类型本身不构成本项目的持久任务服务。已修正的 stdio factory 只解决基础发现，Tasks 仍需额外的扩展 wire 适配。
- ext-tasks `0.2.3` 提供 V1/V2 schemas 和 requester session；`createTaskSessionFromClient` 对没有 Tasks 的服务可回退到即时调用，本脚本已经验证 legacy 与 modern 两种情况。这是 Tasks 未实现时的兼容回退，不是 Tasks 生命周期验收。[S3]
- 连接 V2 Tasks 服务时，该 requester 还要求 `rawDispatch` 与 `v2RequestFraming`。缺少两者时包会拒绝创建 V2 session；需要统一管理请求 ID、响应分发、能力元数据、关闭与取消，不能让 SDK 和扩展各自覆盖同一个 transport listener。[S3][S4]
- `/receiver` 是接收 **V1 sampling/elicitation** 的客户端绑定，不是可直接装在本项目上的 V2 tools 服务端持久队列。[S5]

因此不属于“增加一个 capability 位”的短补丁，本轮没有为 Tasks 添加运行依赖、数据库结构或协议 adapter。

### 未来适配的接口边界（提案，未实现）

建议在现有 `McpTools` 输入验证和权限检查之后，增加可选的 Tasks bridge；复用 `startMcpJob` 的执行与恢复，不建立第二套工作队列。第一阶段只为当前四类长操作考虑 Tasks：简历导出、作品集导出、仓库采集和上传文件提取。原五个 job 工具保持返回结构，尤其不能把 `start_mcp_job` 的“任务描述”结果悄悄替换为导出结果。

| 拟议入口 | 职责 / 必须遵守的约束 |
| --- | --- |
| `maybeStart(originalToolCall, requestContext)` | 只在当前请求声明正确扩展时考虑 task augmentation；复用原工具 schema、限长、白名单、写开关、来源读取权限与模型开关 |
| `get(taskId, requestContext)` | 从持久关联恢复 job；重新验证当前读取权限、workspace 与 generation；按目标协议输出完整终态 |
| `cancel(taskId, requestContext)` | 重新验证取消工具及原操作写权限；复用提交前 guard，已提交结果优先；V2 只返回确认 |
| `update(taskId, inputResponses, requestContext)` | 先实现无待输入请求的合法处理；只有确实实现输入生命周期后才开放 `input_required` |

这只是边界提案，尚未确定 wire adapter 的可编译接口。taskId 必须关联服务端的 workspace binding、data generation、jobId 和原始方法/工具；绑定值由服务端得出，不能用客户端传来的 binding 授权。所有 get/update/cancel 请求重查当前权限；读取与取消沿用现有 `get_mcp_job` / `get_mcp_job_result` / `cancel_mcp_job` 门控和来源权限。V1 与 V2 需要分开的序列化与能力判断；旧协议和未声明扩展的客户端保持原普通工具返回值。

以下缺口必须先解决：

1. **结果恢复**：现有 job 只缓存领域结果描述和错误码，`get_mcp_job_result` 又是分页接口；Tasks 终态需要原请求完整 `CallToolResult` 或 JSON-RPC error。需保存或可重复重建原工具结果、结构化 schema 与错误分类，不能用分页页片或另一工具的返回值充当最终结果。
2. **保留期限**：当前结果可能因 32 KB 上限、缓存容量或 TTL 无法保留，状态记录却仍存在。Tasks 的 `ttlMs`、可查询任务和最终结果保留必须协调，先有可恢复持久记录才能返回 handle，不能承诺无限可取。
3. **崩溃 / 恢复语义**：当前 owner/lease 失效会进入 `interrupted`；已提交 receipt 可恢复，未提交工作不会自动重跑。恢复备份还会使 generation 失效。需显式映射为符合协议的终态及安全错误，不能长期伪装 working，也不能为了自动恢复重复写入。
4. **错误 / 取消语义**：保留业务 `isError` 与协议错误的区别；任务级取消独立于请求中止。跨进程取消、最后一次提交和客户端关闭竞态均要复用现有 guard；完成后取消应保留结果。本脚本仅验证了“已经完成后取消”，不等于所有竞态已经过 Host 验证。
5. **权限与实例隔离**：拥有 taskId 或 workspaceBinding 不意味着可读数据。权限撤销、换数据库、generation 变化都要检查；V1 list 要做可见性过滤，V2 不新增不存在的 list 方法。

### 可执行验收与后续门槛

现在可以直接执行上面的 Host 脚本：它验证旧协议精确握手、普通调用与未声明 Tasks 的 requester fallback、同键 job 重放、重启结果读取和完成后取消。它不会宣称已覆盖不存在的 Tasks adapter。

未来适配进入主线前，至少需要补充这些协议集成测试，再允许服务声明 Tasks：

1. 相同原工具分别使用普通 legacy、V1 task-augmented、V2 声明扩展和 V2 未声明扩展请求，逐一验证原结果与 handle 的正确选择；旧 Host 不被迫升级。
2. 创建返回后立即在另一个本机 stdio 客户端查询；客户端重启、服务强杀、已提交 receipt 恢复、未提交中断均有明确结果，不重复启动同一写入。
3. 业务错误完成、JSON-RPC 失败、未知 ID、TTL 到期、缓存结果不可恢复、权限撤销与备份 generation 变化逐一验证。
4. 原客户端与第二客户端分别取消运行中任务；在提交前后注入竞态，校验最终结果、权限与 ACK/终态的区别。
5. 若开放输入请求，验证 `input_required → update → completed`、重复/未知输入 key 和断线恢复；不以测试桩冒充真实 Host 支持。

## 官方资料与本地核查位置

- [S1：2026-07-28 Tasks 扩展规范](https://modelcontextprotocol.github.io/ext-tasks/specification/2026-07-28/tasks.html)：能力、方法、状态、结果与取消的规范依据。
- [S2：2025-11-25 实验性 Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)：V1 的能力与生命周期接口。
- [S3：ext-tasks adapters 与 schemas](https://modelcontextprotocol.github.io/ext-tasks/typescript/adapters-and-schemas.html)：SDK adapter、raw dispatch 和版本适配边界。
- [S4：从 SDK 迁移](https://modelcontextprotocol.github.io/ext-tasks/typescript/migrating-from-the-sdk.html)：requester 迁移要求。
- [S5：V1 receiver](https://modelcontextprotocol.github.io/ext-tasks/typescript/receiver.html)：sampling/elicitation 接收绑定的范围。
- [Tasks 扩展入口](https://modelcontextprotocol.io/extensions/tasks/overview) 与 [2026-07-28 变更记录](https://modelcontextprotocol.io/specification/2026-07-28/changelog)：核心协议与扩展的边界。
- [官方 Inspector 仓库](https://github.com/modelcontextprotocol/inspector) 和 [Inspector 文档](https://modelcontextprotocol.io/docs/tools/inspector)：真实 CLI 的来源。

同时检查了实际固定包中的 `package.json`、Inspector launcher、ext-tasks `README.md` / `dist/client/sdk-client-adapter.js`，以及项目 SDK `dist/stdio.mjs` / 类型声明。项目适配依据是 `src/mcp/tools.ts`、`src/mcp/job-tools.ts`、`src/lib/mcp-jobs.ts` 的当前实现；不以外部文档代替本地运行证据。
