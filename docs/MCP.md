# MCP 接入

resume-life 提供本机 **stdio MCP Server**，使同一台机器上的 MCP Agent 能在获得用户配置后读取简历和求职数据。默认只注册只读工具、资源和提示词；不会新增网络监听端口，也不接收浏览器登录 Cookie。

## 启动与 MCP Host 配置

使用 Node.js 24.21.0 或更新的 24.x，在项目根目录安装依赖并自检：

```sh
npm ci
node scripts/mcp.mjs doctor
```

自检只检查运行时、依赖、目录与数据库文件权限，不打开、创建或迁移数据库。`databaseExists: false` 表示首次实际调用会初始化新库，请核对目录。

生成当前机器的配置（输出包含当前 Node 可执行文件的绝对路径，不包含密钥）：

```sh
node scripts/mcp.mjs config
node scripts/mcp.mjs config codex
```

第一条输出适用于使用 `mcpServers` JSON 的客户端，例如 Cursor、Claude Desktop；第二条输出可追加到 Codex 的 `~/.codex/config.toml`。生成器保留当前生效的工具白名单（包括显式空串）和服务端超时；写入与 AI 开关始终生成为 `false`，密钥不写入配置。Codex 的 `tool_timeout_sec` 为服务端超时向上取整至秒后再加 30 秒。命令只打印文本，不改客户端设置。保存后重新连接 MCP。

通用 JSON 示例：

```json
{
  "mcpServers": {
    "resume-life": {
      "command": "node",
      "args": ["D:/codespace/resume-life/scripts/mcp.mjs"],
      "env": {
        "RESUME_LIFE_DATA_DIR": "D:/codespace/resume-life/data",
        "RESUME_LIFE_MCP_WRITE_ENABLED": "false",
        "RESUME_LIFE_MCP_LLM_ENABLED": "false"
      }
    }
  }
}
```

将脚本与数据目录改为本机实际路径。建议使用生成配置中的 Node 绝对路径，避免桌面客户端 PATH 或版本管理器选择不同 Node。入口从自身位置定位项目、加载 TypeScript，不要求客户端支持 `cwd`。Host 直接运行 Node，不使用会向 stdout 打印提示的 `npm run`。普通调试可运行 `npm run --silent mcp`；等待 JSON-RPC 属于正常状态。服务无需先启动 Next.js 网页进程。

Codex TOML 示例：

```toml
[mcp_servers.resume-life]
command = "node"
args = ["D:/codespace/resume-life/scripts/mcp.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 150

[mcp_servers.resume-life.env]
RESUME_LIFE_DATA_DIR = "D:/codespace/resume-life/data"
RESUME_LIFE_MCP_WRITE_ENABLED = "false"
RESUME_LIFE_MCP_LLM_ENABLED = "false"
```

`RESUME_LIFE_DATA_DIR` 必须是绝对路径；省略或留空时默认使用项目目录下的 `data/`，应与网页保持一致。入口读取项目的 `.env.local`（文件可省略），明确传入的进程环境优先。AI 工具需要与网页使用同一个 `RESUME_LIFE_SETTINGS_KEY` 解密已保存的模型凭证，可沿用 `.env.local`；自检只显示是否存在密钥，配置生成器不输出密钥。这里不自动读取 Next.js 的其他环境文件。旧的 `node --env-file-if-exists=.env.local --experimental-sqlite --import tsx src/mcp/stdio.ts` 启动方式仍可在项目工作目录下使用。

## 权限开关

