# MCP 1.5 验收归档

归档日期：2026-11-26。1.6 开工时本地 Git 基线为 `8d0324ce6de167c6453b1a52577a52ba4fb99af2`，MCP 1.5.0、165 个工具、26 条工作流、数据库 v13。

此前的 Linux 记录来自 WSL2 / Ubuntu、Node v24.21.0，内核 `6.18.58.1-microsoft-standard-WSL2`。源码从 Windows 复制到 Linux 原生目录，没有复用 Windows node_modules。

| 记录 | 时间与结果 | 范围 |
| --- | --- | --- |
| 首轮 Linux 快速验收 | 2026-11-26 09:31–09:32 HKT，5 项命令退出码均为 0 | MCP 14 文件/323 测试，契约、共享领域回归、示例、类型检查 |
| 后续提取/OCR 修复复验 | 当日 10:13 HKT 起，5 项命令退出码均为 0 | MCP 14 文件/342 测试，OCR 专项、契约、示例、类型检查 |
| 源码核对 | 首轮 1759 个文件无差异，修复轮记录 1760 个文件 | 每文件 SHA-256 与 Linux 目录记录保存在本地验收产物 |

本地证据为 `.test-artifacts/mcp-1.5-linux-results.json`、`mcp-1.5-linux-source-check.json`、`mcp-1.5-linux-snapshot.json`、`fix-20261126-linux.json` 及对应日志。修复轮在同一 Linux 副本更新了列明的文件；旧记录不能代替 1.6 的固定源码验收，也不能据此声称 Git 基线的全部发布门禁已在 Linux 通过。

1.5 的这些记录没有覆盖 Linux 全项目覆盖率、生产构建和完整网页 E2E。该缺口纳入 [1.6 实施与验收](MCP-1.6-PLAN.md)，由本轮实际执行补齐。仅配置 CI 不计为通过。
