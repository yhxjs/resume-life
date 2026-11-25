# MCP 接入

resume-life 提供本机 **stdio MCP Server**，使同一台机器上的 MCP Agent 能在获得用户配置后读取简历和求职数据。默认只注册只读工具、资源和提示词；不会新增网络监听端口，也不接收浏览器登录 Cookie。

## 启动与 MCP Host 配置

使用 Node.js 24.21.0 或更新的 24.x，在项目根目录安装依赖并自检：

```sh
npm ci
node scripts/mcp.mjs doctor
```

自检检查运行时、依赖、目录与数据库文件权限，并列出当前配置实际启用的 `enabledTools`、`toolCount` 及按只读/写入/模型调用分组的 `capabilities`；结果同时考虑总开关与工具白名单。自检不打开、创建或迁移数据库。`databaseExists: false` 表示首次实际调用会初始化新库，请核对目录。

生成当前机器的配置（输出包含当前 Node 可执行文件的绝对路径，不包含密钥）：

```sh
node scripts/mcp.mjs config
node scripts/mcp.mjs config codex
node scripts/mcp.mjs config codex collaboration
```

第一条输出适用于使用 `mcpServers` JSON 的客户端，例如 Cursor、Claude Desktop；第二条输出可追加到 Codex 的 `~/.codex/config.toml`。不指定预设时，生成器保留当前生效的工具白名单（包括显式空串）和服务端超时，写入与 AI 开关均为 `false`。第三条选择外部模型协作预设，启用业务写入，服务端模型调用仍关闭。密钥不写入配置。Codex 的 `tool_timeout_sec` 为服务端超时向上取整至秒后再加 30 秒。命令只打印文本，不改客户端设置。保存后重新连接 MCP。

可用预设：

| 预设 | 工具数 | 用途 |
| --- | --- | --- |
| `readonly` | 63 | 资料、训练状态、生成上下文、差异预览、复习及运行状态查询 |
| `preparation` | 70 | 资料查询、投递、准备计划、待办、真实面试记录和关联管理 |
| `collaboration` | 99 | 全部只读与业务写工具，包括训练、资料创作及外部模型协作 |
| `training` | 47 | 练习、错题与复习、单场和三轮面试、求职工具；包含所需来源读取 |
| `authoring` | 42 | 自我介绍、项目材料及总结、简历草稿和岗位资料的外部结果提交 |

使用 `config json <预设>` 或 `config codex <预设>` 输出具体白名单；已有 `RESUME_LIFE_MCP_ALLOWED_TOOLS` 会与预设取交集，显式空串保持为空。五种预设均设置 `RESUME_LIFE_MCP_LLM_ENABLED=false`；应用模型的三个生成工具通过独立开关启用。

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

- 默认注册 63 个只读工具；首次开库会执行共用的初始化/迁移，每次工具调用会保存操作元数据。
- 设置 `RESUME_LIFE_MCP_WRITE_ENABLED=true` 后，服务注册 `update_application`（有限修改投递阶段/备注/终止信息）与 `set_preparation_step`（更新可手动完成的准备步骤）。投递更新的 `expectedRevision` 必须取自刚读取的 `application.revision`；计划更新要求读取计划返回的 `revision` 作为 `expectedRevision`，同时提供 `contextKey`，且计划已经生成、对应步骤可手动完成。修订令牌绑定完整内容和数据恢复世代，同毫秒修改或恢复数据后均须重新读取；不再接受仅凭 `expectedUpdatedAt` 写入。只有同时授权 `get_application` 或 `get_preparation_plan` 时，相应更新工具才会在回执中附上投递或计划详情。
- 将投递首次改为 `rejected` 时，同时提供 `terminal_stage`（`resume_screening` / `technical_interview` / `hr_interview` / `other`）和非空 `terminal_reason`（最多 1,000 字）。已终止投递可以单独更正终止信息；活动投递不能单独设置终止字段。
- 写开关共启用 36 个业务写工具。除投递、准备、草稿、错题与复习外，可独立授权内容生成结果保存、简历草稿修改、练习及面试训练、进阶系列和求职工具。`preparation` 预设不授予这些内容创作与训练写权限。
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
| `get_application_interview_questions` | 只读 | 读取真实面试逐题记录、来源版本与写入修订令牌 |
| `list_interviews` / `get_interview` | 只读 | 浏览模拟面试和问答记录 |
| `list_interview_reviews` | 只读 | 浏览投递面试轮次复盘；公司、岗位、轮次、JD 取自生成时快照，旧记录未保存时为 `null` |
| `list_practice_questions` / `list_practice_sessions` | 只读 | 浏览练习题与练习场次 |
| `list_notebook` | 只读 | 浏览错题本快照 |
| `list_project_materials` / `list_resume_versions` | 只读 | 按 `parentId` 分页发现全部材料或版本 |
| `list_application_history` / `list_preparation_tasks` / `list_application_interviews` | 只读 | 按投递 `parentId` 分页读取历史、待办及轮次 |
| `get_practice_question` / `get_interview_review` / `get_notebook_entry` | 只读 | 读取单条练习题、复盘、错题摘要及完整读取入口 |
| `read_record_section` | 只读 | 带版本校验的完整记录 JSON 分段读取 |
| `get_today_priorities` / `get_application_stats` | 只读 | 今日优先事项、投递统计；优先事项可传有效 IANA `timeZone`（省略使用默认时区）；统计仅含聚合指标及近期面试的投递 ID、公司、岗位、轮次名、时间，不含笔记、JD、会议链接或自由文本终止原因 |
| `list_mcp_operations` | 只读 | 按请求编号、工具、目标、状态或错误码定位本机调用元数据 |
| `list_ai_drafts` / `get_ai_draft` / `get_ai_generation_request` | 只读 | 发现草稿、读取内容及查询生成请求的进度、有效期和已保存记录 |
| `update_application` | 可选写 | 设置投递阶段、备注或终止信息 |
| `set_preparation_step` | 可选写 | 更新可手动完成的岗位准备步骤 |
| `generate_preparation_plan` | 可选写 | 根据已保存的岗位资料生成或刷新准备计划，不调用模型 |
| `create_application` | 可选写 | 创建意向/已投递岗位，可绑定简历发布版本 |
| `create_preparation_task` / `schedule_application_interview` | 可选写 | 添加准备待办或面试轮次，校验投递修订令牌 |
| `update_preparation_task` / `reschedule_application_interview` | 可选写 | 完成、重开或编辑自定义待办，以及为真实面试改期 |
| `save_application_interview_questions` | 可选写 | 替换真实面试的提问、回答、卡点和反馈，校验逐题记录修订令牌 |
| `save_ai_draft` | 可选写 | 保存已检查的草稿，校验来源版本，重复调用不重复创建 |
| `analyze_application_jd` / `diagnose_application_resume` / `draft_interview_review` | 可选模型调用 | 生成 JD 画像、简历诊断、面试复盘草稿 |

