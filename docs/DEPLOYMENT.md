# 部署说明

本文描述本机或受控服务器上的源码部署。项目提供一组本机登录凭证，没有注册、多用户、租户隔离或远程托管服务。

## 前置条件

- Node.js `>=24.21.0 <25`；
- 可写的绝对数据目录；POSIX 系统应让服务账户独占该目录，应用会将新建目录设为 `0700`、文件设为 `0600`；
- 所有非测试运行（包括本机 `npm run dev`）保存 AI API Key 或代理密码前必须设置独立、随机且不写入备份的 `RESUME_LIFE_SETTINGS_KEY`，重启时沿用同一个值；仅手动使用且不保存凭证时可留空；
- 运行浏览器测试或 PDF 相关检查时安装 Chromium；
- 第一次准备 OCR 模型时可访问 npm CDN。

## 备份资源限制

备份导出、校验和恢复共用一个跨进程任务名额，同一数据目录最多运行一个重型备份任务；超额请求返回 429 和 Retry-After。每个任务最多运行 30 分钟，连续 60 秒没有传输进展会停止；未开始下载响应时超时返回 408，已开始下载时会中断响应流。客户端取消会停止上传读取/导出生产器，清理完成后释放名额；异常退出的租约最多约 31 分钟后自动回收。正常大备份若超过总时长，应先缩减无用数据或在确认资源容量后调整代码预算，反向代理的超时不应比这些应用限制更短。

导出连接关闭或暂存清理失败时，进程会每秒重试清理并续租，直到资源释放后才归还名额；重试不会再次执行恢复。持续返回 429 时应根据服务端清理日志排查目录权限、磁盘与占用句柄，修复后会自动恢复准入。进程退出后的租约从最后续租时间起最多约 31 分钟回收。

## PowerShell

先使用自己的 Node 版本管理器准备 Node.js 24.21.0，并通过 `node --version` 确认。

```powershell
node --version
$env:NEXT_TELEMETRY_DISABLED = "1"
npm ci
$env:RESUME_LIFE_DATA_DIR = "C:\data\resume-life"
$env:RESUME_LIFE_SETTINGS_KEY = "从密钥管理器注入的随机高熵值"
$env:RESUME_LIFE_OCR_DATA_DIR = "C:\data\resume-life-ocr"
npm run setup:ocr
npx playwright install chromium
npm run check:release
npm run build
npm start
```

## POSIX shell

```bash
export NEXT_TELEMETRY_DISABLED=1
npm ci
export RESUME_LIFE_DATA_DIR=/var/lib/resume-life
export RESUME_LIFE_SETTINGS_KEY="从密钥管理器注入的随机高熵值"
export RESUME_LIFE_OCR_DATA_DIR=/var/lib/resume-life-ocr
npm run setup:ocr
npx playwright install chromium
npm run check:release
npm run build
npm start
```

`npm start` 使用现有脚本绑定回环地址。不要把真实数据库、上传目录、OCR 模型或 `.env` 文件复制到公开发布包。

本机开发可按 README 的一次性命令生成项目根目录下的 `.env.local`，已有文件不会被覆盖；服务部署应从独立密钥管理器或受保护的启动环境注入同一密钥。不要在每次启动时重新生成密钥，缺失时设置保存会返回明确的 `RESUME_LIFE_SETTINGS_KEY` 配置提示；配置后重启应用再保存。

## 诊断顺序

1. 运行 `node scripts/check-runtime.mjs` 确认 Node 版本；
2. 检查数据目录和 OCR 目录是否为绝对路径且可写；
3. 重新运行 `npm run setup:ocr`，它会校验固定模型的大小和 SHA-256；
4. 运行 `npm run check:public-assets` 检查公开资产目录是否混入私有头像；
5. 查看结构化 `requestId` 日志，不上传原始请求正文或数据库。

## 对外访问风险

应用有内置单用户登录，首次启动在回环地址的登录页初始化用户名和密码，之后业务接口统一验证会话。会话有效期 7 天，访问时节流续期；认证入口与健康检查公开。错误凭证每分钟最多尝试 5 次，密码校验并发上限为 2，超限返回 429 和 `Retry-After`。认证预算与模型并发预算保存在数据目录的 `process-budgets.db` sidecar 中，短期 lease 会自动回收崩溃进程留下的名额；多进程共享同一数据目录时不要复制数据库文件。

若必须多机访问，反向代理或网关仍须提供 TLS、网络隔离、访问控制、速率限制和审计；配置 `RESUME_LIFE_ALLOWED_HOSTS`，并显式设置 `RESUME_LIFE_SECURE_COOKIES=true`，使首次签发、续期及注销的会话 Cookie 都带 `Secure`。应关闭明文 HTTP 入口或设置 HTTPS 跳转与 HSTS。普通本机 HTTP 使用时该变量留空，应用不会信任客户端提供的 `x-forwarded-proto` 来决定安全属性。

忘记密码时可暂时设置 `RESUME_LIFE_AUTH_REINIT=true` 后重启，重新初始化会覆写凭证并撤销所有旧会话，其他业务数据不变。首次初始化和逃生门都只接受 `localhost`、`127.0.0.1` 或 `::1` 的 Host，请在服务器本机或 SSH 隧道中操作；成功逃生门请求会清除当前进程变量，服务管理器中的持久配置仍须删除。AI API Key 与代理密码使用 `RESUME_LIFE_SETTINGS_KEY` 做 AES-256-GCM 加密；用户导出的备份清空 API Key 与代理密码（含设备绑定的密文），保留普通设置。恢复默认保留当前设备配置，关闭该选项后需要重新填写凭证。加密密钥不要与数据库或备份放在同一目录。

模型视觉 OCR 每次最多发送 5 张图片，单张最多 5 MiB、总计最多 20 MiB；超限请求会在发送前拒绝。目录浏览每次最多返回 200 个子目录，响应中的 `truncated=true` 表示仍有未返回条目。生产部署应把数据目录放在本地磁盘，避免网络文件系统关闭 WAL 或改变文件权限语义。
