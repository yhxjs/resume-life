# API 契约

本应用是单用户本地工具（[ADR-0004](./ADR.md#adr-0004)）。HTTP API 有一个会话鉴权层：首次启动在登录页设置用户名和密码，之后所有页面与接口都要求登录；安全边界是「只有本机能访问 + 登录凭证」。本文只覆盖协议层约定（认证模型、错误形状、分页、SSE、备份端点），不逐条罗列业务字段；具体请求体形状以各 `route.ts` 的校验代码为准。

> 端点的存在性由 `src/lib/__tests__/docs-capability-contract.test.ts` 守住：新增 `route.ts` 而没登记进文末清单时，CI 会红。

## 1. 认证与来源校验

- **会话鉴权**：凭证存于数据库 `auth_users`（scrypt 哈希），会话存于 `auth_sessions`（只存令牌的 SHA-256 哈希）。会话令牌通过 `resume_life_session` httpOnly cookie 携带，有效期为 7 天，期间已登录请求自动滑动续期到满 7 天（带 1 小时节流窗口：窗口内的请求跳过续期写库与 cookie 刷新，读请求不再每次产生写事务）。
- **公开路径**：`/api/auth/*`（鉴权自身）与 `/api/health`（探活）不需要会话，在各自的 `withRouteErrorHandling` 调用上以 `{ public: true }` 显式声明；`/login` 页面公开。其余 `/api` 路由由统一包装器校验会话，未登录返回 `401 {"error":"未登录或登录已过期，请重新登录"}`。
- **proxy 的职责边界**：`src/proxy.ts` 刻意不引入数据库模块（middleware 构建产物会被源码级 NFT 分析静态解析出数据目录）。它只做 Host 白名单、uploads 封禁，以及对未携带会话 cookie 的页面访问重定向到 `/login`（cookie 在场检查，伪造/过期的 cookie 会被首个 API 401 拦下）；在 SSR 阶段直接读库的页面（首页）自行做真实会话校验。
- **首次初始化**：`POST /api/auth/init` 只接受回环 `Host`（`localhost`、`127.0.0.1` 或 `::1`，可带端口）；已初始化时还必须设置 `RESUME_LIFE_AUTH_REINIT=true`，成功逃生门请求会清除当前进程中的该变量并覆写凭证、清空全部会话，其他数据不动。远程 Host 即使开启该变量也返回 `403`。`GET /api/auth/status` 返回 `{initialized, allowReinit}` 供登录页选择表单。
- 所有 `/api` 请求与动态首页 `/` 先经 `src/proxy.ts` → `validateMutationOrigin()`：
  - 请求打到的 `Host` 必须属于白名单。默认只含 `127.0.0.1` / `localhost` / `::1`；反向代理对外使用其他域名时，把它写进 `RESUME_LIFE_ALLOWED_HOSTS`（逗号分隔）。条目可写成裸域名、`域名:端口` 或 `https://域名`，一律归一化成主机名后比较；无法解析的条目被丢弃并记一条 `origin.allowedHosts` 的 warn。
  - **只认 `Host` 头**，不认 `x-forwarded-host`（客户端可写）。因此代理必须保留原始 `Host`。
  - 读请求（GET）同样校验 Host：否则恶意页面可以靠 DNS rebinding 读走本机简历与 JD。
  - 变更请求（POST / PUT / PATCH / DELETE）若带了 `Origin`，还要求它与 `Host` 同源。
- 来源校验不通过统一返回 `403 {"error":"拒绝非本机来源的 API 请求"}`（先于会话校验）。
- 动态首页 `/` 与 `/api` 路由经过同一 Proxy 的 Host 校验与鉴权；头像由 `/api/uploads/[name]` 从私有数据目录提供，不支持公共上传路径。

## 2. 请求与响应约定

- **JSON 请求**：`Content-Type: application/json`，缺失或不是它则 `415`。请求体上限 1 MiB，超限 `413 {"error":"请求体超过 1 MiB"}`，非法 JSON 返回 `400 {"error":"请求体必须是有效 JSON"}`。
- **简历条件保存**：`GET /api/resumes/[id]` 返回标题／模块 revision 和 `resume.dataGeneration`（未恢复过数据时为 `null`）。标题、模块及整份草稿 revision 绑定当前恢复世代与对应实体；模块增删、改名、排序、模板及样式的 PATCH 必须原样携带读取到的 `dataGeneration`，编辑器正文保存也携带该世代。显式提交的世代必须匹配当前值；恢复后旧令牌、旧世代或已消失模块的写入返回 `409`，客户端保留草稿，需重新读取并人工合并。打印页模板切换使用页面加载时的世代，冲突后不自动换取新世代重试。
- **题库批量导入**：按去重后的非空题目计数，每次最多 500 道；超限整批返回 `400`，不写入前 500 道，原文应保留用于分批。
- **练习生成题量**：请求题量按整数限制为 1–20。模型有效题目去重后超过请求题量或为空时返回 `502` 且零写入；不足请求题量但非空时允许创建，`201` 的 `count` 返回实际持久化题量。
- **上传请求**：`multipart/form-data`，整体上限 12 MiB，单文件上限 10 MiB。超限返回 `413`，格式错误返回 `400`。
- **资源预算**：认证失败窗口、密码校验并发和 LLM 总并发由数据目录旁的 `process-budgets.db` 跨进程共享；视觉模型请求最多 5 张图片、单张 5 MiB、总计 20 MiB；仓库目录浏览最多返回 200 个子目录并带 `truncated`。
- **错误形状**：所有失败响应都是 `{"error": "<中文可读文案>"}`。未预期的 500 会额外带一个 `requestId`：

  ```json
  { "error": "服务器内部错误，请稍后重试", "requestId": "3f2a…" }
  ```

  把 `requestId` 贴进服务端日志（`server.log`）即可搜到这次请求的相关记录——包括 LLM 层的重试细节（`[server-info] {"operation":"llm.request",…}`）。
  已由路由处理的响应通过 `x-request-id` 响应头提供同一 ID；非流式模型调用自动继承请求关联 ID，路由返回的 502 会记录仅含关联 ID 和状态的脱敏诊断事件。
- **关联 ID**：请求可带符合 `[A-Za-z0-9._:-]{1,128}` 的 `x-request-id` 头，服务端会沿用它；无效或缺失时生成 ID。路由自身生成的错误响应与相关日志共用 ID；框架捕获的渲染异常日志也沿用有效请求头，但框架生成的响应不保证附带同一 ID。
- **缓存**：API 响应默认不可缓存；头像接口 `GET /api/uploads/[name]` 返回 `Cache-Control: private, no-store`。恢复备份可能用新内容覆盖同名头像，恢复事务会更新头像 URL 的持久 `?v=<UUID>`，避免复用被同名内容替换前的资源标识。头像文件仍按不含查询参数的文件名读取。
- **恢复冲突**：普通 API 请求绑定开始时的数据世代；备份恢复后，旧请求不能提交模型、解析或其他异步结果。尚未开始响应的请求返回 `409 {"error":"数据已恢复，请刷新后重新操作"}`；已经开始的 SSE 发送 `error` 事件并停止，不发送成功的 `done`。客户端应整页刷新后重新发起操作。
- **客户端数据世代**：页面在请求时输出 `resume-life-data-generation` meta，`apiFetch` 为该文档固定世代，并将其放入 `X-Resume-Life-Data-Generation` 请求头；JSON、SSE、上传和下载均沿用该包装。未恢复过数据时头值为 `initial`，与简历 JSON 中的 `null` 表示同一世代。普通 API 响应也带同名响应头，但旧文档不能从后台响应自动采用新世代。浏览器的受保护变更请求（带 `Sec-Fetch-Site` 的 POST/PUT/PATCH/DELETE）缺少该头或携带旧值时返回 `409`；已携带旧值的读请求也返回 `409`，避免混用恢复前后的内容。服务端入口和现有事务内复核共同保护恢复竞争。认证、健康探针与主动恢复端点不受该客户端校验约束。无 Fetch Metadata 的脚本可保留原有无头调用方式，或原样携带此前读取的世代头获得冲突保护。

简历 Markdown、PDF、DOCX 的导出 POST 都使用上述有界 JSON 解析，且请求体必须为对象；`{}` 表示普通导出。传入 `anonymizeConfig` 时必须提供完整有效的 `AnonymizeConfig`（各项 `enabled` 为布尔值、`mode` 使用对应合法枚举、`customRules` 为有效替换规则数组）；无效配置返回 `400`，不会回退为未脱敏附件。非法 JSON、错误 Content-Type 和超限请求分别返回 `400`、`415`、`413`，且不生成附件。

三种格式的 GET/POST 在渲染前均检查模块完整性；损坏模块返回 `422 {"error":"导出已暂停：部分模块数据损坏，请修复后重新导出。","corruptedKeys":["work"]}`，不生成附件。`skipExportCheck: true` 仅跳过数字/占位符核对，不能绕过完整性检查。自定义脱敏规则在内建遮盖之后应用于全部可见的基本文本字段（姓名、性别、年龄、电话、邮箱、地点、生日、链接），不改头像路径和排版元数据。

简历 DOCX 导出使用 `GET/POST /api/resumes/[id]/export/docx`，返回 `application/vnd.openxmlformats-officedocument.wordprocessingml.document` 附件。POST 接受 `{ confirmedIssueIds?: string[], anonymizeConfig?: AnonymizeConfig }`；未确认数字或残留占位符返回 `409`，脱敏前后均检查。文档保留模块顺序、正文、标题、列表、加粗、常用文字颜色与换行，并按当前模板生成顶栏、头像、章节装饰和双栏。职位与日期位于同一行；脱敏附件名使用脱敏后的标题，头像按脱敏设置处理。Word/WPS 的分页、边缘横幅和圆角效果可能与浏览器生成的 PDF 有细微差异。

自我介绍详情 `GET /api/intros/[id]` 的每个版本包含 `revision`。手动保存 `PATCH /api/intros/[id]/versions/[kind]` 必须提交 `{ sentences, baseRevision }`；缺失或格式无效返回 `400`，版本已改变或恢复导致修订失效返回 `409`，不会覆盖已保存内容。手动句子数组必须包含 1–60 句，每句正文为非空字符串且不超过 800 个 UTF-16 码元，点评若提供须为不超过 300 个码元的字符串；非法或超限整组返回 `400`，不会过滤句子、截断正文或写入部分内容。重新生成和重新点评 POST 接受 `{ kind, baseRevision? }`；省略时使用请求开始处理时的服务端快照，提交时仍检查快照。三种成功写入均返回 `{ kind, sentences, revision }`，下一次操作使用新令牌。页面遇到冲突会保留编辑草稿，获取最新版本后由用户核对并再次保存。

面试主作答与重新作答评分均要求四维完整、有限的 0–10 整数评分和非空点评。重评还要求非空参考答案，模型返回非法结构时返回 `502`，不追加重答历史或修改既有参考答案；历史记录中的空评分仍可读取。模型可重试 HTTP 错误的 `Retry-After` 秒数或 HTTP 日期会作为最小等待时间，与既有退避取较大值；等待期间仍受调用总截止时间和客户端取消约束。

### 保存版本与损坏数据

排版保存额外要求携带读取到的 `resume.styleRevision`（请求字段 `styleRevision`）；缺失或失配返回 `409`，不写入任何字段。此令牌只绑定排版、简历与恢复世代，正文保存不会自动推进客户端的排版基线。排版冲突保留本页微调值，需重新加载最新设置并人工合并。

草稿 `style_overrides` 无法解析为对象时，读取保留原始记录、返回 `resume.styleCorrupted: true` 和明确警告，默认样式仅用于修复预览。版本发布、Markdown/PDF/DOCX、作品集及打印均拒绝损坏排版，跳过数字核对不能绕过此限制。用户在编辑页显式选择“使用模板默认排版修复”或保存排版调整后解除限制；修复仍要求原始 `styleRevision` 和数据世代，不能覆盖其他页面的新排版。

`GET /api/templates` 对损坏样式返回 `corrupted: true`；其 `style` 仅为修复预览的默认样式，原始记录保持不变。选择器禁用损坏模板；样式工厂经用户确认载入修复草稿，显式保存后才解除损坏状态。应用、发布或导出损坏模板返回 `422` 与修复提示。打印页加载自定义模板失败时也禁止直接打印，不能默默换用默认模板。

浏览器打印与服务端导出同样拒绝非空 `corruptedKeys`；“无需核对”只跳过数字/占位符检查，不能跳过数据损坏。面试总结必须包含有效匹配分及非空的强项、短板、建议；挖掘模式还要求完整经历字段、草稿与待确认项结构。生成结果不完整时返回 `502`、保留原状态并允许重试。面试官评估允许独立重试。

## 3. 分页

游标分页，稳定排序，不使用 offset：

- 查询参数 `limit`（默认 50，上限 100）、`cursor`（上一页返回的 `nextCursor`）。
- 响应形状：

  ```json
  { "items": [ … ], "nextCursor": "123" }
  ```

  `nextCursor` 为 `null` 表示没有下一页。客户端在「加载更多」时把上一次的 `nextCursor` 原样回传。`/api/interviews` 与 `/api/interviews/series` 还返回独立统计的 `total`（不受关键词和分页游标影响），用于展示累计场次。
- 参数非法（非数字、越界）返回 `400`。

采用游标分页的列表：`/api/applications`、`/api/drills`、`/api/bank`、`/api/notebook`、`/api/interviews`、`/api/interviews/series`、`/api/projects/[id]/summary-history`。

历史记录接口 `/api/intros`、`/api/tools/jd-portraits`、`/api/tools/jargon-decodings`、`/api/tools/career-gap-remedies`、`/api/tools/salary-negotiations` 也按 `id` 降序分页，统一返回 `{ "items": […], "nextCursor": "…" | null, "total": 记录总数 }`，`total` 不受游标影响。未传分页参数时返回默认的前 50 条；读取全部历史记录需要逐页请求。

**刻意不分页的例外**：`/api/resumes`、`/api/projects` 返回完整列表——它们要作为面试/项目选择器的数据源，分页会破坏选择语义。

## 4. SSE 事件协议

长耗时 AI 流程（模拟面试出题、作答评分、自我介绍生成、项目总结）走 Server-Sent Events。响应头为 `Content-Type: text/event-stream`，每 15 秒发一次 `: keep-alive` 注释心跳。

事件类型：

| event | data | 含义 |
|---|---|---|
| `delta` | `{"text": "…", …extra}` | 增量文本，客户端拼接展示 |
| `done` | 业务载荷（如 `{"id": 12, "question": "…"}`） | 成功终态，流随即关闭 |
| `error` | `{"error": "服务端处理失败（<requestId>）"}` | 失败终态，流随即关闭 |

`error` 事件里的 ID 就是日志中的 `requestId`：用户界面上的报错可以直接拿去搜日志。

## 5. 备份端点

导出的**密码在 JSON 请求体**；校验与恢复的**密码在请求头**，请求体是加密备份流本身。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/backup/stats` | GET | 数据统计（各表行数、数据库文件大小），供设置页展示 |
| `/api/backup/export` | POST | 导出 `.rlbackup` 加密备份 |
| `/api/backup/validate` | POST | 只校验并预览备份内容，不写入 |
| `/api/backup/restore` | POST | 用备份覆盖当前全部数据 |

### 自定义请求头

- **`X-Resume-Life-Backup-Password`** — `validate` 与 `restore` 的备份密码。密码**不放请求体**，因为这两个端点的请求体是加密备份流本身。
- **`X-Resume-Life-Preserve-Ai-Config`** — `restore` 专用，取值只能是 `"true"` 或 `"false"`，其他值返回 `400`。**缺省为 `true`**，即完整保留本机当前的 AI 配置。传 `"false"` 会用备份中的 Base URL、模型名等普通设置替换本机设置；用户备份不携带 API Key 或代理密码，需要重新填写。

  缺省取 `true` 可防止不带该头的脚本或客户端覆盖正在使用的本机配置，导致恢复后需要重新配置模型连接。

### 导出请求体

```json
{ "password": "至少12个字符", "confirmation": "同上" }
```

密码为 12–256 个 Unicode code point；两次不一致返回 `400`。导出响应是流式附件，`Content-Disposition` 带时间戳文件名。

用户导出的 `settings` 行会将 `api_key` 与 `proxy_password` 清空，包括设备绑定的加密值；服务地址、模型名、协议与 OCR 模式等普通设置保持原值。

### 容器内容

加密容器（`.rlbackup`，manifest 格式版本 `1.0.0`）的明文按记录顺序为：

| 记录 | 说明 |
|---|---|
| `{ kind: "manifest" }` | 应用名、格式版本、数据库版本、导出时间、完整表清单、自增序列，以及 `files` 头像清单（`name` / `bytes` / `chunks`） |
| `{ kind: "row", table, data }` | 逐表按 rowid 游标分页导出的业务行 |
| `{ kind: "file", name, index, data }` | 数据库引用的 `data/uploads/` 头像文件，按 1 MiB 原始字节分块、base64 编码 |
| `{ kind: "end", stats, totalRecords, files }` | 各表行数、总记录数、头像文件数 |

`manifest.files` 与 `end.files` 都是必需字段：没有头像时分别填写 `[]` 与 `0`。恢复只接受当前完整的首版容器格式，不支持缺少这些字段的旧格式。恢复时会先写头像文件再在事务里换数据，保证不会出现「库里有指针但文件不存在」；备份里缺失分块或长度与清单不符的头像会让整次恢复失败。新数据库不再引用的本机头像会先隔离，提交成功后清理，失败时放回原位。

### 恢复的原子性

恢复失败时原数据不被替换，响应为 `500` 且带 `requestId`：

```json
{ "ok": false, "error": "恢复失败，原数据未被替换，请根据关联 ID 排查", "requestId": "…" }
```

每次成功恢复前会先创建一份 SQLite 灾备快照（`VACUUM INTO`）和同名 `.uploads` 头像目录，最多保留 5 份；`snapshotCreated` 返回 SQLite 文件路径，手动回退还需一并还原其头像目录，参见排障指南。

## 投递快照

新建 `stage=applied` 的投递，或首次从其他阶段切换为 `applied` 时，服务端在同一事务中保存当时已落库的关联简历与本次 JD。每条投递只有一份固定快照；普通编辑、重复标记、阶段回退后再次投递和更换关联均不覆盖快照。未关联简历时仅保存 JD 和时间。历史已投递记录不会因普通编辑自动补造快照。内容损坏或合并后的记录超过备份容量时，整次保存回滚并返回 400。

`GET /api/applications/[id]/versions` 按需返回 `submitted`（`captured_at`、`resume`、`jd`）和 `current`（`resume`、`jd`、`warnings`）。没有快照时 `submitted=null`；没有对应简历时 `resume=null`。列表仅提供 `submitted_at`，不附带快照正文。快照字段不在 POST/PATCH 输入白名单中。

看板和面试日历均可回看投递版。差异按模块 key 对齐，比较正文、内联加粗/列表标记、模块顺序及 JD；头像、页面模板和间距不参与差异统计。

## 岗位诊断历史

`POST /api/resumes/[id]/diagnose` 每次追加独立记录，保存岗位标识、岗位名称、JD、报告和模型调用前读取的简历正文快照。请求支持 `jd`、可选 `job_title`、已有岗位的 `job_id`，以及创建独立岗位的 `new_job=true`；已有岗位可修改 JD 后继续诊断。未指定岗位标识时默认复用相同 JD 的岗位。编辑器发起诊断前等待简历保存成功，基本身份联系方式仍不发送给模型。

`GET` 返回 `current`、同岗位的 `previous` 和不带快照正文的 `history`，也保留顶层 `jd`、`report`、`created_at` 字段。默认选中最新记录；可用 `job_id` 查询该岗位最新记录，或用 `diagnosis_id` 读取指定历史版本。首次诊断的 `previous=null`。备份恢复要求数据库版本与当前支持的结构版本匹配，认证凭证和会话不随业务备份迁移。

`PATCH` 接收 `diagnosis_id`、`module_key`、`suggestion_index` 和 `value`，记录建议被采纳时实际保存的文本和时间。服务端校验建议归属和简历已保存内容，未保存或已被其他修改覆盖时返回 409；重复采纳记录不重复计数。采纳只更新采纳记录，诊断报告和快照保持不变。历史界面同时展示曾采纳情况与当前文本保留情况；评分差异只比较同岗位相同模块，JD 变化单独提示。

## 6. 端点清单

投递准备页使用 `GET /api/applications/[id]/preparation` 返回投递信息、各类资料的前 5 条（含 `total`、`nextCursor`）与待办。`resources` 接口接受 `kind=diagnosis|intro|portrait|interview|series|notebook`，`candidates=true` 查询可关联的历史资料，沿用游标分页；POST/DELETE 的 JSON 为 `{ "kind": "intro", "id": 12 }`，取消关联不删除原资料。`tasks` 的 POST 接受 `title`（1–200 字），PATCH 接受 `id`、`done`（布尔值），DELETE 接受 `id`，跨投递修改返回 404。

诊断、自我介绍、JD 考点画像、模拟面试的生成接口支持可选 `application_id`。服务端校验投递存在且简历/JD 与当前投递一致，生成结果与资料关联在同一事务内保存；生成期间投递变更则拒绝归档。历史资料仅明确关联，不按相同 JD 推断投递。准备资料关联与待办数据纳入首版数据库和加密备份。

### 真实面试逐题复盘

`/api/applications/[id]/interviews/[interviewId]/review` 只接受属于该投递的真实面试轮次：

- `GET` 返回 `{questions,input_hash,latest,selected,history}`；`questions` 是当前草稿，`input_hash` 覆盖逐题记录、公司、岗位、JD 和固定简历的职业上下文，`latest` 是最新确认快照。`?recap_id=123` 可读取该轮的指定历史快照到 `selected`。每份快照的 `exports` 标记已加入的错题、追练套题 ID 与已创建的待办。
- `PUT` 接收 `{expected_hash,questions}`，每题包含必填的 `question` 和可留空的 `answer`、`stuck`、`feedback`。最多 20 题，每字段最多 2000 字，总计最多 32000 字。空数组可清空草稿；版本冲突返回 409。
- `POST` 接收 `{expected_hash}`。至少保存一题后，一次 AI 调用生成 `mistakes`、`drills`、`resume_suggestions`，各条用 `question_index` 指向确认时的原题。结果和原题以不可变快照保存；同一完整输入重复确认直接返回已有结果，相关投递上下文变化后可生成新结果并保留历史。保存或确认使用过期摘要、或生成期间逐题记录或投递上下文变化均返回 409，不保存过期结果。模型只读取投递快照（没有投递快照时读取绑定发布版本）的职业字段，排除全部基本身份、联系方式、文档标题和排版字段，不修改存储快照。AI 结构无效返回 502。
- `POST .../review/export` 接收 `{recap_id,action}`，`action` 为 `mistakes|drills|resume_suggestions`。用户确认后分别批量加入错题本、创建可直接开始的追练套题、创建本投递的简历修改待办；同一复盘版本重复请求不会重复创建。追练响应另含 `drill_id`。跨投递或跨轮次返回 404。

逐题草稿与确认快照通过 `application_interviews` 关联原投递；删除轮次会级联删除它们。已确认导出的错题、练习与待办作为独立记录保留。

### 间隔复习

- `GET /api/reviews`：`scope=due|all`（默认 due，包含逾期）、`source=all|notebook|remedial`、`time_zone`（IANA 时区，可选，默认服务器本地时区）、`limit`（1–100）、`cursor`。返回 `{items,nextCursor,summary}`；按到期日、ID 升序分页。summary 为全局到期/来源/逾期/今日已复习题数，今日已复习按题去重。
- `GET /api/reviews/:id`：返回题目、掌握程度、排期、原作答/参考/点评和历史 `{attempts,nextCursor}`；历史按 ID 倒序，支持 `limit/cursor/time_zone`，界面在主动回忆阶段不展示参考或历史。
- `POST /api/reviews/:id`：`{answer,grade,expected_review_count,request_id,time_zone?}`；answer 为 1–20000 字，grade 为 `again|hard|good|easy`，request_id 为每次提交生成的 UUID。返回 `{card,attempt}`；相同请求重试幂等，复习版本过期或复用编号提交不同内容返回 409。排期与历史在一个事务中保存，不覆盖原作答快照。
- 错题收藏即入列；追练题首次 AI 评分成功后入列；普通练习需要收藏后才加入。未复习卡始终纳入用户当地今日待学习队列，首次复习后才开始固定排期和逾期统计。收藏已在复习的追练题会沿用卡片和历史，删除原练习不影响已收藏题的复习。错题本列表与练习详情提供 `review_card_id`、`review_mastery`、`next_review_date`。
- SM-2 四档自评对应质量分 1/3/4/5：成功间隔为 1 天、6 天、之后乘难度系数，遗忘重置至 1 天；难度系数下限 1.3，间隔上限 365 天。按实际复习日和浏览器时区安排日历日期；掌握程度是复习进度标签，不是科学测得的记忆概率。
- `review_cards/review_attempts` 属于首版数据库结构，随加密备份导出与恢复；复习卡仅在当前收藏或评分流程中创建，不执行启动回填。

### 简历版本树

简历版本使用 `resume_version_id` 绑定已发布快照。新建投递、模拟面试、自我介绍、简历排雷和简历诊断时校验版本归属；省略版本则绑定当时最新已发布版本，未发布时返回 400。后续回答、重新生成与进阶续轮沿用原绑定。编辑器诊断显式选择已发布版本，投递准备页诊断使用投递绑定版本。

`GET /api/resumes/[id]/versions` 返回 `{ versions, base_version_id, draft_revision }`；列表仅包含版本 ID、所属简历 ID、版本号、父节点、名称、说明和发布时间，不含 `snapshot`。正文和排版快照经 `GET /api/resumes/[id]/versions/[versionId]` 按需读取。`POST` 接受 `{ name, description?, draft_revision }`，发布成功后将草稿来源推进到新版本。`POST .../[versionId]/branch` 接受 `{ draft_revision }`，将历史版本载入草稿；并发修改返回 409，不覆盖新草稿。版本本身没有编辑或删除接口。

数据库结构版本为 `1`，包含当前全部业务表、认证表、索引、触发器与搜索结构。空数据库在事务中初始化为 v1；已有 v1 数据库必须通过完整结构与外键校验，其他版本或结构不匹配时拒绝打开，不修改原数据。加密备份 manifest 版本为 `1.0.0`，加密容器头版本为 `1`，必须包含完整业务表、序列、头像清单与结束计数，认证凭证与会话不纳入备份；不支持其他格式版本或缺字段的备份。

### 项目总结增量更新

`POST /api/projects/[id]/summarize` 和仓库扫描的 SSE `done` 返回 `summary`、逐段 `comparison`（`new`/`changed`/`conflict`）、`materialChanges`、`materialFingerprint` 和 `revisionId`。`PATCH /api/projects/[id]` 保存总结时可带 `expectedRevisionId` 与 `proposal: { generated, acceptedKeys, source, materialFingerprint }`；总结版本或生成时的材料发生变化均返回 409。逐段采纳会更新 AI 基线；保存文本恰好与本次新稿一致时也记录该文本来源，但未采纳的不同文案仍留在当前档案。首次草稿中直接改写 AI 文案会记录其原稿基线。纯手动保存、或未采用新稿内容的确认，不会把新材料标记为已总结。`GET /api/projects/[id]/summary-history` 按 ID 倒序返回 `{items,nextCursor}`，支持 `limit/cursor`。项目详情材料列表只返回元数据并支持 `limit/cursor`，单份正文通过 `GET /api/projects/[id]/materials/[mid]` 按需获取；材料编辑必须携带 `revision` 对应的 `expectedRevision`，过期返回 409。

材料总结的完整格式化输入（含材料标题和分隔符）最多 60000 字符。超过时在模型调用前返回 `413`，提示精简材料后重试；不会截取部分材料生成总结，不新增历史或推进材料已总结基线，原材料保留。

`PATCH /api/projects/[id]` 的 `summary` 若提供，必须包含全部当前字段：正文各字段为字符串，`achievements` 为字符串数组；缺失字段、错误类型、未知字段、`null` 和数组根结构返回 400，不修改项目或新增总结历史。合法空字符串与空数组允许主动清空，总结采用整体替换语义。仅修改项目名称时可省略 `summary`。

仓库扫描和关联预检的 `repoPaths` 原始数组最多 32 项（包括重复项），超过限制返回 400；等价路径在读盘前去重，之后仍按真实路径去重。`POST /api/projects/[id]/scan-repo?action=check-relation` 返回 `isRelated: true | false | null`、`reason` 与 `method: single | model | cli | heuristic`。`null` 表示无法确认关联，`heuristic` 表示模型/CLI 未能给出有效结果后使用启发式判断；界面需在未知或不相关时取得用户明确确认后继续。预检请求失败也必须明确确认，取消覆盖预检、确认等待和扫描全流程。

### 设置与本地代理

`GET /api/settings` 返回代理开关、地址和用户名，`proxy_password` 只返回脱敏占位符；`PUT /api/settings` 接受 `proxy_enabled`、`proxy_url`、`proxy_username` 和 `proxy_password`，提交原占位符表示保留已保存密码。代理地址支持 `http://`、`https://` 和 `socks5://`，启用时会校验主机与端口。

`PUT /api/settings` 中显式提供的 `api_format` 只能为 `openai_chat`、`anthropic_messages`、`openai_responses`，`ocr_mode` 只能为 `auto`、`vision`、`local`、`off`；允许字符串两端空格，未知值、空字符串及非字符串返回 `400`，原设置不变。成功响应从实际规范化后的已保存设置生成，API Key 与代理密码保持脱敏。

所有非测试运行保存非空凭证都需要 `RESUME_LIFE_SETTINGS_KEY`。缺少密钥时设置端点返回 `500`、安全的配置与重启提示以及 `requestId`，不回显凭证值；其他未知异常仍使用统一错误收口。已存凭证无法解密时，明确填写新值或清空可替换失效旧值，脱敏占位符仍表示保留旧值并会报告解密失败。

`GET /api/settings/proxy/detect` 从环境变量、Windows 系统代理和限定的回环常见端口生成候选，候选地址不会包含密码；`POST /api/settings/proxy/test` 只执行代理端点握手，不连接外部目标。已启用代理只用于 AI 请求、模型列表和连接测试，不会修改系统代理或代理页面、备份等其他请求。

`POST /api/settings/test` 使用当前或请求体中尚未保存的模型配置，经 `safeChat` 发送非流式最小请求：固定最多 1024 输出 token、整体 15 秒截止，不自动重试，与普通模型调用共用三个并发名额。模型名缺失或配置无效返回 `400`；名额已满返回 `429` 且不转发；上游非 `2xx` 或网络失败返回 `502`；超时返回 `504`，客户端取消返回 `499`；成功返回 `{ok:true,reply}`。成功、失败和取消的上游调用均按“模型连接测试”记录脱敏用量，不保存探测表单配置、凭证或正文。设置页测试期间锁定按钮，离开页面时取消在途请求。

投递面试轮次 POST/PATCH 的 `reminder_minutes` 若提供，必须是非负安全整数，非法值返回 `400` 且不写入；POST 未提供时默认 15，PATCH 未提供时保持原值。创建轮次时的 `advance_stage` 与轮次、下次面试时间及阶段历史在同一领域事务内提交，任一步失败整体回滚。

### 作品集静态站点导出

`GET /api/portfolio/sources` 返回 `{resumes,projects}`。简历条目包含已发布版本元数据，项目条目包含项目库总结；此接口只读取本机数据，不生成或发布站点。

`POST /api/portfolio/export` 接受 JSON 对象：必填 `resumeId`，可选 `versionId`、`selectedProjects`、`siteTitle`、`siteSubtitle`、`accentColor`、`themeMode`、`siteTemplate` 和 `anonymizeConfig`。`siteTemplate` 可取 `flow`、`focus`、`chronicle` 或 `sidebar`，默认 `flow`。项目选择项使用 `{projectId,customLinks?,featured?,order?}`。未指定版本时使用当前草稿，指定版本时读取该简历的不可变发布快照。领域模块先组装简历与项目，再按脱敏配置处理，最后生成静态 ZIP。

`themeMode` 可取 `auto`、`light` 或 `dark`，默认 `auto`。首次打开时优先使用访问者已保存的合法主题；没有保存值时使用显式指定的 light/dark，auto 跟随系统。页面主题按钮会保存访问者的新选择；存储不可用时仍能使用指定主题并切换。

提供 `accentColor` 时必须为六位十六进制颜色（例如 `#b8722c`，大小写均可），其他格式返回 `400`。当前草稿包含损坏模块时返回 `422`，不生成 ZIP；合法空模块仍可导出，指定有效发布版本时使用其快照。编辑器中的作品集导出会先等待简历保存队列完成，保存失败或版本冲突时保留草稿与弹窗并停止导出。

成功响应为 `application/zip`，包含附件名与 `Content-Length`，不会自动上传或托管站点。非法 JSON、null、数组或无效选择返回 400；找不到简历或版本返回 404；Content-Type 非 JSON 返回 415；正文超过 1 MiB 返回 413。未知异常返回统一 500 与 `requestId`。脱敏配置由用户选择，下载内容仍须人工检查后再公开。

`POST /api/portfolio/preview` 接受与导出相同的 JSON 对象、版本选择和脱敏配置，经相同的领域组装与脱敏后返回 `{html,resumeHtml}`：`html` 为作品集预览，`resumeHtml` 为独立简历 HTML，不生成 ZIP、不上传或发布。此端点需要登录，并沿用上述请求校验与 400/404/413/415/422 错误；两份 HTML 合计受展开内容预算限制，超限返回 413，未知异常返回统一 500 与 `requestId`。

### 路由列表

共 99 个路由文件。下表按路径分组；同一路径的多个方法写在一起。

| 路径 | 方法 |
|---|---|
| `/api/applications` | GET, POST |
| `/api/applications/[id]` | GET, PATCH, DELETE |
| `/api/applications/[id]/versions` | GET |
| `/api/applications/[id]/preparation` | GET |
| `/api/applications/[id]/preparation/resources` | GET, POST, DELETE |
| `/api/applications/[id]/preparation/tasks` | POST, PATCH, DELETE |
| `/api/applications/[id]/interviews` | GET, POST |
| `/api/auth/init` | POST |
| `/api/auth/login` | POST |
| `/api/auth/logout` | POST |
| `/api/auth/status` | GET |
| `/api/applications/[id]/interviews/[interviewId]` | DELETE, PATCH |
| `/api/applications/[id]/interviews/[interviewId]/review` | GET, PUT, POST |
| `/api/applications/[id]/interviews/[interviewId]/review/export` | POST |
| `/api/applications/stats` | GET |
| `/api/backup/export` | POST |
| `/api/backup/restore` | POST |
| `/api/backup/stats` | GET |
| `/api/backup/validate` | POST |
| `/api/bank` | GET, POST |
| `/api/bank/[id]` | DELETE |
| `/api/bank/directions` | GET |
| `/api/drills` | GET, POST |
| `/api/drills/[id]` | GET, DELETE |
| `/api/drills/[id]/questions/[qid]` | POST |
| `/api/health` | GET |
| `/api/import/parse` | POST |
| `/api/interviews` | GET, POST |
| `/api/interviews/[id]` | GET, DELETE |
| `/api/interviews/[id]/answer` | POST |
| `/api/interviews/[id]/evaluator-report` | POST |
| `/api/interviews/[id]/finish` | POST |
| `/api/interviews/[id]/reverse` | POST |
| `/api/interviews/[id]/turns/[tid]/reference` | POST |
| `/api/interviews/[id]/turns/[tid]/retry` | POST |
| `/api/interviews/series` | GET |
| `/api/interviews/series/[id]` | GET, DELETE |
| `/api/interviews/series/[id]/advance` | POST |
| `/api/interviews/series/[id]/finalize` | POST |
| `/api/intros` | GET, POST |
| `/api/intros/[id]` | GET, DELETE |
| `/api/intros/[id]/recomment` | POST |
| `/api/intros/[id]/regenerate` | POST |
| `/api/intros/[id]/versions/[kind]` | PATCH |
| `/api/notebook` | GET, POST |
| `/api/notebook/[id]` | GET, PATCH, DELETE |
| `/api/notebook/categories` | GET, POST |
| `/api/notebook/categories/[id]` | PATCH, DELETE |
| `/api/portfolio/export` | POST |
| `/api/portfolio/preview` | POST |
| `/api/portfolio/sources` | GET |
| `/api/projects` | GET, POST |
| `/api/projects/[id]` | GET, PATCH, DELETE |
| `/api/projects/[id]/materials` | POST |
| `/api/projects/[id]/materials/[mid]` | GET, PATCH, DELETE |
| `/api/projects/[id]/scan-repo` | GET, POST |
| `/api/projects/[id]/summarize` | POST |
| `/api/projects/[id]/summary-history` | GET |
| `/api/resumes` | GET, POST |
| `/api/resumes/[id]` | GET, PATCH, DELETE |
| `/api/resumes/[id]/copy` | POST |
| `/api/resumes/[id]/diagnose` | GET, POST, PATCH |
| `/api/resumes/[id]/export` | GET, POST |
| `/api/resumes/[id]/export/pdf` | GET, POST |
| `/api/resumes/[id]/export/docx` | GET, POST |
| `/api/resumes/[id]/polish` | POST |
| `/api/resumes/[id]/versions` | GET, POST |
| `/api/resumes/[id]/versions/[versionId]` | GET |
| `/api/resumes/[id]/versions/[versionId]/branch` | POST |
| `/api/review` | GET |
| `/api/reviews` | GET |
| `/api/reviews/[id]` | GET, POST |
| `/api/search` | GET |
| `/api/settings` | GET, PUT |
| `/api/settings/configured` | GET |
| `/api/settings/llm-logs` | GET |
| `/api/settings/llm-usage` | GET |
| `/api/settings/models` | POST |
| `/api/settings/proxy/detect` | GET |
| `/api/settings/proxy/test` | POST |
| `/api/settings/test` | POST |
| `/api/styles/generate` | POST |
| `/api/templates` | GET, POST |
| `/api/templates/[id]` | PATCH, DELETE |
| `/api/tools/career-gap-remedies` | GET, POST |
| `/api/tools/career-gap-remedies/[id]` | GET, DELETE |
| `/api/tools/jargon-decodings` | GET, POST |
| `/api/tools/jargon-decodings/[id]` | GET, DELETE |
| `/api/tools/jd-portraits` | GET, POST |
| `/api/tools/jd-portraits/[id]` | GET, DELETE |
| `/api/tools/resume-defenses` | GET, POST |
| `/api/tools/resume-defenses/[id]` | GET, DELETE |
| `/api/tools/resume-defenses/[id]/drill` | POST |
| `/api/tools/salary-negotiations` | GET, POST |
| `/api/tools/salary-negotiations/[id]` | GET, DELETE |
| `/api/tools/salary-negotiations/[id]/finalize` | POST |
| `/api/tools/salary-negotiations/[id]/turn` | POST |
| `/api/upload` | POST |
| `/api/uploads/[name]` | GET |

## 7. 健康检查

`GET /api/health` 返回：

```json
{
  "status": "ok",
  "uptimeSeconds": 123.4,
  "db": { "status": "connected", "version": 14, "journalMode": "wal", "storageWritable": true },
  "latencyMs": 3,
  "timestamp": "2026-09-22T00:00:00.000Z"
}
```

不只验「能连上」：还要求数据库处于 WAL 模式、且数据目录可写——只读目录、磁盘写满、WAL 退化这三类真实故障都靠这两项暴露。任一不满足返回 `503`。