- 默认注册 27 个业务只读工具；首次开库会执行共用的初始化/迁移，每次工具调用会保存操作元数据。
- 设置 `RESUME_LIFE_MCP_WRITE_ENABLED=true` 后，服务注册 `update_application`（有限修改投递阶段/备注/终止信息）与 `set_preparation_step`（更新可手动完成的准备步骤）。投递更新的 `expectedRevision` 必须取自刚读取的 `application.revision`；计划更新要求读取计划返回的 `revision` 作为 `expectedRevision`，同时提供 `contextKey`，且计划已经生成、对应步骤可手动完成。修订令牌绑定完整内容和数据恢复世代，同毫秒修改或恢复数据后均须重新读取；不再接受仅凭 `expectedUpdatedAt` 写入。只有同时授权 `get_application` 或 `get_preparation_plan` 时，相应更新工具才会在回执中附上投递或计划详情。
- 将投递首次改为 `rejected` 时，同时提供 `terminal_stage`（`resume_screening` / `technical_interview` / `hr_interview` / `other`）和非空 `terminal_reason`（最多 1,000 字）。已终止投递可以单独更正终止信息；活动投递不能单独设置终止字段。
- 写开关还启用 `create_application`、`create_preparation_task`、`schedule_application_interview` 和 `save_ai_draft`，共 6 个业务写工具。
- `RESUME_LIFE_MCP_LLM_ENABLED=true` 独立启用 3 个生成工具：`analyze_application_jd`、`diagnose_application_resume`、`draft_interview_review`。它们通过 `safe-llm` 将相关职业资料发送给当前配置模型，返回可检查的草稿；不直接修改正式资料。
- 可选 `RESUME_LIFE_MCP_ALLOWED_TOOLS` 为逗号分隔的工具白名单。未设置表示保留总开关允许的工具；显式空串表示禁用所有工具；未知名称导致启动失败；`mcp:config`、`mcp:doctor` 与 stdio 启动会在打开数据库前使用相同规则检查白名单及超时。例如只开放投递读取与备注更新可设为 `get_application,list_applications,update_application`，同时开启写开关。白名单不能绕过总开关。对应 Resources/Prompts 也受读取能力限制；分段读取还要求对应领域的读取工具在白名单内。
- `RESUME_LIFE_MCP_TIMEOUT_MS` 设置服务端工具调用超时，默认 120000，范围 100–600000 毫秒；客户端超时应更长。取消、断连与超时会传递给模型请求，取消后的结果不会落为草稿。SQLite 争锁使用剩余时间；取得写锁后、提交前都会检查截止时间，未提交的业务修改和幂等回执一起回滚。同步 SQL 不能在执行中强制中断，已提交的修改不会因响应稍晚而报超时。

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
| `list_interview_reviews` | 只读 | 浏览投递面试轮次复盘；公司、岗位、轮次、JD 取自生成时快照，旧记录未保存时为 `null` |
| `list_practice_questions` / `list_practice_sessions` | 只读 | 浏览练习题与练习场次 |
| `list_notebook` | 只读 | 浏览错题本快照 |
| `list_project_materials` / `list_resume_versions` | 只读 | 按 `parentId` 分页发现全部材料或版本 |
| `list_application_history` / `list_preparation_tasks` / `list_application_interviews` | 只读 | 按投递 `parentId` 分页读取历史、待办及轮次 |
| `get_practice_question` / `get_interview_review` / `get_notebook_entry` | 只读 | 读取单条练习题、复盘、错题摘要及完整读取入口 |
| `read_record_section` | 只读 | 带版本校验的完整记录 JSON 分段读取 |
| `get_today_priorities` / `get_application_stats` | 只读 | 今日优先事项、投递统计；优先事项可传有效 IANA `timeZone`（省略使用默认时区）；统计仅含聚合指标及近期面试的投递 ID、公司、岗位、轮次名、时间，不含笔记、JD、会议链接或自由文本终止原因 |
| `list_mcp_operations` / `get_ai_draft` | 只读 | 查看本机调用元数据和临时草稿 |
| `update_application` | 可选写 | 设置投递阶段、备注或终止信息 |
| `set_preparation_step` | 可选写 | 更新可手动完成的岗位准备步骤 |
| `create_application` | 可选写 | 创建意向/已投递岗位，可绑定简历发布版本 |
| `create_preparation_task` / `schedule_application_interview` | 可选写 | 添加准备待办或面试轮次，校验投递修订令牌 |
| `save_ai_draft` | 可选写 | 保存已检查的草稿，校验来源版本，重复调用不重复创建 |
| `analyze_application_jd` / `diagnose_application_resume` / `draft_interview_review` | 可选模型调用 | 生成 JD 画像、简历诊断、面试复盘草稿 |

列表参数 `limit` 最大 50，使用返回的 `nextCursor` 请求下一页；响应预算可能使实际页长小于 `limit`。`get_interview` 同样支持 `limit` / `cursor`，按回合 ID 倒序默认返回最近 5 个回合。`list_practice_questions` 可用 `drillId` 精确筛选某场练习。