列表参数 `limit` 最大 50，使用返回的 `nextCursor` 请求下一页；响应预算可能使实际页长小于 `limit`。`get_interview` 同样支持 `limit` / `cursor`，按回合 ID 倒序默认返回最近 5 个回合。`list_practice_questions` 可用 `drillId` 精确筛选某场练习。

模拟面试的搜索、列表与详情返回绑定发布版本的简历标题；没有发布版本的历史记录回退到当前简历标题。返回的 `series_id` 与 `round_no` 标明进阶面试的系列及轮次，可通过 `series_id` 对应投递的 `interview_series_id`；单场面试的 `series_id` 为 `null`。

摘要详情 JSON 预算约 32,000 字符，列表页约 24,000 字符；长字段带 `[内容已截断]`，整体压缩带 `truncated: true`。结构化输出和兼容文本可能各携带一份相同数据。项目摘要保留最近 10 份材料，简历摘要最多列出最近 20 个版本；使用新增分页工具继续发现，使用 `read_record_section` 读全记录。准备计划及面试准备 Prompt 保留全部步骤状态。自定义待办的 `done` 在列表和详情中均为布尔值。近期面试按实际时刻排序；历史无时区的日期时间按服务主机本地时间解释，显式偏移不受主机时区影响。

`get_application.submissionContent` 指向首次投递时固定的 JD 和简历快照（未提交为 `null`），不跟随后续编辑或改绑变化。使用 `kind:"application_submission"` 和投递 ID；除 `read_record_section` 外还需 `get_application` 和 `get_resume` 权限。真实面试轮次的长备注由 `list_application_interviews` 返回的 `fullContent` 读取：使用 `kind:"application_interview"` 和轮次 ID，需该列表权限；`kind:"interview"` 是另一类模拟面试。练习场次被截断的 JD、方向和练习重点可从 `list_practice_sessions` 的 `fullContent` 用 `kind:"practice_session"` 读全；练习题及作答仍需对应题目读取权限。

新增业务工具：

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `list_application_preparation_resources` | 只读 | 按类型分页查询关联或候选资料，返回关联版本和完整正文入口 |
| `list_resume_diagnoses` / `get_resume_diagnosis` | 只读 | 诊断历史、完整报告和生成时简历快照 |
| `get_jd_portrait` / `get_intro` / `get_interview_series` | 只读 | 画像、自我介绍双版原稿、进阶面试及各轮 ID |
| `get_ai_workflow_context` | 只读 | 外部模型使用的来源令牌、上下文、JSON 结果 schema 和格式说明 |
| `list_review_cards` / `get_review_card` / `get_review_submission` | 只读 | 到期复习、题目快照、分页作答历史和请求结果核对 |
| `get_mcp_status` | 只读 | 版本、有效工具、草稿与生成请求计数 |
| `set_preparation_resource` | 写入 | 使用列表的 `revision` 关联或取消关联指定资料 |
| `update_application_interview` | 写入 | 修改状态、轮次名称、时间、地点、会议链接、提醒和备注 |
| `submit_ai_draft` | 写入 | 严格校验外部 Agent 的结构化结果并保存临时草稿 |
| `bookmark_practice_question` / `save_notebook_note` | 写入 | 收藏原题快照、保存独立补充笔记 |
| `submit_review` | 写入 | 使用复习进度版本和 UUID 请求编号提交复习 |
| `maintain_mcp_state` | 写入 | 有界清理过期草稿和不可用正文缓存，保留请求墓碑 |

准备资料的 `kind` 为 `diagnosis`、`portrait`、`intro`、`interview`、`series` 或 `notebook`。`candidates:true` 查候选，默认查关联；关联更新的 `expectedRevision` 取自该列表。`list_resume_diagnoses` 使用 `resumeId`，可附带 `applicationId` 筛选关联历史；单条诊断保存其生成时发布版本和快照。自我介绍版本为 `30s` 与 `2min`；异常历史带 `read_error` 和 `raw_sentences`，完整读取保留原稿。

