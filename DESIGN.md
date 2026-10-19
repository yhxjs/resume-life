# Design — resume-life

> 改样式前先读本文；新页面必须复用这里的令牌与组件词汇，禁止引入字面色值（hex / neutral-* / blue-* 等原生 Tailwind 色板）。

## Visual theme

「文房·备考」方向：深墨绿 chrome（品牌占据导航/页脚）、纸张底色上放纯白卡面、宋体 display 标题、mono 数字档案感。浅色为默认，跟随系统 `prefers-color-scheme` 提供暗色。所有颜色为 OKLCH 语义令牌，定义在 `src/app/globals.css`。

## Palette（Committed chrome + Restrained 内容区）

| 令牌 | 语义 | Light | Dark |
|---|---|---|---|
| `--bg` | 页面底色（微染纸面） | `oklch(0.985 0.006 110)` | `oklch(0.148 0.008 110)` |
| `--card` | 卡片/输入/浮层（纯白） | `oklch(1 0 0)` | `oklch(0.19 0.011 110)` |
| `--surface` | 卡内分区/悬停行 | `oklch(0.968 0.008 110)` | `oklch(0.228 0.013 110)` |
| `--surface-2` | 内嵌井（原文、代码块） | `oklch(0.945 0.011 110)` | `oklch(0.265 0.015 110)` |
| `--ink` | 正文 | `oklch(0.225 0.018 110)` | `oklch(0.925 0.01 110)` |
| `--muted` | 次要文本 | `oklch(0.46 0.022 110)` | `oklch(0.735 0.015 110)` |
| `--faint` | 元信息/占位符 | `oklch(0.515 0.02 110)` | `oklch(0.65 0.015 110)` |
| `--line` | 描边/分隔线 | `oklch(0.912 0.012 110)` | `oklch(0.268 0.013 110)` |
| `--line-strong` | 强描边 | `oklch(0.838 0.017 110)` | `oklch(0.348 0.016 110)` |
| `--primary` | 主色（按钮/选中/积极） | `oklch(0.52 0.115 110)` | `oklch(0.775 0.115 112)` |
| `--primary-hover` | 主色悬停 | `oklch(0.455 0.11 110)` | `oklch(0.83 0.1 112)` |
| `--primary-soft` | 主色淡染 | `oklch(0.942 0.038 110)` | `oklch(0.26 0.035 110)` |
| `--on-primary` | 主色填充上的文字 | white | `oklch(0.22 0.04 110)` |
| `--accent` | 琥珀点缀 | `oklch(0.52 0.12 75)` | `oklch(0.78 0.115 85)` |
| `--accent-wash` | 琥珀淡染 | `oklch(0.955 0.032 85)` | `oklch(0.26 0.03 85)` |
| `--danger` | 危险 | `oklch(0.53 0.175 26)` | `oklch(0.665 0.17 26)` |
| `--danger-wash` | 危险淡染 | `oklch(0.958 0.02 26)` | `oklch(0.26 0.035 26)` |
| `--chrome` | 墨绿导航/页脚底 | `oklch(0.29 0.028 128)` | `oklch(0.20 0.022 128)` |
| `--chrome-ink` | chrome 文字 | `oklch(0.94 0.015 110)` | `oklch(0.93 0.012 110)` |
| `--chrome-muted` | chrome 次要 | `oklch(0.75 0.03 115)` | `oklch(0.70 0.022 115)` |
| `--chrome-line` | chrome 内分隔/悬停 | `oklch(0.38 0.032 128)` | `oklch(0.30 0.026 128)` |
| `--chrome-active` | chrome 激活胶囊 | `oklch(0.80 0.105 112)` | 同 light |
| `--on-chrome-active` | 激活胶囊文字 | `oklch(0.26 0.05 115)` | 同 light |
| `--chrome-dot` | 品牌圆点 | `oklch(0.8 0.14 112)` | 同 light |

## Typography

- 三轨制：**宋体 display**（`--font-serif` = Songti SC / SimSun 系统回退）只用于 h1 页标题、章节标题、品牌字标、列表行标题；**无衬线**（Geist + 系统中文字体）承载正文与表单；**mono**（Geist Mono）用于纯数字/计分——档案感。
- 阶梯（全局适度平移，提升可读性）：
  - 页标题：26px ~ 28px (`text-2xl` ~ `text-3xl`)
  - 详情页标题：24px
  - 章节标题：16px ~ 17px (`text-base`)
  - 正文与表单：15px (`text-sm` 平移后 / body 默认基准)
  - 表单标签与辅助文本：13px (`text-xs` 平移后)
  - 最小角标与元信息底线保护：11px ~ 12px (通过全局选择器托底保护，防笔画粘连模糊)
  - 首页 hero：34–40px
- h1–h3 使用 `text-balance`；长段说明 `text-pretty`。
- A4 简历导出与纸张预览沙箱：`.paper` 独立维护基于打印物理规范的紧凑绝对字阶（12px 基础），与全站 Web 界面缩放严格隔离。