模拟面试的搜索、列表与详情返回绑定发布版本的简历标题；没有发布版本的历史记录回退到当前简历标题。返回的 `series_id` 与 `round_no` 标明进阶面试的系列及轮次，可通过 `series_id` 对应投递的 `interview_series_id`；单场面试的 `series_id` 为 `null`。

摘要详情 JSON 预算约 32,000 字符，列表页约 24,000 字符；长字段带 `[内容已截断]`，整体压缩带 `truncated: true`。结构化输出和兼容文本可能各携带一份相同数据。项目摘要保留最近 10 份材料，简历摘要最多列出最近 20 个版本；使用新增分页工具继续发现，使用 `read_record_section` 读全记录。准备计划及面试准备 Prompt 保留全部步骤状态。自定义待办的 `done` 在列表和详情中均为布尔值。近期面试按实际时刻排序；历史无时区的日期时间按服务主机本地时间解释，显式偏移不受主机时区影响。

`get_application.submissionContent` 指向首次投递时固定的 JD 和简历快照（未提交为 `null`），不跟随后续编辑或改绑变化。使用 `kind:"application_submission"` 和投递 ID；除 `read_record_section` 外还需 `get_application` 和 `get_resume` 权限。真实面试轮次的长备注由 `list_application_interviews` 返回的 `fullContent` 读取：使用 `kind:"application_interview"` 和轮次 ID，需该列表权限；`kind:"interview"` 是另一类模拟面试。练习场次被截断的 JD、方向和练习重点可从 `list_practice_sessions` 的 `fullContent` 用 `kind:"practice_session"` 读全；练习题及作答仍需对应题目读取权限。

## 返回结构与错误处理

所有工具声明 `outputSchema`。成功时 `structuredContent` 包含：

```json
{"ok":true,"data":{"items":[],"nextCursor":null},"meta":{"requestId":"...","durationMs":3}}
```

成功的 `content[0].text` 继续返回原始业务 JSON，兼容旧客户端。失败时 `isError=true`，文本和结构化内容均为：

```json
{"ok":false,"error":{"code":"CONFLICT","message":"投递资料已更新，请重新读取后再提交","retryable":false},"meta":{"requestId":"...","durationMs":2}}
```

错误码为 `INVALID_ARGUMENT`、`NOT_FOUND`、`CONFLICT`、`FORBIDDEN`、`CONFIGURATION`、`BUSY`、`CANCELLED`、`TIMEOUT`、`MODEL_OUTPUT`、`INTERNAL`。冲突必须重新读取并核对修改，不能盲目重试；模型并发已满或被限流返回 `BUSY`，请求超时返回 `TIMEOUT`；两者标记为可稍后重试。无法解析的 JSON-RPC 等协议错误仍由 SDK 处理。

## 完整读取、创建与草稿工作流

完整读取例子：先调用 `read_record_section({kind:"project_material",id:1})`；之后使用返回的 `nextOffset` 与 `revision` 调用 `{kind:"project_material",id:1,offset:nextOffset,expectedRevision:revision}`。直到 `nextOffset=null`，拼接所有 `text` 后解析 JSON。每段默认 4000 UTF-16 单位；边界遇到代理对时最多多返回 1 单位，避免拆分字符；资料变化或数据恢复后令牌失效，需从头读取。支持的 `kind` 以工具 schema 为准，仅允许固定业务类型，不接受 SQL、表名、文件路径。项目材料会返回与网页一致的、经过正文校验的 DOCX `tableProvenance`：字段缺省表示来源未知，`markers: []` 表示已确认无表格标签；仅变更标记也会使旧令牌失效。简历可附带 `versionId`；临时草稿的 `payload` 是经过校验的模型原始 JSON，生成响应的 `result` 为应用使用的规范化格式。

创建工具要求 8–128 位的 `idempotencyKey`（字母、数字、`._:-`）。创建投递、待办或轮次首次成功和同参数重试均只返回 `{ "id": … }`，不会回显此后编辑的内容。详情须另用相应的读取工具；下一次写入需要的投递修订令牌取自 `get_application`。相同工具内，同一键配不同参数会冲突。回执与业务创建在同一事务提交，跨进程与重启有效；删除或数据恢复后旧键不能再次创建。添加待办/安排面试还要求最新 `application.revision`；重试使用原参数，新的操作应重新读取并更换键。`dueTime`、`interview_time` 接受带时区 ISO 时间，如 `2026-12-01T10:00:00+08:00`。

