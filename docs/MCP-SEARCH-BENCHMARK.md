# MCP 检索基准：Windows / Linux 实跑记录

2026-11-26 11:37:46（Asia/Hong_Kong；JSON 时间 `2026-11-26T03:37:46.808Z`）在 Windows 上实跑 10,000、100,000 条合成记录。两种规模均遍历全部页面，并逐条验证 ID，不以抽样替代完整性检查。

同日 12:01:51（JSON 时间 `2026-11-26T04:01:51.892Z`）在 WSL Ubuntu 原生目录复跑相同规模与参数，全部通过。两次使用相同检索源码和数据库版本；报告包含源码哈希。

## 复现

在仓库根目录运行：

```powershell
node scripts/benchmark-mcp-search.mjs --sizes=10000,100000 --limit=50 --body-chars=512 --samples=30 --writes=64 --output=.test-artifacts/mcp-search-benchmark-windows.json
```

不传参数时同样执行 10,000 和 100,000 条，默认报告路径为 `.test-artifacts/mcp-search-benchmark.json`。`--help` 显示全部参数；只接受有界整数和规模列表。脚本使用当前 Node 和仓库内 tsx，不修改 package.json，不下载依赖。

基准入口为 `scripts/benchmark-mcp-search.mjs`，实现及并发 writer 为 `scripts/benchmark-mcp-search-worker.mjs`。每个规模使用独立进程和 `os.tmpdir()` 下的新库，覆盖并忽略调用环境的 `RESUME_LIFE_DATA_DIR`。临时目录带所有权标记，结束后核对路径和标记再清理；报告保留在输出路径。没有读取或写入用户真实数据库。

## 测量口径

- 调用生产 `searchRecordsPage`，使用实际 SQLite、领域版本触发器和分页实现；不包含 MCP stdio、工具日志、Web 请求或模型调用的耗时。
- 数据为 `bank_entry` 单领域，ID 为 1…N。每条题干 512 个 UTF-16 单元，包含中英文、唯一序号、普通命中词；全量查询命中全部记录。另测每 97 条一条命中的稀疏词。
- 首屏为该进程第一次查询，包含冷 COUNT 缓存的扫描；数据库刚完成插入和 ANALYZE，不能视为操作系统冷磁盘缓存。导入、建库和启动时间单列/排除。
- 热首屏和相同续页各采 30 次；随后重新从第一页完整遍历，记录所有页面的延迟分布、条数、顺序、重复/缺失计数和 ID 序列 SHA-256。请求 limit=50，但响应体预算可能令实际每页少于 50 条。
- 仅观察 SQL，不改写查询：统计实际 COUNT 执行次数，以及读连接上的 BEGIN、BEGIN IMMEDIATE 和 `query_only`。trace 自身有少量固定开销。
- 并发验证单独执行，不计入正常首/续页延迟。在查询已读取领域 revision、快照已固定时，通过同步屏障暂时保持事务打开。另一 worker 的独立 SQLite 连接先做 64 次基线 UPDATE，再在该快照打开期间提交 1 次 INSERT 和 64 次 UPDATE，逐次记录自动提交耗时。
- writer 插入一条新的匹配记录后，尚未结束的读快照仍应看到旧总数和旧最大 ID；随后旧游标必须返回 CONFLICT，新首屏必须看到 N+1 条。这比只看写入成功时间更能证明快照隔离与无写锁竞争。
- 同步屏障期间 reader 等待 writer，未持续消耗查询 CPU；这组写入延迟用于验证读事务的锁行为，不代表持续查询计算负载下的写入吞吐。

## 环境与源码

