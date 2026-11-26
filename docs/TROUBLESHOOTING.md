# 排障指南

面向本机单用户部署。所有日志都写到服务进程的 stdout/stderr；应用不收集远程遥测。

## 1. 先看这三处

1. 启动日志里的环境摘要：

   ```
   [server-info] {"level":"info","operation":"startup","context":{"node":"v24.21.0","platform":"win32"}}
   [server-info] {"level":"info","operation":"db.open","context":{"resource":"existing-database","dataDirConfigured":true,"journalMode":"wal","dbVersion":5}}
   ```

   `resource` 为 `new-database` 表示这次启动新建了一个空库——通常意味着数据目录选错了（见第 2 节）。

2. 健康检查：

   ```bash
   curl -s http://127.0.0.1:3714/api/health
   ```

   返回 200 且 `db.journalMode` 为 `wal`、`db.storageWritable` 为 `true` 才算正常。返回 503 时响应体只有 `status`、`message`、`timestamp`、`requestId`，**不含 `db`**；用 `requestId` 去日志里搜同一条，查看固定的 `stage` 和 `errorCode`。

   503 的三类常见根因与处置：

   - 日志 `stage=storage-write`：检查磁盘空间和服务账户对数据目录的写权限；`errorCode=ENOSPC` 表示磁盘写满，`EACCES` / `EPERM` / `EROFS` 可提示权限或只读文件系统。清理 `data/backups/` 里的旧快照（见第 4 节的轮转目录）或其他大文件、检查磁盘配额后重试；数据目录在只读挂载点上时，把 `RESUME_LIFE_DATA_DIR` 指到可写位置。未识别的系统错误仍可能为 `unknown`，需结合操作系统检查。
   - 日志 `stage=database-wal`：检查 WAL 是否可用（常见于把数据目录放到网络盘或不支持 WAL 的文件系统）；停服后把数据目录迁回本地磁盘，重启即可重新以 WAL 打开；启动日志里也会有一条 `db.journalMode`（`wal-not-active`）的 warn 可供确认。失败响应没有 `db.journalMode`，不要从 503 JSON 中寻找该字段。
  - 数据库文件本身不可写（被其他进程占用或权限变化）：关闭占用进程、修复权限后重启；Windows 下注意杀毒/同步软件的文件锁。
   - 认证和模型预算还会使用同目录的 `process-budgets.db`、`-wal` 和 `-shm` 文件，它们也必须允许服务账户读写。

3. 出错日志。服务端异常统一是 `[server-error] {...}` 单行 JSON：

   ```
   [server-error] {"operation":"backup.restore","requestId":"...","status":500,"errorType":"Error","context":{"route":"/api/backup/restore"}}
   ```

    日志**只**记录白名单诊断字段（route、table、dbVersion、durationMs 等），不含异常 message/stack、请求正文、模型输出、API Key 或个人资料。`errorType` 仅按可信类型区分 `TypeError`、`SyntaxError`、`RangeError`、`ModelProtocolError`、`ModelInputBudgetError`、`BackupLimitError` 等，任意自定义 `error.name` 不会被输出；`errorCode` 只保留白名单系统/网络代码及 SQLite 分类，最多检查四层 `cause`。健康检查的 `stage` 区分数据库打开/查询/版本/WAL、存储写探针和恢复暂存检查；这些类别可以帮助定位故障，但不会给出原始敏感字段正文，仍需结合界面提示和下面的分类排查。

扫描或关联预检出现 `operation=cli.workdir.cleanup`，表示本次 CLI 临时目录在有限重试后仍未删除。清理失败会保留已生成的结果或原始错误，不会自动重新调用模型；日志通过所属 `requestId` 和 `resource=scan/relation` 关联任务，不记录目录路径或材料正文。此时系统临时目录中可能留下 `resume-life-cli-`／`resume-life-relation-` 目录，请检查服务账户的临时目录权限及文件锁；应用没有后台持续回收机制。

## 2. 数据看起来「丢了」

数据库路径由 `RESUME_LIFE_DATA_DIR` 决定；未设置时取**进程当前工作目录**下的 `data/resume-life.db`。

从别的目录启动（例如 IDE 直接跑 `next start`、或双击了不同副本），就会在那边新建一个空库，而原库仍在原地。