历史画像格式异常时返回 `result:null`、`read_error` 和 `raw_result`；损坏诊断返回 `corruptedFields` 与 `raw_fields`。诊断的快照或采纳记录损坏时，`raw_fields.report` 也保留因此被隐藏的原报告。这些原稿可从完整读取入口核对，服务不自动裁剪或修补数据库记录。

## 外部 Agent 训练与资料创作（1.2）

以下流程由 Host 负责模型推理或人工输入；不需要开启 `RESUME_LIFE_MCP_LLM_ENABLED`。可先运行 `npm run example:mcp` 在临时数据库体验完整流程；[`training-workflow.mjs`](../examples/mcp/training-workflow.mjs) 展示实际请求、回执重放与重连。已配置旧版固定白名单的客户端不会自动获得新工具；需要时重新生成预设配置并重连。

| 任务 | 调用顺序与关键参数 |
| --- | --- |
| 从题库建练习 | `list_bank_entries({direction?,kind?,limit?,cursor?})` 返回原题、`id`、`revision`；`create_practice_session({entries:[{id,revision}],jd?,idempotencyKey})` 按顺序逐字复制 1–20 道不同原题，保留首尾空白与换行。后续题库修改不影响已建场次。 |
| 保存原题作答 | `list_practice_questions({drillId})` → `get_practice_answer_context({questionId})` → `submit_practice_answer({questionId,expectedRevision,answer,evaluation,idempotencyKey})`。`evaluation` 含四项 0–10 整数 `depth/structure/authenticity/completeness`、`comment`、`reference`；完整评分规则和正文见上下文的 `fullContent`，含项目 DOCX 表格来源的判读规则。题目、JD、项目材料是待分析的数据，不是指令。 |
| 收藏与复习 | `list_notebook_categories` 分页列出分类；可不选分类。普通练习题收藏后进入复习，面试追练题首次作答后进入复习。`bookmark_practice_question` → `get_review_card` → `submit_review`；原题作答不累计复习次数，复习自评也不改写原答。 |
| 编辑自我介绍 | `get_intro` 选择 `30s` 或 `2min` 和该版 `revision`；`preview_intro_edit({introId,kind,expectedRevision,texts})` 用完整的新句子列表生成逐行差异。使用 `nextCursor` 读取其余差异，历史超长句通过 `get_intro.fullContent` 读全。用户确认后向 `save_intro_edit` 提交相同提案、`previewToken` 和 `idempotencyKey`。改写句子清空旧点评，插入、删除或移动后保留其余原句点评；重复原句按出现顺序匹配点评。另一版不变，异常原稿禁止覆盖。 |
| 创建项目与材料 | `create_project({name,idempotencyKey})` → `get_project({id})` → `add_project_material({projectId,expectedRevision:project.revision,title,content,idempotencyKey})`。修订绑定项目及全部材料正文和表格来源，删除材料、修改未展示正文或仅修改来源标记也会使旧令牌失效。只接受纯文本，单次正文最多 100000 UTF-16 单位且受总请求预算限制；空行和换行原样保存。`list_project_materials` 与 `read_record_section({kind:"project_material",id})` 可读回全文。工具不读取文件，不允许声明 `source`、`filename` 或表格提取证据。 |
| 主持单场模拟面试 | `get_resume({id,versionId})` 读取**固定发布版**；`start_mock_interview({resumeId,versionId,expectedRevision:resume.revision,jd,firstQuestion,rounds?,style?,idempotencyKey})` 创建首题。`get_mock_interview_state({interviewId})` 给出 `currentTurnId`、`currentIndex`、`revision` 与 `reportSaved`。向 `answer_mock_interview` 提交 `interviewId,turnId,expectedRevision,answer,evaluation,idempotencyKey`，评价含四项评分、`comment,next_kind,next_question`，非末题须提供未问过的下一题。完成末题后仍须显式保存报告。 |
| 结束模拟面试 | 至少有一次作答后，可提前结束。用最新状态调用 `finish_mock_interview({interviewId,expectedRevision,report,idempotencyKey})`；`report` 提供 `jd_match,strengths,weaknesses,suggestions`，挖掘风格还需 `mining_summary`，可附 `evaluator_report`。挖掘总结的六项事实文本均须提供，未知事实允许空字符串；仍须有有效事实或待核实事项。四维平均分按已保存原答计算。`get_interview` 可核对正式报告。进阶系列不接受这些写入。 |

练习评分的 `revision` 同时绑定题目、原答、背景和完整评分规则；评分规则更新后，用旧上下文提交新的评分会返回 `CONFLICT`，须重新读取评分依据。

网页完成题库练习后点击「再来一套新题」，会沿用原场次保存的选题和背景，支持没有方向或 JD、跨方向以及原题库条目已删除的场次。创建或重练时，任一选题只含空白、不可见字符或标点则整次拒绝；原题库内容继续保留。生成过程中原题或背景发生变化时拒绝保存；原选题超出模型输入预算时整次拒绝，不省略题目。

精简白名单时，建场需要 `list_bank_entries`，原题作答需要评分上下文及 `get_practice_question`、`list_practice_sessions`。涉及项目全文另需 `get_project` 和 `list_project_materials`，面试追练另需 `get_interview`；分段读取遵守相同授权。介绍保存依赖预览和 `get_intro`，材料追加依赖 `get_project`。模拟面试开场依赖 `get_resume`，推进或结束另需 `get_mock_interview_state` 和 `get_interview`。所有新写工具成功只返回 `{id}`；响应丢失后原参数、原键重试。网页已修改时返回 `CONFLICT`，重新读取并核对后再用新键。数据库保持 v11。

