# MCP 接入

resume-life 提供本机 **stdio MCP Server**，使同一台机器上的 MCP Agent 能在获得用户配置后读取简历和求职数据。默认只注册只读工具、资源和提示词；不会新增网络监听端口，也不接收浏览器登录 Cookie。

## 启动与 MCP Host 配置

先在项目根目录安装依赖：

```sh
npm ci
```

让 MCP Host 直接启动 Node 子进程（不要通过 `npm run` 启动 MCP 协议通道，因为 npm 自身会向 stdout 写入运行提示）：

```json
{
  "mcpServers": {
    "resume-life": {
      "command": "node",
      "args": ["--env-file-if-exists=.env.local", "--experimental-sqlite", "--import", "tsx", "src/mcp/stdio.ts"],
      "cwd": "D:/codespace/resume-life",
      "env": {
        "RESUME_LIFE_DATA_DIR": "D:/codespace/resume-life/data"
      }
    }
  }
}
```

将 `cwd` 与数据目录改为本机实际位置，Host 需要支持设置工作目录。若使用其他 Node 启动管理器，也必须确保该进程使用 Node.js 24.21.0 或更新的 24.x、打开 `node:sqlite`，且 stdout 仅用于 MCP JSON-RPC。普通调试可运行 `npm run --silent mcp`；启动后等待 Host 发来的 JSON-RPC 属于正常状态，按 Ctrl+C 退出。服务无需先启动 Next.js 网页进程。

`RESUME_LIFE_DATA_DIR` 必须是绝对路径；省略时默认使用当前工作目录下的 `data/`。以上启动命令会读取已有的 `.env.local`（文件可省略），明确传入的进程环境优先。AI 工具需要与网页进程使用同一个 `RESUME_LIFE_SETTINGS_KEY` 才能解密数据库中已保存的模型凭证，可从受保护的环境或已有 `.env.local` 注入；不要把真实密钥复制进 Agent 配置或提交到仓库。这里不自动读取 Next.js 的其他环境文件。

## 权限开关

- 默认不注册业务写工具；首次开库仍会执行应用共用的数据库初始化/迁移。
- 设置 `RESUME_LIFE_MCP_WRITE_ENABLED=true` 后，服务注册 `update_application`（有限修改投递阶段/备注/终止信息）与 `set_preparation_step`（更新可手动完成的准备步骤）。投递更新的 `expectedRevision` 必须取自刚读取的 `application.revision`；计划更新要求读取计划返回的 `revision` 作为 `expectedRevision`，同时提供 `contextKey`，且计划已经生成、对应步骤可手动完成。修订令牌绑定完整内容和数据恢复世代，同毫秒修改或恢复数据后均须重新读取；不再接受仅凭 `expectedUpdatedAt` 写入。
- 将投递首次改为 `rejected` 时，同时提供 `terminal_stage`（`resume_screening` / `technical_interview` / `hr_interview` / `other`）和非空 `terminal_reason`（最多 1,000 字）。已终止投递可以单独更正终止信息；活动投递不能单独设置终止字段。
- 设置 `RESUME_LIFE_MCP_LLM_ENABLED=true` 后，服务注册 `analyze_application_jd`。它通过 `safe-llm` 调用当前配置模型，对投递已保存的 JD 生成技能优先级/追问方向草稿；JD 会发送给该模型服务，草稿不保存，调用计量日志沿用应用机制。

开启可写/模型能力前，请在 MCP Host 的服务环境中明确配置相应变量，并确认 Agent 有权限执行对应工具。开关只决定能力是否注册；MCP Host 仍应根据业务风险要求用户确认写入或有费用的模型调用。

## 工具

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `search_records` | 只读 | 跨简历、项目、投递、面试和练习记录搜索 |
| `list_resumes` / `get_resume` | 只读 | 浏览简历草稿和发布版本；指定 `versionId` 可读取固定快照 |
| `list_projects` / `get_project` | 只读 | 浏览项目总结与最近材料 |
| `list_applications` / `get_application` | 只读 | 浏览投递、面试轮次、阶段历史和自定义待办 |
| `get_preparation_plan` | 只读 | 读取已有岗位准备计划，不会新建或改变完成状态 |
| `list_interviews` / `get_interview` | 只读 | 浏览模拟面试和问答记录 |
| `list_interview_reviews` | 只读 | 浏览投递面试轮次复盘 |
| `list_practice_questions` / `list_practice_sessions` | 只读 | 浏览练习题与练习场次 |
| `list_notebook` | 只读 | 浏览错题本快照 |
| `update_application` | 可选写 | 设置投递阶段、备注或终止信息 |
| `set_preparation_step` | 可选写 | 更新可手动完成的岗位准备步骤 |
| `analyze_application_jd` | 可选模型调用 | 分析投递中的 JD，返回未保存草稿 |

列表参数 `limit` 最大 50，使用返回的 `nextCursor` 请求下一页；响应预算可能使实际页长小于 `limit`。`get_interview` 同样支持 `limit` / `cursor`，按回合 ID 倒序默认返回最近 5 个回合。`list_practice_questions` 可用 `drillId` 精确筛选某场练习。

模拟面试的搜索、列表与详情返回绑定发布版本的简历标题；没有发布版本的历史记录回退到当前简历标题。返回的 `series_id` 与 `round_no` 标明进阶面试的系列及轮次，可通过 `series_id` 对应投递的 `interview_series_id`；单场面试的 `series_id` 为 `null`。

这些工具提供资料摘要：常规详情 JSON 最多约 32,000 字符，列表页约 24,000 字符；长字段带 `[内容已截断]`，整体压缩时带 `truncated: true`。优先缩短文字再裁剪集合；版本和材料的完整性标记按最终返回数量计算。项目最多返回最近 10 份材料，简历最多列出最近 20 个发布版本，更多原文通过应用查看；已知旧版本 ID 仍可交给 `get_resume`。准备计划及面试准备 Prompt 保留所有步骤的完成和阻塞状态。工具不会开放任意 SQL 或本机文件读取。

## Resources 与 Prompts

Resources 提供只读 URI：`resume-life://resumes/{id}`、`resume-life://projects/{id}`、`resume-life://applications/{id}`。Prompts 提供 `prepare-for-application` 和 `review-practice-answer`，将读取本机记录并把上下文返回给 MCP Host，由 Host 自己调用其模型；resume-life MCP Server 不会在这些 Prompt 中调用 LLM。

资源发现仅展示各域第一页（最多 50 条），更多记录通过分页工具发现后按 URI 读取。Prompt 参数 ID 使用字符串，例如 `{"applicationId":"1"}` 或 `{"questionId":"1"}`；tool 参数 ID 使用数字。Prompt 中的本地资料经过不可信数据边界转义。所有业务日志写入 stderr；失败响应仅返回业务错误或可用于日志查询的参考编号。

## 安全边界

- MCP 子进程可直接读取其 OS 用户有权访问的 SQLite 数据目录。stdio 不提供远程身份认证或多租户隔离；仅配置可信 Agent，并用本机操作系统账户、文件权限和子进程管理保护数据。
- Prompt 与工具输出可能含简历、JD、项目材料、面试问题和作答等个人资料。Agent Host 可能将这些内容转发至其配置的模型服务。
- 仅显式开启可选写入或 AI 工具；本版本不提供简历发布、删除、导入、备份恢复、模型密钥读取或任意文件访问工具。
- 该版本只支持同机 stdio，不支持远程 Agent 直接 HTTP 连接。若将来增加远程传输，需单独设计认证、授权范围、Origin/Host 校验和网络暴露策略。