AI 工作流：

1. 调用生成工具，取得 `draftId`、`sourceRevision`、`result` 与 `saved:false`。简历诊断使用投递绑定的发布版本，复盘使用已保存的逐题记录和投递快照。
2. 检查结果；长结果通过 `get_ai_draft` 和分段读取查看。
3. 需要写入正式资料时，再调用 `save_ai_draft({draftId,expectedRevision:sourceRevision})`。保存不再调用模型，会重新校验来源和结果，并将 JD/诊断关联投递或保存到对应面试轮次。

`saved:false` 表示尚未写入正式业务资料。草稿在本机临时保留 24 小时、最多 100 条；下一次生成清理过期草稿，过期或被淘汰的草稿不能再读取、保存或凭草稿 ID 重放回执；此前已保存的正式记录不受影响。仅校验本次工作流的输入、归档目标和数据世代：修改看板备注、待办不会使新草稿失效；相关 JD、诊断所用版本、复盘问题等变化或数据恢复后会拒绝保存；同一草稿仍有效时重复保存返回同一业务记录；同一轮面试的不同草稿分别保存所选结果。同一投递及简历的多次诊断沿用岗位历史，便于在网页比较。模型计量日志沿用应用机制。

## 操作记录、升级与验证

本机 `mcp_operation_logs` 最多保留最近 5000 次工具调用，包含 requestId、固定工具名、目标 ID、结果、错误码、耗时和时间；不记录参数正文、模型输出或密钥。日志在写锁繁忙时跳过，不额外阻塞工具返回；写入失败会在 stderr 留提示，不把已经成功的业务修改报告为失败。日志是排障记录，不是防篡改审计。

数据库结构升级至 v9，事务内新增 `mcp_creation_receipts`、`mcp_operation_logs`、`mcp_drafts`。三者不进入用户业务备份；业务备份继续兼容 v1–v9。恢复事务会清除临时草稿，失败时一并回滚；旧创建回执保留防重墓碑。升级代码后应重启网页与 MCP 进程。

```sh
npm run test:mcp
npm run typecheck
```

MCP 集成测试使用临时数据库和真实 stdio 子进程，覆盖不同工作目录启动、协议输出、白名单、并发/幂等、完整读取、草稿保存和取消/超时。AI 使用模拟模型响应，不产生真实模型费用。PR 的 `MCP checks` 在 Windows/Linux 执行快速检查，发布仍走完整检查流程。

## Resources 与 Prompts

Resources 提供只读 URI：`resume-life://resumes/{id}`、`resume-life://projects/{id}`、`resume-life://applications/{id}`。Prompts 提供 `prepare-for-application` 和 `review-practice-answer`，将读取本机记录并把上下文返回给 MCP Host，由 Host 自己调用其模型；resume-life MCP Server 不会在这些 Prompt 中调用 LLM。

资源发现仅展示各域第一页（最多 50 条），更多记录通过分页工具发现后按 URI 读取。Prompt 参数 ID 使用字符串，例如 `{"applicationId":"1"}` 或 `{"questionId":"1"}`；tool 参数 ID 使用数字。Prompt 中的本地资料经过不可信数据边界转义。所有业务日志写入 stderr；失败响应仅返回业务错误或可用于日志查询的参考编号。

## 安全边界

- MCP 子进程可直接读取其 OS 用户有权访问的 SQLite 数据目录。stdio 不提供远程身份认证或多租户隔离；仅配置可信 Agent，并用本机操作系统账户、文件权限和子进程管理保护数据。
- Prompt 与工具输出可能含简历、JD、项目材料、面试问题和作答等个人资料。Agent Host 可能将这些内容转发至其配置的模型服务。
- 仅显式开启可选写入或 AI 工具；本版本不提供简历发布、删除、导入、备份恢复、模型密钥读取或任意文件访问工具。
- 本机 stdio 是该功能的接入范围，不提供远程 HTTP 接入。