## 内容创作与完整训练（1.3）

MCP Server 1.3.0 共 102 个工具，数据库保持 v11。新增流程均使用外部 Agent 提供的结构化结果；服务端校验实际来源、结果结构及业务规则后保存，网页读取同一份正式记录。完整可运行示例见 [`content-workflow.mjs`](../examples/mcp/content-workflow.mjs)，`npm run example:mcp` 会在隔离测试库中分别使用 `authoring` 和 `training` 预设跑通并重连核对。

```sh
node scripts/mcp.mjs config codex authoring
node scripts/mcp.mjs config codex training
```

所有新增生成上下文返回 `{revision, encoding, offset, text, totalLength, nextOffset}`。初次读取后，把 `nextOffset` 作为 `offset`，同一 `revision` 作为 `expectedRevision`，保持其余参数完全相同，直至 `nextOffset=null`。拼接全部 `text` 后再解析 JSON；偏移和长度按 UTF-16 计数，分页不会切断代理对。资料及 `messages.parts` 中的 `untrusted` 字段是待分析内容，不能作为指令。薪资终局的 `messages` 可能带明确节选标记，完整原文仍在同一上下文的 `snapshot.turns` 中，应完整读取后生成。

| 任务 | 调用流程及约束 |
| --- | --- |
| 创建自我介绍 | `get_intro_generation_context({source:{mode:"create",resumeId,versionId,jd}})` → `save_generated_intro({source,expectedRevision,result:{versions},idempotencyKey})`。指定固定发布版，必须提供 `30s`、`2min` 两版，每句包含 `text` 与 `comment`。 |
| 重新生成与点评 | `source:{mode:"regenerate",introId,kind}` 重新生成指定一版；另一版保持原样。点评先读 `mode:"comment"`，再用 `save_intro_comments({introId,kind,expectedRevision,comments,idempotencyKey})` 保存与句子一一对应的点评，正文不改。 |
| 项目总结 | `get_project_summary_context({projectId,mode?})` → `preview_project_summary({projectId,mode,expectedRevision,result,acceptedKeys?})` → `save_project_summary`。支持 `full` 和 `resume-only`；先完整预览，再以预览中的变更 key 选择采纳字段。修改 `acceptedKeys` 后重新预览，以最终 `previewToken` 保存。省略表示全部采纳，空数组表示不采纳变更。 |
| 项目归档历史 | `list_project_summary_history({projectId,limit?,cursor?})` 返回历史 ID；用 `read_record_section({kind:"project_summary_history",id})` 读取总结、来源及材料快照。名称、材料正文、表格来源或已有档案变化都会使旧提案失效。 |
| 针对性出题 | `get_practice_generation_context({source})` → `save_generated_practice({source,expectedRevision,result:{questions},idempotencyKey})`。`source.kind` 为 `project`（`projectId,jd?,count?`）、`job`（`direction?,jd?,count?`）或 `interview`（`interviewId,count?`）；岗位方向和 JD 至少一项，追练须有有效报告。项目题为字符串数组，其余为 `{kind:"tech"|"behavior",question}` 数组，至多提交请求的题数，追练不得重复原题。保存后沿用原题作答、错题和复习工具。 |
| 重答、参考与反问 | `get_interview_training_context({source})` → `save_interview_training_result({source,expectedRevision,result,idempotencyKey})`。`retry` 需 `interviewId,turnId,answer`；`reference` 需 `interviewId,turnId`；`reverse` 需 `interviewId,question`。重答追加独立历史，报告仍按原答计算；参考答案同步错题快照；反问仅保存一次，须在本场报告前完成。 |
| 三轮进阶面试 | `get_interview_series_context` 的 `source.kind:"create"` 使用 `resumeId,versionId,jd,rounds`，`rounds` 是每场题数；`save_interview_series_result` 提交 `{question}`，返回系列 ID。逐轮用 `get_series_interview_state`、`answer_series_interview`、`finish_series_interview`，同时携带 `seriesId,interviewId`。 |
| 系列推进与总评 | 上轮已保存报告后，以 `source:{kind:"advance",seriesId,fromInterviewId}` 读取上下文并提交下一场 `{question}`，此时返回新场次 ID。三场全部完成后，以 `source:{kind:"finalize",seriesId}` 提交 `{verdict,strengths,weaknesses,suggestions}`，返回系列 ID。总分由各轮正式报告计算；不同进程竞争推进只允许一个成功。 |
| 创建或复制简历草稿 | `create_resume_draft({title,idempotencyKey})` 创建默认模块；复制需附 `source:{resumeId,expectedRevision}`，修订来自 `get_resume_draft_context({resumeId})`。 |
| 修改简历草稿 | `get_resume_draft_context` 提供全部模块与 `moduleSchema` → `preview_resume_draft_edit({resumeId,expectedRevision,title?,modules})` → `save_resume_draft_edit`。每个提交模块含 `key,type,label,content`，条目与子项使用稳定且唯一的 ID；未提交模块保留，新 key 追加，已有模块不能改变类型。预览展示规范化后的实际值，保存需相同提案、`previewToken` 和 `idempotencyKey`。发布仍通过网页；现有发布版和投递快照保持稳定。 |
| 求职辅助工具 | `get_career_workflow_context({source})` 提供来源、规则和对应的 `resultSchema` → `save_career_result({source,expectedRevision,result,idempotencyKey})`。支持 `defense`、`defense-drill`、`gap`、`salary-create`、`salary-turn`、`salary-finalize` 六种流程，具体字段由工具输入契约列出。排雷引用须匹配原文；薪资开场评分固定为 5，终局点评只能引用真实候选人回合。 |
| 发现与完整回读 | `list_intros`、`list_jd_portraits`、`list_interview_series` 支持 `q,limit,cursor`，介绍与系列还可按 `resumeId` 筛选；`list_bank_directions` 返回方向和题数。`list_career_records({kind,q?,limit?,cursor?})` 的 kind 为 `resume_defense`、`career_gap_remedy` 或 `salary_negotiation`，完整记录用 `get_career_record({kind,id,...分页参数})` 读取，原始 JSON 文本保持原样。 |