- 排查：看启动日志的 `db.open`，`resource` 是否为 `new-database`，以及 `dataDirConfigured` 是否为 `false`。
- 修复：显式指定绝对路径后重启。

  ```bash
  RESUME_LIFE_DATA_DIR=/绝对路径/data npm start
  ```

- 确认旧库位置：搜索本机的 `resume-life.db`，把 `RESUME_LIFE_DATA_DIR` 指到它的父目录。

`RESUME_LIFE_DATA_DIR` 会在模块加载期（即启动时）做一次只读校验，避免「打错一个字母却看起来一切正常」：

- 必须是**绝对路径**；写成相对路径会立刻退出，日志里是 `db.dataDir` 的 `relative-data-directory`。
- 最近的已存在祖先目录必须存在且可写，否则以 `data-directory-parent-not-directory` / `readonly-data-directory` 退出。
- 目标目录本身**允许尚不存在**（首次部署的正当用法）。此时只记一条 `data-directory-will-be-created` 的 warn 并在首次写入时创建——这条 warn 是排查「数据去哪了」的线索：路径打错时它会出现在启动日志里。

不要在测试中指向日常使用的数据目录。浏览器测试会自建临时目录，不会碰 `data/`。

## 3. 启动直接失败

### 3.1 Node 版本不符

```
请使用 Node.js 24.21.0 或更新的 24.x LTS 版本（参见 .nvmrc），当前为 v23.x.x
```

`predev` / `prebuild` / `prestart` / `pretest` 都会先跑 `scripts/check-runtime.mjs`。这是刻意的前置失败：本应用依赖 `node:sqlite`，而 `engines`、`.npmrc` 与运行期检查共同把可用范围钉在 Node 24 LTS。

若前置检查通过，但 Turbopack 在处理 CSS 时提示 `--experimental-sqlite is not allowed in NODE_OPTIONS`，还需核对构建子进程实际使用的 Node。Windows 上临时通过 `npx --package=node@24.21.0` 运行主进程时，子进程仍可能从 PATH 找到旧 Node；用 `where.exe node` 排查并统一到项目要求的 Node 24，不应仅据该错误认定 Turbopack 禁止 SQLite 选项。本机复验曾发现子进程使用 Node 16；统一 Node 24 的可执行目录并将传给构建器的环境键规范为 `PATH` 后，保留该选项也可完成生产构建。优先通过版本管理器切换完整终端环境，而非只更换顶层命令的 Node。

### 3.2 `node:sqlite` 不可用

```
当前 Node.js 运行时不支持应用需要的 node:sqlite，请使用官方 Node.js 24 LTS。
```

请用官方 Node 24 发行版，不要用自行编译或裁剪过的运行时。

### 3.3 设置保存提示缺少 `RESUME_LIFE_SETTINGS_KEY`

本机开发与生产运行保存 API Key 或代理密码前都需要配置该加密密钥。首次配置可按 README 的一次性命令生成 `.env.local`，服务部署可从独立密钥管理器注入，配置后重启再保存；不要用模型服务的 API Key 代替，也不要在每次启动时重新生成。

若已保存的凭证提示无法解密，先恢复原来的加密密钥；原密钥遗失时，可显式填写新的 API Key 和代理密码或清空失效字段后保存，不能提交旧脱敏占位符沿用不可解密的值。跨设备恢复默认保留目标设备配置；关闭保留后，用户备份只恢复普通设置，需重新填写凭证。

## 4. 备份与恢复

当前数据库结构版本为 `14`。v14 增加本机实例标识、检索领域变动计数与任务进度；v13 增加 MCP 持久任务、上传与租约运行表，以及随业务备份的仓库证据历史；旧备份中的历史缺失保持为空，恢复会使本机任务和缓存失效。完整 v1/v2/v3/v4/v5/v6/v7/v8/v9/v10/v11/v12/v13 数据库在启动时校验后原子升级；已有 v14 数据库须通过完整结构校验。业务备份接受 v1 至 v14，并按对应版本校验完整表清单。v4 新增真实面试复盘的生成时岗位资料，旧复盘缺少该资料时保持未知，不从当前投递回填。v5 新增项目材料的 DOCX 表格来源记录；旧材料没有来源记录时保持未知，不从标签外观推断。恢复会核对来源 JSON、正文哈希与标识范围，损坏记录整份拒绝。v6 新增同机多进程共享的简历导入来源回执，固定 30 分钟内有效且不缓存正文或文件；正常进程重启仍可使用，登录会话失效、超时或恢复后失效。v7 新增按岗位保存的上场计划与训练完成进度，纳入业务备份；恢复 v1–v6 备份后清单为空，可重新生成。v8 新增面试题目图谱及撤销快照，纳入业务备份；恢复 v1–v7 备份后图谱历史为空。v11 新增独立补充笔记 `notebook_notes`，纳入业务备份；恢复 v1–v10 备份后笔记为空，原题快照保留。本机谈薪、简历创建和导入来源回执不导出，恢复时会清除旧回执并切换数据世代。