| 项目 | 实测值 |
| --- | --- |
| 系统 | Windows 10，10.0.19045，x64 |
| CPU | AMD Ryzen 7 5800H，16 个逻辑处理器 |
| 内存 | 68,564,348,928 bytes |
| Node / SQLite / tsx | v24.21.0 / 3.53.4 / 4.23.15 |
| DB 版本 | 14 |
| writer journal / synchronous | WAL / 2 |
| Git 基线 | `8d0324ce6de167c6453b1a52577a52ba4fb99af2`，含未提交的 MCP 1.6 主线改动 |
| `mcp-search.ts` SHA-256 | `c4367b75f97b66eb5d80b9a70a6bc4ab2f5969f2cdc4aeaa655d57e0748d516b` |
| `mcp-search-epochs.ts` SHA-256 | `21854be94a9d02bf4caa58c4e9b11ed17cad44dd79bf95f4d71faf327cca0cbf` |

JSON 同时记录 db.ts、db-schema.ts 和两个基准脚本的运行前后哈希；本次完全一致。脚本在检测到这些文件运行中变化时报告失败，不混用版本形成性能结论。

## Windows 实测结果

所有延迟单位为 ms。完整遍历时长包含验证与序列化检查。

| 指标 | 10,000 条 | 100,000 条 |
| --- | ---: | ---: |
| 数据准备 | 409.561 | 2,303.425 |
| 首屏（冷 COUNT 缓存） | 53.253 | 192.337 |
| 热首屏 P50 / P95 | 6.601 / 7.823 | 3.560 / 4.142 |
| 续页 P50 / P95 | 6.609 / 8.094 | 3.601 / 3.832 |
| 完整遍历全部页面 P50 / P95 | 3.864 / 6.086 | 3.537 / 4.023 |
| 完整遍历页数 | 205 | 2,041 |
| 完整遍历总耗时 | 867.579 | 7,499.441 |
| 收到的记录数 | 10,000 | 100,000 |
| 缺失 / 重复 / 乱序 | 0 / 0 / 0 | 0 / 0 / 0 |
| 完整遍历期间额外 COUNT 执行 | 0 | 0 |
| 最大 JSON 响应 UTF-16 长度 | 23,188 | 23,286 |
| 稀疏查询首屏 / 总命中 | 29.425 / 103 | 180.087 / 1,030 |

10 万条的实际和期望 ID 序列哈希均为 `557ad6779a66edeed49f79dfdfca6011190416652587192f4e46f85ae543f6ba`；1 万条均为 `d3e5210109be162ff636f7222d4003eefe30a4f64458a0e1c9cf93d2978fcb7b`。序列编码为 ID 倒序的 `bank_entry:<id>\n`。

## 并发与快照证据

| 指标 | 10,000 条 | 100,000 条 |
| --- | ---: | ---: |
| 无持有读快照时 UPDATE P50 / P95 | 0.534 / 0.636 | 0.534 / 0.630 |
| 快照打开时 UPDATE P50 / P95 | 0.537 / 0.683 | 0.541 / 0.661 |
| 快照打开时 INSERT | 0.708 | 0.879 |
| 读快照结束前已提交的写操作 | 65 / 65 | 65 / 65 |
| 用于验证的快照保持时间 | 37.201 | 37.244 |
| 旧快照总数 / 写后新总数 | 10,000 / 10,001 | 100,000 / 100,001 |
| 旧游标失效耗时 / 错误码 | 3.560 / CONFLICT | 3.480 / CONFLICT |
| 实际检索 BEGIN 次数 | 270 | 2,106 |
| 其中 query_only=1 | 270 | 2,106 |
| 检索 BEGIN IMMEDIATE 次数 | 0 | 0 |

每种规模的完整场景共执行 4 次 COUNT：第一次宽查询、第一次稀疏查询、writer 基线修改后的查询，以及并发修改后的新查询。未改变数据的完整分页没有重复 COUNT。当前缓存 TTL 为 60 秒，因此长时间分页跨过 TTL 时允许重新计数；这与每页重扫不同。

该结果证明此次测试中的检索使用独立只读快照，未占用 BEGIN IMMEDIATE 写锁。本次仅覆盖单领域、上述数据长度与选择率，不能外推所有 16 个领域的联表/子查询、生产磁盘冷启动、多个 writer 或 MCP 传输的性能。短样本也受到 JIT、CPU 调度及同机其他任务影响，不用两个规模的热页差异推断单调加速。