项目总结和简历草稿预览的续页参数放在 `page:{offset,expectedRevision}` 中；顶层 `expectedRevision` 始终指向生成来源。所有保存返回 `{id}`；项目总结返回历史 ID，防御演练及谈薪回合返回子记录 ID，其余 ID 含义见上表。原请求与原幂等键用于重试；更换内容必须使用新键并重新读取来源，不能以新键绕过旧来源冲突。备份恢复后旧修订和回执失效，客户端须读取恢复后的正式记录再决定下一步。

精简权限时，生成保存必须同时授权对应上下文读取。介绍创建需 `get_resume`，重生成另需 `get_intro`；点评需 `get_intro`。项目总结需 `get_project,list_project_materials,preview_project_summary`；简历复制和修改需 `get_resume,get_resume_draft_context`，保存修改还需预览工具。面试训练需 `get_interview,get_resume`，系列推进另需 `get_interview_series`；逐轮提交还需系列状态工具。排雷使用发布简历时需 `get_resume`；演练和谈薪推进需 `get_career_record`。预设已包含这些依赖。

## 返回结构与错误处理

全部 102 个工具声明具体 `outputSchema`，包括分页条目、业务字段、不同草稿类型的结果和恢复状态，成功响应在服务端按对应 schema 校验。JSON schema 用 `oneOf` 约束互斥的成功/失败结构：成功必须包含 `data`，失败必须包含 `error`。输出 ID 使用安全整数约束，兼容历史备份中的零或负数 ID。成功时 `structuredContent` 包含：

```json
{"ok":true,"data":{"items":[],"nextCursor":null},"meta":{"requestId":"...","durationMs":3}}
```

成功的 `content[0].text` 继续返回原始业务 JSON，兼容旧客户端。失败时 `isError=true`，文本和结构化内容均为：

```json
{"ok":false,"error":{"code":"CONFLICT","message":"投递资料已更新，请重新读取后再提交","retryable":false},"meta":{"requestId":"...","durationMs":2}}
```

错误码为 `INVALID_ARGUMENT`、`NOT_FOUND`、`CONFLICT`、`FORBIDDEN`、`CONFIGURATION`、`BUSY`、`CANCELLED`、`TIMEOUT`、`MODEL_OUTPUT`、`INTERNAL`。冲突必须重新读取并核对修改，不能盲目重试；模型并发已满、同一生成键仍在执行或被限流返回 `BUSY`，请求超时返回 `TIMEOUT`。`retryable:true` 表示可稍后使用原参数和同一幂等键重试，适用于尚未认领的繁忙/超时请求及仍在执行的生成键。生成键认领后因繁忙或超时未完成，返回原错误码和 `retryable:false`：先查询 `get_ai_generation_request` 核对持久状态，同一键不会重新调用模型，确认需要重新生成后再使用新键。失败状态写入受锁竞争影响时仍需查询核对，不能仅凭超时判断请求已撤销。详见下文。无法解析的 JSON-RPC 等协议错误仍由 SDK 处理。

| 核心输出 | schema 明确声明的字段 |
| --- | --- |
| 投递详情 | 投递 ID、阶段、备注、`revision`、待办、真实面试轮次及完整读取入口 |
| 准备计划 | `application`、`contextKey`、`revision`、`generatedAt`、`stale` 及全部步骤状态 |
| 分页结果 | `items`、`nextCursor`；待办的 `done` 为布尔值，轮次包含时间及所属投递 |
| 分段读取 | `kind`、`id`、`text`、`offset`、`nextOffset`、`revision`、编码和总长度 |
| 草稿及生成状态 | 草稿 ID、来源版本、幂等键、到期时间、状态与已保存记录引用 |

兼容字段继续保留。写工具只有获准读取对应详情时才返回投递或计划详情，其他写回执只包含操作所需的 ID 或状态。

## 完整读取、创建与草稿工作流

完整读取例子：先调用 `read_record_section({kind:"project_material",id:1})`；之后使用返回的 `nextOffset` 与 `revision` 调用 `{kind:"project_material",id:1,offset:nextOffset,expectedRevision:revision}`。直到 `nextOffset=null`，拼接所有 `text` 后解析 JSON。每段默认 4000 UTF-16 单位；边界遇到代理对时最多多返回 1 单位，避免拆分字符；资料变化或数据恢复后令牌失效，需从头读取。支持的 `kind` 以工具 schema 为准，仅允许固定业务类型，不接受 SQL、表名、文件路径。项目材料会返回与网页一致的、经过正文校验的 DOCX `tableProvenance`：字段缺省表示来源未知，`markers: []` 表示已确认无表格标签；仅变更标记也会使旧令牌失效。简历可附带 `versionId`；临时草稿的 `payload` 是经过校验的模型原始 JSON，生成响应的 `result` 为应用使用的规范化格式。