本机 MCP 在 v9 新增创建回执、操作日志与临时草稿，v10 新增生成请求，v11 新增生成阶段表，v12 新增批量操作结果表；所有 `mcp_*` 表不进入用户业务备份。升级保留已有草稿、创建回执和请求墓碑，不补造历史生成阶段。MCP 创建及生成请求在恢复后保留防重墓碑，临时草稿、生成响应缓存及批量结果在恢复事务中清除，旧文件产物因世代改变不可继续读取，恢复失败一并回滚。升级代码后应重启网页和 MCP 进程。可用 `get_mcp_status`、`get_ai_generation_request` 及响应 `meta.requestId` 对应的操作记录定位异常，详见 [MCP 接入](MCP.md)。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 提示密码至少 12 个字符 | 备份密码长度下限 | 换更长的密码；密码无法找回，也不要写进脚本历史 |
| 拒绝 JSON 文件 | 只接受首版 `.rlbackup` 加密容器 | 在设置页导出 `.rlbackup` 文件，并使用导出时的密码恢复 |
| 恢复被拒并提示版本不符 | 当前接受 manifest `1.0.0`、加密头 `1` 和数据库结构版本 `1` 至 `14` 的完整业务备份；三个版本号分别描述容器格式、加密封装和数据库结构 | 使用完整加密备份；v1 至 v13 业务备份可恢复到 v14，旧版本缺少的复盘来源快照、材料表格来源、岗位准备清单、题目图谱、补充笔记与仓库证据历史保持为空，本机创建回执不迁入，其他格式仍不自动转换 |
| 恢复失败且原数据未变 | 校验在系统临时目录中的隔离 SQLite 数据库与文件暂存区完成，失败不触碰现库 | 检查临时目录权限与可用空间，或换完整备份文件；库内数据完好 |
| 提示快照目录不可写 | 恢复前必须成功创建灾备快照 | 修复 `data/backups` 权限或磁盘空间后重试 |
| 提示「头像文件不完整」或「分块长度与清单不符」 | 备份文件被截断或传输损坏，`file` 记录与 manifest 里的清单对不上 | 换一份完整的备份文件重试；不要手工裁剪容器内容 |
| 头像无法读取 | 已引用头像的私有文件缺失或不可读 | 核对 `data/uploads/` 权限，必要时重新上传头像；本机头像 URL 只接受 `/api/uploads/…` |

备份容器只携带数据库引用的 `data/uploads/` 头像文件（1 MiB 分块、随密文加密），恢复时先写文件再换数据，因此不会出现「库里有指针但文件不存在」。恢复会隔离新数据库不再引用的本机头像，提交成功后清理，失败时放回；若备份里某张已引用头像缺失分块，整次恢复会被拒绝，而不是静默恢复出半张图。

每次恢复前都会创建 SQLite 灾备快照，并把当时可读取的已引用头像保存到同名的 `.uploads` 目录。最多保留 5 份，数据库与头像的合计预算为 `max(数据库文件大小 × 3, 256 MiB)`；超预算时会先清理最旧的整份快照。原本已丢失的头像无法由快照补回。

恢复头像会在 `data/uploads/.restore-<UUID>/` 先保存旧文件副本、新文件与持久清单；同一个恢复标记随数据库事务提交。若恢复期间进程被直接终止，下次打开数据库时会在写锁内核对标记：未提交则还原旧头像，已提交则清理暂存。再次恢复也会先完成上一次的补偿，补偿过程中再次退出可继续重试。清单或副本损坏时会停止打开数据库，保留目录和灾备快照供手动回退，不要自行删除这些恢复目录。已覆盖进程硬退出场景；Windows 文件内容会强制落盘，但 Node 不支持在该平台同步目录，真实掉电后的磁盘元数据持久性仍取决于文件系统。