## Linux 实测结果

WSL Ubuntu、内核 `6.18.58.1-microsoft-standard-WSL2`，Linux x64 Node `24.21.0` / SQLite `3.53.4` / tsx `4.23.15`；与 Windows 同一 CPU，WSL 可见内存 33,579,450,368 bytes。项目和依赖均位于 Linux 文件系统，未复用 Windows 的原生依赖。使用上面的同一命令，输出路径改为 `.test-artifacts/mcp-search-benchmark-linux.json`。

| 指标（延迟单位 ms） | 10,000 条 | 100,000 条 |
| --- | ---: | ---: |
| 首屏（冷 COUNT 缓存） | 31.789 | 137.781 |
| 热首屏 P50 / P95 | 3.081 / 5.818 | 2.313 / 3.392 |
| 续页 P50 / P95 | 2.993 / 5.174 | 2.359 / 4.395 |
| 完整遍历页数 / 总耗时 | 205 / 610.392 | 2,041 / 5,510.493 |
| 收到的记录数 | 10,000 | 100,000 |
| 缺失 / 重复 / 乱序 | 0 / 0 / 0 | 0 / 0 / 0 |
| 完整遍历期间额外 COUNT 执行 | 0 | 0 |
| 快照打开时 UPDATE P50 / P95 | 0.024 / 0.048 | 0.024 / 0.042 |
| 读快照结束前已提交的写操作 | 65 / 65 | 65 / 65 |
| 旧快照总数 / 写后新总数 | 10,000 / 10,001 | 100,000 / 100,001 |
| 旧游标失效错误码 | CONFLICT | CONFLICT |
| query_only BEGIN / BEGIN IMMEDIATE 次数 | 270 / 0 | 2,106 / 0 |

两种规模的完整 ID 序列哈希与 Windows 相同；运行前后的六个源码哈希一致。结果适用范围和上述测量口径相同，不能据此承诺所有用户机器或领域的延迟。

## 回归与证据路径

```powershell
npx vitest run src/mcp/search-runtime.integration.test.ts src/mcp/search-benchmark.integration.test.ts src/mcp/search.integration.test.ts
npx eslint scripts/benchmark-mcp-search.mjs scripts/benchmark-mcp-search-worker.mjs src/mcp/search-runtime.integration.test.ts src/mcp/search-benchmark.integration.test.ts
```

新增运行集成测试覆盖 COUNT 跨页/重连复用、TTL、未授权域不查询且不影响游标、授权域不命中记录的增删改及无值变化 UPDATE、筛选范围之外的变动、子表变动、未选域和回滚事务、真实只读快照与另一连接提交、真实备份恢复、工作区/权限变化。脚本集成测试验证 JSON、隔离目录、调用者数据路径不受影响和参数界限。

本轮结果：3 个文件、21 项测试通过（13 项新运行测试、2 项新脚本测试、6 项原有检索测试）；所新增脚本和测试的 eslint、两个脚本的 `node --check` 通过。整合后 Windows 与 Linux 的全局 lint、TypeScript 检查均通过，详见本轮发布验收记录。

- 主报告：`.test-artifacts/mcp-search-benchmark-windows.json`
- Linux 报告：`.test-artifacts/mcp-search-benchmark-linux.json`
- 同次 stdout JSON：`.test-artifacts/mcp-search-benchmark-windows.stdout.json`
- 进度与运行日志：`.test-artifacts/mcp-search-benchmark-windows.stderr.log`
- 回归测试日志：`.test-artifacts/mcp-search-runtime-tests.log`
- lint / 类型检查日志：`.test-artifacts/mcp-search-benchmark-lint.log`、`.test-artifacts/mcp-search-benchmark-types.log`

`.test-artifacts` 为本地验收产物，未作为源码提交；本文件保存实际结果及复现方式。`npm run benchmark:mcp:search` 提供相同入口。