创建工具要求 8–128 位的 `idempotencyKey`（字母、数字、`._:-`）。创建投递、待办或轮次首次成功和同参数重试均只返回 `{ "id": … }`，不会回显此后编辑的内容。详情须另用相应的读取工具；下一次写入需要的投递修订令牌取自 `get_application`。相同工具内，同一键配不同参数会冲突。回执与业务创建在同一事务提交，跨进程与重启有效；删除或数据恢复后旧键不能再次创建。添加待办/安排面试还要求最新 `application.revision`；重试使用原参数，新的操作应重新读取并更换键。`dueTime`、`interview_time` 接受带时区 ISO 时间，如 `2026-12-01T10:00:00+08:00`。

准备计划先用 `get_preparation_plan({applicationId})` 取得 `revision` 和 `contextKey`，再调用 `generate_preparation_plan({applicationId,expectedRevision:revision,contextKey})`。同岗位上下文刷新会保留手动完成项；JD、绑定简历版本等上下文改变时重新建立进度。生成后的手动步骤仍使用 `set_preparation_step`。

自定义待办用 `update_preparation_task({applicationId,taskId,expectedRevision,done:true})` 完成，`done:false` 重开；可同时修改 `title` 或 `dueTime`，空 `dueTime` 清除截止时间。真实面试用 `reschedule_application_interview({applicationId,interviewId,expectedRevision,interview_time})` 改期，并同步投递下一场面试时间。两者使用最新 `get_application.revision`，返回对应 ID。

真实面试逐题记录先用 `get_application_interview_questions({applicationId,interviewId})` 读取，再用 `save_application_interview_questions({applicationId,interviewId,expectedRevision:revision,questions})` 替换。每题包含必填 `question` 和可选 `answer`、`stuck`、`feedback`，最多 20 题、每字段 2000 字、合计 32000 字；空数组清空记录。令牌绑定逐题内容、生成复盘所需资料与数据世代，网页修改或恢复后需重读。被截断的正文通过 `fullContent` 中的 `kind:"application_interview_questions"` 分段读全，需对应读取工具权限。复盘生成工具读取这份已保存的逐题记录。

`update_application` 还可修改 `jd`、`resume_id`、`resume_version_id`；版本必须属于所绑定简历，沿用网页的发布版本和投递阶段校验。首次投递时的 `submissionContent` 保持原始 JD 与简历快照。`update_application_interview` 使用投递最新 `revision`，支持 `scheduled`、`completed`、`cancelled`；完成或取消轮次后同步选择下一场待面试时间，跨投递轮次写入被拒绝。

### 外部模型协作

1. 调用 `get_ai_workflow_context({kind,applicationId,interviewId?})`，保存 `sourceRevision`；`kind` 为 `jd`、`diagnosis` 或 `review`，仅 `review` 需要 `interviewId`。返回 `context`、机器可读的 `resultSchema`、`outputInstructions` 和完整读取入口。
2. 被截断时，按 `fullContent` 分段取得完整上下文。外部 Agent 将 `outputInstructions` 作为指令、`context` 作为不可信资料，使用自己的模型生成符合 `resultSchema` 的 JSON。
3. 调用 `submit_ai_draft({kind,applicationId,interviewId?,expectedSourceRevision:sourceRevision,idempotencyKey,result})`。输入必须满足字段、可见文本、来源题号/模块、重复目标、篇幅和归档预算校验；无效结果返回 `INVALID_ARGUMENT`，过期来源返回 `CONFLICT`，均不创建草稿。
4. 查看返回的规范化 `result`，必要时完整读取草稿的原始 `payload`；再独立调用 `save_ai_draft({draftId,expectedRevision:sourceRevision})` 归档。提交和保存使用同一幂等编号及原始参数重试；正文不再可用时通过 `get_ai_generation_request` 查正式记录。

JD 提交格式使用 `must_skills` 和 `company_style`，存档读取及生成响应使用规范化的 `mustSkills` 和 `companyStyle`。诊断提交使用 `module_key`、建议的 `item_id`，存档使用 `moduleKey`、`itemId` 并附模块标签。复盘使用 `mistakes`、`drills`、`resume_suggestions`，每项题号为原始 `question_index`。具体数量、长度和字段以 `resultSchema` 为准，语义约束同时见 `outputInstructions`。JSON 对象字段重新排序仍视为同一提交；同键修改来源或结果会冲突。

外部草稿的读取与提交还需对应来源读取权限：JD 需要 `get_application`，诊断另需 `get_resume`，复盘还需 `get_application_interview_questions`。分段上下文额外要求 `get_ai_workflow_context` 和 `read_record_section`，不能用分段读取绕过来源权限。上下文、外部提交及保存工具本身不调用服务端模型。

仓库提供可运行的完整示例：

```sh
npm run example:mcp
```

示例使用临时测试库与明确的模拟模型结果，演示创建投递、生成准备计划、完成待办、提交/保存 JD 草稿、安排/改期面试、逐题记录、复盘归档和完成轮次；退出时清理临时数据。[`examples/mcp/client.mjs`](../examples/mcp/client.mjs) 提供 stdio 连接、统一错误处理和完整 UTF-16 分段读取；[`examples/mcp/workflow.mjs`](../examples/mcp/workflow.mjs) 可接入返回结构化 `data` 的 SDK 或真实 Host 调用适配器。实际使用时指定自己的绝对数据目录并提供模型结果。

### 复习与独立笔记