恢复时解密数据会短暂写入系统临时目录的 `resume-life-restore-*`，其中可能包含简历、联系方式和 API Key。POSIX 下暂存目录为 `0700`，owner、staging SQLite 和头像分块为 `0600`；正常完成时目录立即删除。若进程异常退出，应用下次启动及之后每小时会清理创建超过 24 小时、所属进程已退出且身份核对通过的目录。无法核对所有者身份的目录不会自动删除；确认没有服务仍在使用后，再手动检查并清理。

健康检查的 `restoreStaging.count` 和 `oldestAgeMs` 只返回残留数量与年龄，不返回临时目录路径；数量持续增长或最老年龄超过 24 小时，应该先停止恢复任务并按上面的手动检查流程处置。

### 手动回退

手动回退时以恢复响应中的 `snapshotCreated` 路径为准。先停止应用并在别处复制整个数据目录，确认该 SQLite 文件通过 `PRAGMA integrity_check`，再逐一核对其中 `resume_modules` 及 `resume_versions` 的本机头像 URL 与同名 `.uploads` 目录里的文件。数据库与其同名 `.uploads` 目录须成对保留；原本缺失的头像不会出现在快照中。

在 PowerShell 中把下面的路径换成 `snapshotCreated`，可只读检查数据库和头像清单；输出缺失文件时，先判断它们在恢复前是否就已缺失：

```powershell
$env:RESUME_LIFE_SNAPSHOT = 'D:\data\backups\resume-life.db.pre-restore-<时间戳>-<随机串>'
@'
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const snapshot = process.env.RESUME_LIFE_SNAPSHOT;
const db = new DatabaseSync(snapshot, { readOnly: true });
try {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite 快照损坏');
  const rows = db.prepare("SELECT content FROM resume_modules WHERE type = 'basic'").all();
  const versions = db.prepare('SELECT snapshot FROM resume_versions').all();
  const avatars = rows.map(({ content }) => JSON.parse(content).avatar);
  for (const { snapshot } of versions) {
    for (const module of JSON.parse(snapshot).modules) {
      if (module.type === 'basic') avatars.push(module.content.avatar);
    }
  }
  const names = new Set(avatars.flatMap((url) => {
    if (typeof url !== 'string') return [];
    let parsed;
    try { parsed = new URL(url, 'http://localhost'); } catch { return []; }
    if (parsed.origin !== 'http://localhost' || url !== `${parsed.pathname}${parsed.search}` ||
        !/^\/(?:api\/)?uploads\/[A-Za-z0-9._-]{1,128}$/.test(parsed.pathname) ||
        (parsed.search && !/^\?v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed.search))) return [];
    const name = path.basename(parsed.pathname);
    return name === '.' || name === '..' ? [] : [name];
  }));
  const missing = [...names].filter((name) => !fs.existsSync(path.join(`${snapshot}.uploads`, name)));
  console.log(`已引用头像 ${names.size} 个，快照中缺失 ${missing.length} 个`);
  if (missing.length) console.warn('缺失文件：', missing.join(', '));
} finally { db.close(); }
'@ | node --experimental-sqlite
```

确认快照完整后，把当前 `resume-life.db`、`resume-life.db-wal` 和 `resume-life.db-shm` 移到保留目录，再把快照 SQLite 复制为 `data/resume-life.db`；将快照 `.uploads` 目录内的文件复制到 `data/uploads/`，同名文件选择覆盖。不要把 `.uploads` 目录本身放进 `data/uploads/`，也不要只替换数据库而遗漏头像。最后重启应用，检查简历记录与头像；确认无误前保留原数据目录的副本。

## 5. 模型相关