## 签名元素（品牌记忆点）

- 品牌字标「简历奕生」：宋体 + 橄榄圆点（导航）；拉丁名 resume-life 仅作辅助，用于页脚与 metadata
- 墨绿 chrome 导航 + 底部 2px 橄榄线
- 章节标题 = 橄榄方块 + 宋体（`SectionTitle`）；首页 hero 下短橄榄规则线
- 首页列表上下 3px 双线（印刷规则线）
- mono 计分数字（评分卡/报告/题号）

## Components（词汇表，见 `src/lib/ui.ts` 与 `src/components/common/ui-bits.tsx`）

- **按钮**：`btnPrimary`（橄榄绿实心）/ `btnGhost`（描边）/ `btnDanger`（红描边）/ `btnDangerSolid`（确认弹窗用实心红）。一律 `rounded-lg`、`focus-visible` 焦点环、`disabled:opacity-50`。
- **输入**：`inputCls`（单行，描边 + 白底 + focus 主色环）；多行 `textareaShortCls`（min-h-32）/ `textareaCls`（min-h-40）/ `textareaTallCls`（min-h-48）；表单标签 `labelCls`（`text-xs font-medium text-muted`）。
- **面板**：`cardCls` = `rounded-xl border border-line bg-bg`，内边距按需。浮层（弹窗）用 `shadow-xl` 无描边。
- **页面头**：`PageHeader`（标题 + 说明 + 右侧动作插槽）。
- **列表行**：`divide-y divide-line`，行内悬停 `hover:bg-surface rounded-lg`。
- **状态**：文本状态用 `text-ok / text-warn / text-err / text-info`；徽章 `badgeCls` 胶囊形。
- **评分配色**：`scoreTextCls(v)`：≥7 主色绿、≥4 琥珀、<4 红（练习/面试通用）。
- **加载/空态**：`Loading`（骨架脉冲）、`Empty`（提示 + 引导动作）。

## Layout

- 五级分层宽度阶梯体系（充裕呼吸感与可读性平衡）：
  - **Tier 0 全局外壳**：`main`、`site-nav`、`footer` 统一 `max-w-[1600px] px-4 sm:px-6`；1080p 下占 83.3%，双侧留白 160px，支撑内部大画布扩展。
  - **Tier 1 沉浸看板与重型双栏**：`max-w-[1600px]`（简历样式工厂、求职全景看板）；样式工厂左侧 794px A4 纸张 1:1 原生高清呈现免缩放；`max-w-[1440px]`（能力复盘看板、薪资对战室）。简历编辑器双栏 `lg:grid-cols-[minmax(0,1fr)_480px]`。
  - **Tier 2 标准业务大厅与列表**：`max-w-7xl` (1280px)（首页工作台、简历管理列表、技术知识库、模拟面试、题目精练、自我介绍、错题温习本、通用题库、工具箱导航、用量统计）。
  - **Tier 3 辅助工具与人岗对比**：`max-w-6xl` (1152px)（各工具输入页与连打面试）与 `max-w-5xl` (1024px)（工具报告详情）。
  - **Tier 4 专注表单与向导流程**：`max-w-3xl` (768px)（系统设置，保障 3 列协议切换卡舒展且文本不过长）与 `max-w-4xl` (896px)（简历导入解析向导）。
- 顶栏 sticky + `bg-chrome`，高 h-14；z 轴：sticky(30) < 弹窗遮罩(50)。
- 圆角阶梯：控件 8px（rounded-lg）、面板 12px（rounded-xl）、标签胶囊 full。
- 阅读行宽安全防护：长段落说明、描述严格施加 `max-w-prose`（约 65 半角字符）保护，杜绝大屏下长文本行导致眼球疲劳。

## Data and interaction boundaries

- 应用开发和生产命令只监听 `127.0.0.1`；跨设备访问必须由外部 VPN 或带认证与 TLS 的反向代理承担身份边界。
- `.rlbackup` 是强制密码保护的加密容器。导入使用当前页面内存中的密码自动解密并校验，不支持明文 JSON 文件；API Key 只存在于密文记录中。
- 请求读取、文件上传、项目材料正文、模型输入和备份记录分别使用共享预算模块，超限请求在解析或持久化前拒绝。
- 列表页使用稳定游标分页；搜索由共享可取消防抖 Hook 管理，过期响应不能覆盖当前筛选状态。
- 遮罩工作流复用统一 `Modal`/`Drawer` 语义原语，详情页和工具页使用数据 Hook 与领域显示组件分离网络命令和展示职责。

## Motion

- 只动状态：hover/focus/保存反馈；`transition-colors` 150ms，指数缓出。
- 弹窗 120ms 淡入 + 轻微缩放；全局 `prefers-reduced-motion` 降级为即时切换。
- 无页面加载编排动画。