`list_review_cards({scope:"due",timeZone:"Asia/Hong_Kong"})` 复用网页的复习日期和排期，`scope:"all"` 查询全部；`source` 可筛选 `notebook`、`remedial` 或 `all`。`get_review_card({id,limit,cursor,timeZone?})` 返回题目原稿、当前 `review_count` 和分页复习历史，顶层 `fullContent` 读取完整题目，并携带指定的 `timeZone`；分段读取时继续传入该时区，让新卡日期与摘要一致。每条 `attempts` 的 `fullContent` 用 `kind:"review_attempt"` 和作答 ID 读取完整回答及原 `request_id`。这两种完整读取都需 `get_review_card` 权限，历史继续使用 `nextCursor`。

提交前保存 UUID `requestId`，调用 `submit_review({cardId,answer,grade,expectedReviewCount:review_count,requestId,timeZone?})`，`grade` 为 `again`、`hard`、`good`、`easy`。相同编号和参数重试不会重复累计次数；旧进度的新请求返回 `CONFLICT`。响应丢失后用 `get_review_submission({cardId,requestId})` 精确核对，网页提交和 MCP 提交更新同一份进度。其 `fullContent` 使用 `kind:"review_submission"`、卡片 ID 和同一 `requestId` 读取完整结果；分段读取的每一段都必须携带 `requestId`，并需 `get_review_submission` 权限。

`bookmark_practice_question({source,sourceId,categoryId?,idempotencyKey})` 的 `sourceId` 在 `source:"drill"` 时是练习题 ID，在 `source:"interview"` 时是模拟面试回合 ID。收藏复制完整问题、原答、参考与反馈快照并关联复习卡。补充笔记单独存储：先读取 `get_notebook_entry` 的 `noteRevision`，再调用 `save_notebook_note({notebookId,content,expectedRevision:noteRevision,idempotencyKey})`；最多 20000 字，空串清空补充内容。笔记不会覆写原答和反馈，与用户业务数据一起备份，并随错题删除级联清理。网页 API `GET/PUT /api/notebook/[id]/note` 使用同一个领域模块和版本校验。

### 服务端模型草稿

AI 工作流：

1. 调用生成工具时提供事先生成的 `idempotencyKey`，取得 `draftId`、`sourceRevision`、同一键、`result` 与 `saved:false`。简历诊断使用投递绑定的发布版本，复盘使用已保存的逐题记录和投递快照。键格式同创建工具；为了兼容旧客户端，省略时服务生成 UUID，但客户端丢失响应后就无法按事先已知的键查询。
2. 检查结果；长结果通过 `get_ai_draft` 和分段读取查看。
3. 需要写入正式资料时，再调用 `save_ai_draft({draftId,expectedRevision:sourceRevision})`。保存不再调用模型，会重新校验来源和结果，并将 JD/诊断关联投递或保存到对应面试轮次。

`saved:false` 表示尚未写入正式业务资料。草稿在本机临时保留 24 小时、最多 100 条；生成和后台维护清理过期草稿，过期或被淘汰的草稿不能再读取、保存或凭草稿 ID 重放回执；此前已保存的正式记录不受影响。仅校验本次工作流的输入、归档目标和数据世代：修改看板备注、待办不会使新草稿失效；相关 JD、诊断所用版本、复盘问题等变化或数据恢复后会拒绝保存；同一草稿仍有效时重复保存返回同一业务记录；同一轮面试的不同草稿分别保存所选结果。同一投递及简历的多次诊断沿用岗位历史，便于在网页比较。模型计量日志沿用应用机制。

响应丢失或客户端重连后，调用 `get_ai_generation_request({idempotencyKey})`；它只返回请求状态、来源版本、草稿有效性和 `savedRecord`，不返回模型正文。`list_ai_drafts` 可按 `applicationId`、`kind` 分页发现草稿，默认排除过期项，`includeExpired:true` 可查看尚未清理的过期元数据；列表包含 `idempotencyKey`、`expired`、`saved` 和 `savedRecord`。正文仍用 `get_ai_draft` 或分段读取。

| 请求状态 | 恢复方式 |
| --- | --- |
| `pending` | 生成仍在截止时间内执行；重复生成返回 `BUSY`，查询后稍后重试同一键 |
| `succeeded` | 草稿可用时，同参数和同键重放原响应，不调用模型；保存后回读会带 `saved:true` 和业务记录 ID |
| `failed` | 记录固定 `errorCode`；同键返回 `CONFLICT`，不再次调用模型 |
| `interrupted` | 进程退出或截止时间已过且未记录终态，结果无法确认；同键返回 `CONFLICT` |
| `invalidated` | 数据恢复更换了世代；旧请求和草稿已失效，同键返回 `CONFLICT` |

请求在读取来源的短事务内原子认领，模型等待不占写锁；草稿与成功状态同事务提交。独立进程和重启后仍按同一键去重；键绑定生成工具、投递及面试 ID，不能改用其他资料。已完成请求重放原生成结果，后续编辑相关输入不改变这个结果，但保存时仍检查来源。过期/淘汰草稿不再重放正文；已保存的正式记录仍可通过请求的 `savedRecord` 找回。失败、中断、过期或恢复后，只有确认需要重新生成时才使用新键，新请求可能产生模型费用。小型请求墓碑持续保留，下一次草稿清理或成功恢复时移除不可用的缓存正文。