- **未配置**：设置页填 Base URL 与 API Key。两者任一为空即视为未配置，功能入口会提示。
- **连接测试失败**：`POST /api/settings/test` 对配置无效返回 400；共享模型并发名额已满返回 429；上游不可达或非 2xx 返回 502；整体 15 秒超时返回 504；客户端取消返回 499。错误正文均为 `{ok:false, error}`。探测与普通调用共享三个并发名额，最多生成 1024 输出 token，不自动重试；调用结果在用量页按“模型连接测试”查看。
- **413**：请求内容超过模型输入预算，应用在发出前就拒绝，不会消耗额度。可减少 JD/简历/问答记录的长度。
- **响应超过字节上限**：每次 SSE 请求的响应体按 fetch 解压后交付的字节累计，上限为 8 MiB；读取到导致越界的数据块后整块拒绝。可见正文最多 2 MiB，单个 SSE 事件按换行规范化后的 UTF-8 计算最多 256 KiB，非流式响应体仍最多 2 MiB。推理字段、重复元数据、未知事件与心跳都消耗 SSE 响应体预算，所以正文很短也可能触限。该错误按协议失败记录，不自动重试；字节限制与输出 token 预算、超时各自独立。
- **499**：请求已被取消（用户离开页面或点了取消）。属于正常路径，不是故障。
- **模型列表拉取失败**：`POST /api/settings/models` 对上游失败返回 502，与「配置无效」的 400 区分开。
- **用量看板的历史范围**：调用计量日志只保留最近 180 天，更早的记录会在每天首次调用时自动清理（清理会记一条 `llm.metering.pruned`）。需要长期留档请在清理前自行导出。

## 6. 搜索变慢

全局搜索仍以原有的 `LIKE '%关键词%'` 判断命中和排序，但对不少于 3 个 Unicode 字符、且不包含 `%`、`_`、反斜杠或双引号的关键词，先通过 SQLite FTS5 三元组索引筛出候选行，避免扫描所有长文本。较短的中文词和含转义字符的关键词保持原有的 `LIKE` 扫描，不会因为索引而漏搜。

应用已有的边界：

- 每个分类 `LIMIT 8`，输入截断到 100 字符。
- 查询耗时 ≥ 500 ms 时记录一条告警，便于判断是否已经触到上限：

  ```
  [server-warn] {"level":"warn","operation":"search.slow","requestId":"...","durationMs":1743,"context":{"queryLength":4,"thresholdMs":500,"resultCount":24}}
  ```

旧实现的基准：1 万条简历 + 1 万条较长模块内容时，单条查询约 1.7 秒。在另一个仅含合成数据的内存库中，1 万条简历 + 模块、查询罕见的 4 字中文词时，旧查询为 5555 ms，索引候选查询为 0.73 ms，结果一致；该数字不能代表实际磁盘、其他关键词或真实用户数据上的延迟。

- **可用性**：运行环境需满足仓库规定的 Node 24.21.0 及其 SQLite FTS5；较旧的 Node 23.x 不受支持。
- **同步方式**：八张被搜索的业务表各自通过数据库触发器维护派生索引，首次启动时会为旧库回填。备份格式和数据库版本保持不变；备份恢复会自动更新索引，缺失的索引可在下次启动时重建。
- **限制**：不足 3 字的查询不能使用三元组索引；`LIKE` 的 `ESCAPE` 子句也不能走该索引，所以 `%`、`_`、反斜杠和双引号查询使用原查询。仍应关注 `search.slow`，尤其是大量短词搜索。

每类结果仍限制 8 条，输入仍截断到 100 字符。

`/api/review` 的复盘聚合按作答主键分批读取并累计统计，已评分作答超过 10000 条时仍会全部计入。

## 7. 端口与访问范围