生成状态另含 `origin:"server"|"external"`、`phase` 和 `phaseUpdatedAt`。阶段为 `generating`、`validating`、`ready`、`saved`、`expired`、`unavailable`、`failed`、`interrupted` 或 `invalidated`；历史没有阶段记录时按原请求状态推导。`phase` 表示实际可用性，`status` 保留请求是否完成的事实；`phaseUpdatedAt` 为最近持久化生成阶段的时间，保存/到期/恢复状态由当前资料可用性推导。

## 操作记录、升级与验证

`get_mcp_status` 返回 Server/数据库版本、当前有效工具、可用/过期草稿、进行中/中断/成功/失败请求和日志数量，便于排障。后台维护在首次数据库工具调用后启动，首次约 1 秒、之后每 60 秒按批清理过期草稿及失效响应正文，关闭连接后停止；锁繁忙时跳过本轮。`maintain_mcp_state({limit})` 可显式清理，默认 100、范围 1–1000。请求墓碑、创建回执及有效的正式记录引用保留；doctor 和工具发现不会因此创建数据库。

本机 `mcp_operation_logs` 最多保留最近 5000 次工具调用，包含 requestId、固定工具名、目标 ID、结果、错误码、耗时和时间；不记录参数正文、模型输出或密钥。日志在写锁繁忙时跳过，不额外阻塞工具返回；写入失败会在 stderr 留提示，不把已经成功的业务修改报告为失败。日志是排障记录，不是防篡改审计。

`list_mcp_operations` 可组合 `requestId`（响应 `meta.requestId`）、`tool`、`targetId`、`status`（`success`/`error`）与 `errorCode` 筛选，继续使用 `limit`/`cursor` 分页。生成的 `idempotencyKey` 是工作流恢复编号；`meta.requestId` 是每次工具调用的排障编号，两者用途不同。

数据库结构升级至 v11，完整 v10 原子补入 `mcp_generation_progress` 和 `notebook_notes`，保留旧业务、草稿与请求墓碑。`notebook_notes` 为用户业务表，进入备份；所有 `mcp_*` 表为本机运行状态，不导出。业务备份兼容 v1–v11，恢复旧备份时新增笔记保持为空。恢复事务清除临时草稿及生成响应缓存，失败时一并回滚；旧创建和生成请求保留防重墓碑，由世代变化标记失效。升级代码后应重启网页与 MCP 进程。

```sh
npm run test:mcp
npm run typecheck
# 已安装 Codex CLI 的本机客户端验证
npm run check:mcp:codex
# 临时数据上的分段读取/网页写入并发测量
npm run benchmark:mcp
```

MCP 集成测试使用临时数据库和真实 stdio 子进程，覆盖不同工作目录启动、协议输出、白名单、网页/MCP 冲突、跨进程生成认领与重启恢复、完整读取、草稿保存和取消/超时。AI 使用模拟模型响应，不产生真实模型费用。PR 的 `MCP checks` 在 Windows/Linux 执行快速检查，发布仍走完整检查流程。

`check:mcp:codex` 使用已安装的 Codex CLI，通过隔离配置和数据目录启动实际 app-server；从项目外验证 63 个默认只读工具、99 个协作工具、互斥输出契约及准备、资料创作、训练和求职工具流程。重连后重放原题作答、复习、内容保存及面试回合，核对并完成原场次；通过生产流式备份/恢复，确认旧创建键、草稿请求、新增保存请求和修订令牌失效，正式复盘、三轮面试报告和谈薪记录仍可读。Windows 可用 `RESUME_LIFE_CODEX_BIN` 指定 `codex.exe`。不修改用户客户端设置，不发起模型对话。

`benchmark:mcp` 在临时数据库中读取 608000 UTF-16 单位材料，同时执行 100 次带有效会话的网页 route 写入，再查询 5000 条操作记录中的目标请求；检查完整拼接和最终网页状态，报告写入 `.test-artifacts/mcp-benchmark.json`。2026-11-25（香港时间）Windows / Node 24.21.0 本机测量：分段读取 P95 约 32 ms，日志查询 P95 约 4 ms；这是开发机测量，不作为 CI 耗时门槛。

## Resources 与 Prompts

Resources 提供只读 URI：`resume-life://resumes/{id}`、`resume-life://projects/{id}`、`resume-life://applications/{id}`。Prompts 提供 `prepare-for-application` 和 `review-practice-answer`，将读取本机记录并把上下文返回给 MCP Host，由 Host 自己调用其模型；resume-life MCP Server 不会在这些 Prompt 中调用 LLM。

资源发现仅展示各域第一页（最多 50 条），更多记录通过分页工具发现后按 URI 读取。Prompt 参数 ID 使用字符串，例如 `{"applicationId":"1"}` 或 `{"questionId":"1"}`；tool 参数 ID 使用数字。Prompt 中的本地资料经过不可信数据边界转义。所有业务日志写入 stderr；失败响应仅返回业务错误或可用于日志查询的参考编号。

## 安全边界

- MCP 子进程可直接读取其 OS 用户有权访问的 SQLite 数据目录。stdio 不提供远程身份认证或多租户隔离；仅配置可信 Agent，并用本机操作系统账户、文件权限和子进程管理保护数据。
- Prompt 与工具输出可能含简历、JD、项目材料、面试问题和作答等个人资料。Agent Host 可能将这些内容转发至其配置的模型服务。
- 仅显式开启可选写入或 AI 工具；本版本不提供简历发布、删除、导入、备份恢复、模型密钥读取或任意文件访问工具。
- 本机 stdio 是该功能的接入范围，不提供远程 HTTP 接入。