生产命令只监听 `127.0.0.1:3714`。应用提供本地单用户登录，首次启动设置用户名和密码，后续访问需要有效会话（见 [ADR-0004](./ADR.md#adr-0004)）。需要从其他设备访问时，请放在 VPN 或带身份认证与 TLS 的反向代理之后；不要直接把端口暴露到局域网或公网。

所有 `/api` 请求（含只读 GET）都会校验请求打到的 `Host`：默认白名单只有 `127.0.0.1`、`localhost` 与 `[::1]`。这挡住的是 DNS rebinding——恶意页面把域名解析到 127.0.0.1 后，Origin 与 Host 天然相等，仅比较两者无法拦截。

反向代理对外使用其他域名时：

- 把域名写进 `RESUME_LIFE_ALLOWED_HOSTS`（逗号分隔，如 `resume.example.com`），否则所有 API 请求会返回 403 `拒绝非本机来源的 API 请求`。
- 条目可以是裸域名、`域名:端口` 或 `https://域名`，三种写法都会被归一化成主机名后比较；无法解析的条目会被丢弃并在日志里留一条 `origin.allowedHosts` 的 warn。
- 让代理保留原始 `Host` 头（nginx 默认行为）。应用只认 `Host`，不认客户端可伪造的 `X-Forwarded-Host`。
- 局域网 IP 直连（如 `192.168.x.x:3714`）默认同样被拒绝，需要显式加入白名单。

端口被占用时需更改启动命令中的 `--port`。仓库的 npm 启动脚本显式固定为 3714，单独设置 `PORT` 环境变量不能覆盖该参数。已完成生产构建后，可从项目根目录用下列命令监听 3715，继续保留回环地址与 SQLite 运行参数：

```bash
node --experimental-sqlite node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3715
```

## 8. 请求体上限

| 场景 | 上限 |
| --- | --- |
| 普通 JSON 请求体 | 1 MiB |
| 简历 / 项目材料上传请求 | 12 MiB |
| 单个上传文件 | 10 MiB |
| 上传文件提取出的正文 | 200,000 字符 |
| 项目材料正文 | 200,000 字符 |
| 项目材料标题 | 200 个 Unicode 码点（粘贴、上传与编辑统一限制） |

前 3 行是**传输体积**（字节），超限返回 **413**，响应体只有固定的「请求体或文件过大」这类文案，不含具体是哪一个超了。

两类正文上限的超限状态码取决于内容从哪来：

- **来自上传文件**：解析阶段就抛格式错误，返回 **400**，响应体带可读原因（如「文本不得超过 200000 字符」）。
- **直接粘贴**：由 `assertProjectMaterial` 校验，返回 **413**，文案同样是固定的那几句。

材料标题超过 200 个 Unicode 码点时统一返回 **413**，不会截断后静默保存。

这些上限由共享的有界解析统一执行，路由无法绕过。

项目总结历史另受最终备份记录的 2 MiB 预算限制，计算包含总结、AI 基线、材料快照、字段名及 JSON 二次转义。超限时返回 413，当前总结、历史和同次请求的项目改名会一起回滚。应精简总结或材料标题后重试；缩短单个标题并不能代替聚合记录预算。

### 文件解析的沙箱与超时

解析 PDF / Word 都不会阻塞主进程：两者都在受限沙箱里跑，超时或崩溃只影响那一次导入。

| 类型 | 沙箱 | 上限 |
| --- | --- | --- |
| PDF | 独立子进程 | 10 秒 / 堆内存 512 MiB |
| Word（docx） | 独立 Worker | 10 秒 / 堆内存 128 MiB |

PDF 之所以用子进程而不是 Worker：pdf-parse 在 Node 下走 pdfjs 的 legacy 构建，该构建加载进 `worker_threads` 会以约一半的概率让整个进程段错误（SIGSEGV），实测 pdfjs-dist 5.4.296 在 Node 23.1 与 24.21 上均可复现。

超过上限时导入会失败并提示「文件内容无法解析」。若确认文件本身正常，通常是页数或嵌套结构过于复杂——把 PDF 拆小或另存为更简单的版本后重试。

### 构建追踪提示缺少 PDF 解析依赖

`npm run check:build-trace` 会逐项核对两个材料解析路由的依赖、PDF worker、字符映射和字体资源。npm 的平铺路径与 pnpm 的 `node_modules/.pnpm/...` 实际路径均按文件真实位置核对；链接与实际路径指向同一文件时应通过，缺失文件或其他目录下的同名文件不能代替所需资源。

若仍提示缺少依赖，先确认依赖已安装，再重新生成构建并检查：

```bash
npm run build
npm run check:build-trace
```

切换包管理器或重新安装依赖后，旧 `.next` 清单可能仍指向此前的安装路径，需要重新构建。仅在宿主 `node_modules` 中找到文件不能证明部署清单已包含它；应保留此检查，并核对 `next.config.ts` 的定向资源收录规则及对应路由的 `.nft.json`。

## 9. 依赖安全检查

安全检查需区分生产依赖和包含开发工具的完整依赖树：

```bash
npm audit --omit=dev --audit-level=moderate --registry=https://registry.npmjs.org
npm audit --audit-level=high --registry=https://registry.npmjs.org
```

部分 npm 镜像未实现审计接口，会返回 `404 NOT_IMPLEMENTED`；这表示检查未完成，不能视为没有漏洞。上面的命令直接使用官方审计接口。

2026-11-18 的原始完整审计报告有 14 个 high 开发依赖传播节点，均源自 GHSA-fc5q-39xc-vjpf；生产依赖为零。上游尚无修复版。本项目保留同名 4.0.7，通过安装期固定哈希补丁和经批准的限时精确政策执行发布检查，详情见 [SECURITY.md](../SECURITY.md)。原始 npm audit 仍可能返回非零，不能把它的报告改称零漏洞。

日常与发布检查使用：

```bash
npm run audit:dependencies
```

报告保存在 `.test-artifacts/dependency-audit/`。若跳过了安装脚本，先执行 `node scripts/patch-picomatch.mjs`，再运行 `npm run check:dependency-security`。若提示版本、文件哈希或锁文件漂移，应确认完整安装并审查依赖变更；不能删掉门禁或改写政策来放行。到期后需验证正式修复或重新开展安全审查，当前政策不会自动延期。

不要使用 `npm audit fix --force` 自动降级 ESLint、Vitest 或 Next 配置；保持锁文件和 vendor 适配器，经过兼容验证后再采用上游更新。上述数量是当日快照，后续以实际报告为准。

## 10. 本地 OCR 语言包

`npm run setup:ocr` 从 jsDelivr 获取固定版本的英文与简体中文模型，并校验解压后的字节数和 SHA-256。模型默认写入当前工作目录；设置 `RESUME_LIFE_OCR_DATA_DIR` 时必须使用绝对路径，准备与应用运行须使用同一路径。有效模型已存在时只校验，不重新下载。

### CDN 下载失败

若出现 `fetch failed`、`ECONNRESET` 或超时，先检查能否访问脚本中指定的 jsDelivr 地址。无法访问 CDN、但可访问官方 npm registry 时，可以获取相同的 `@tesseract.js-data/eng@1.0.0` 和 `@tesseract.js-data/chi_sim@1.0.0` 包，提取固定模型并交给原准备函数校验。以下步骤在项目根目录执行，需有 `tar` 命令；Windows 复验通过，Linux 实际执行尚未验证。

```bash
node -e "for (const language of ['eng', 'chi_sim']) require('node:fs').mkdirSync('.test-artifacts/ocr-download/' + language, { recursive: true })"
npm pack "@tesseract.js-data/eng@1.0.0" --pack-destination .test-artifacts/ocr-download/eng --registry=https://registry.npmjs.org
npm pack "@tesseract.js-data/chi_sim@1.0.0" --pack-destination .test-artifacts/ocr-download/chi_sim --registry=https://registry.npmjs.org
tar -xzf .test-artifacts/ocr-download/eng/tesseract.js-data-eng-1.0.0.tgz -C .test-artifacts/ocr-download/eng package/4.0.0_best_int/eng.traineddata.gz
tar -xzf .test-artifacts/ocr-download/chi_sim/tesseract.js-data-chi_sim-1.0.0.tgz -C .test-artifacts/ocr-download/chi_sim package/4.0.0_best_int/chi_sim.traineddata.gz
node --input-type=module -e "
import fs from 'node:fs';
import { prepareOcrAssets } from './scripts/prepare-ocr.mjs';
await prepareOcrAssets({ fetchImpl: async url => {
  const language = new URL(url).pathname.match(/\/(eng|chi_sim)@1\.0\.0\//)?.[1];
  if (!language) throw new Error('未审阅的 OCR 模型地址');
  const filename = '.test-artifacts/ocr-download/' + language + '/package/4.0.0_best_int/' + language + '.traineddata.gz';
  return new Response(fs.readFileSync(filename));
} });
"
npm run setup:ocr
```

最后一次 `setup:ocr` 应确认两份模型有效。原准备函数在全部模型大小与 SHA-256 通过后才写入，不修改版本、模型哈希或下载器，也不放宽校验。中间包保留在受忽略保护的 `.test-artifacts/`；模型与中间包均不应提交到仓库。

### 模型目录或初始化失败

确认运行账户能读取 `eng.traineddata` 与 `chi_sim.traineddata`，并核对准备和运行时的工作目录、`RESUME_LIFE_OCR_DATA_DIR`。本地 OCR 默认要求中英文模型，初始化失败会明确报错，不会静默只用英文。需要改用多模态识别时，在设置页选择并配置对应模型后重试。
