import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_DB_VERSION } from "../db-schema";
import { ANSWER_SCORING_RULES, INTERVIEW_MATCH_SCORE_RULE, REFERENCE_ANSWER_RULES } from "../prompt-guidelines";
import { JARGON_DECODER_SYSTEM_PROMPT } from "../jargon-decoder-llm";
import { RESUME_DEFENSE_DRILL_SYSTEM_PROMPT, RESUME_DEFENSE_SCAN_SYSTEM_PROMPT } from "../resume-defense-llm";
import { SALARY_NEGOTIATION_OPENING_PROMPT } from "../salary-negotiation-llm";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

const navSource = read("src/components/layout/site-nav.tsx");
const readme = read("README.md");
const requirements = read("docs", "REQUIREMENTS.md");
const toolsPage = read("src", "app", "tools", "page.tsx");
const product = read("PRODUCT.md");
const apiDoc = read("docs", "API.md");
const troubleshooting = read("docs", "TROUBLESHOOTING.md");

const tools = [
  { requirement: "JD 考点画像", page: "JD 考点画像" },
  { requirement: "面试黑话与暗号解码器", page: "面试黑话与暗号解码器" },
  { requirement: "简历排雷与防御演练", page: "简历排雷与防御演练" },
  { requirement: "离职与空窗沟通准备", page: "离职与空窗沟通准备" },
  { requirement: "Offer 谈判与薪酬博弈模拟器", page: "Offer 谈判与薪酬博弈模拟器" },
  { requirement: "个人作品集静态主页", page: "个人作品集与静态主页" },
];

/** 导航项：`{ href: "/x", label: "…" }`，下拉分组的子项与直达链接写法一致 */
function navEntries(): { href: string; label: string }[] {
  return [...navSource.matchAll(/href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/gu)]
    .map(([, href, label]) => ({ href: href!, label: label! }));
}

/** 取文件里某个二级标题到下一个二级标题之间的正文 */
function section(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) return "";
  const rest = source.slice(start + heading.length);
  const end = rest.search(/\n## /u);
  return end === -1 ? rest : rest.slice(0, end);
}

/** 源码树里全部路由文件 → 路径 + 导出的方法名 */
function routes(): { routePath: string; methods: string[] }[] {
  const apiRoot = path.join(root, "src", "app", "api");
  const found: { routePath: string; methods: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "route.ts") {
        const source = fs.readFileSync(full, "utf8");
        found.push({
          routePath: `/${path.relative(path.join(root, "src", "app"), dir).split(path.sep).join("/")}`,
          methods: [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/gu)]
            .map(([, method]) => method!)
            .sort(),
        });
      }
    }
  };
  walk(apiRoot);
  return found.sort((a, b) => a.routePath.localeCompare(b.routePath));
}

describe("文档能力清单契约", () => {
  it("能从 site-nav.tsx 解析出导航项（提取器自身有效）", () => {
    const entries = navEntries();
    expect(entries.length).toBeGreaterThanOrEqual(12);
    expect(entries.map((e) => e.label)).toContain("错题本");
  });

  it("README 功能清单覆盖全部导航入口", () => {
    const capabilities = section(readme, "## 功能");
    expect(capabilities).not.toBe("");
    // 首页是根路径，不是一项能力，不要求出现在进度清单里
    const missing = navEntries()
      .filter((entry) => entry.href !== "/")
      .filter((entry) => !capabilities.includes(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it("REQUIREMENTS 的产品定位覆盖全部导航入口", () => {
    const positioning = section(requirements, "## 1. 产品定位");
    expect(positioning).not.toBe("");
    const missing = navEntries()
      .filter((entry) => entry.href !== "/")
      .filter((entry) => !positioning.includes(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it("REQUIREMENTS 的当前认证定位引用 ADR-0004，不沿用无登录决策", () => {
    const positioning = section(requirements, "## 1. 产品定位");
    expect(positioning).toContain("ADR.md#adr-0004");
    expect(positioning).not.toContain("无登录");
    expect(positioning).toContain("登录");
  });

  it("JD 画像需求不强迫凑技能数或把准备权重误写成必考概率", () => {
    const jdPortrait = section(requirements, "### 8.1 JD 考点画像");
    expect(jdPortrait).toContain("最多 8 项");
    expect(jdPortrait).toContain("没有可靠考点时可为空");
    expect(jdPortrait).toContain("少于 3 项时不绘制雷达图");
    expect(jdPortrait).toContain("不代表必考概率");
    expect(jdPortrait).not.toContain("5-8 项");
  });

  it("JD 画像的追问方向描述准备建议，不固定凑数或预测真实必问题", () => {
    const jdPortrait = section(requirements, "### 8.1 JD 考点画像");
    expect(jdPortrait).toContain("通常 3-5 个，材料不足时可减少，最多 6 个");
    expect(jdPortrait).toContain("通常附 2-4 个问题，材料不足时可缩减为 1 个，最多 5 个");
    expect(jdPortrait).toContain("不预测真实面试必问内容");
    expect(jdPortrait).not.toContain("最可能被深挖");
  });

  it("JD 画像入口与雷达呈现条件一致，不承诺必考项或必有雷达", () => {
    const jdPortrait = section(requirements, "### 8.1 JD 考点画像");
    expect(jdPortrait).toContain("有至少 3 项可靠考点时呈现**考点雷达**");
    expect(toolsPage).toContain("有原文依据的准备重点与练习方向");
    expect(toolsPage).toContain("信息不足时不凑考点，也不预测真实面试必问");
    expect(toolsPage).not.toContain("必考技能");
    expect(toolsPage).not.toContain("生成考点雷达");
  });

  it("工具箱需求清单与页面入口数量和能力名称一致", () => {
    const toolsRequirements = section(requirements, "## 8. 工具箱");
    const pageToolCount = [...toolsPage.matchAll(/href:\s*"\/tools\//gu)].length;
    const requirementsToolCount = [...toolsRequirements.matchAll(/^### 8\.\d+ /gmu)].length;

    expect(pageToolCount).toBe(6);
    expect(requirementsToolCount).toBe(pageToolCount);
    expect(requirements).toContain("当前包含 6 个工具");
    for (const tool of tools) {
      expect(toolsPage).toContain(`title: "${tool.page}"`);
      expect(toolsRequirements).toContain(tool.requirement);
    }
  });

  it("上下文和数据库注释沿用 JD 准备建议口径", () => {
    const context = read("CONTEXT.md");
    const schema = read("src", "lib", "db-schema.ts");
    expect(context).toContain("技能准备优先级");
    expect(context).toContain("至少有 3 项可靠考点时才显示考点雷达");
    expect(context).not.toContain("必考技能雷达图");
    expect(schema).toContain("技能准备优先级");
    expect(schema).not.toContain("必考技能/追问方向/公司风格");
  });

  it("空窗沟通需求不强求把经历包装为成长成果", () => {
    const gapRemedy = section(requirements, "### 8.4 离职与空窗沟通准备");
    expect(gapRemedy).toContain("如实说明离职原因、空窗安排与求职动机");
    expect(gapRemedy).toContain("信息不足时提示待补充");
    expect(gapRemedy).toContain("不强求把经历包装成成长成果");
    expect(gapRemedy).toContain("求职者选择的表达风格");
    expect(gapRemedy).toContain("风格只调整语气与组织，不改变事实");
    expect(gapRemedy).toContain("话术与追问回答可复制");
    expect(gapRemedy).not.toContain("一键送入排雷演练");
    expect(gapRemedy).not.toContain("人物风格");
    expect(gapRemedy).not.toContain("重塑为合理求职动机与成长契机");
  });

  it("谈薪需求描述多轮模拟和练习边界，不串入其他工具能力", () => {
    const negotiation = section(requirements, "### 8.5 Offer 谈判与薪酬博弈模拟器");
    expect(negotiation).toContain("多轮模拟招聘方出价与候选人回应");
    expect(negotiation).toContain("报价、预算和心理状态均为练习设定");
    expect(negotiation).toContain("分析薪酬结构、候选人表达与谈判策略");
    expect(negotiation).toContain("不承诺现实涨薪幅度或谈判结果");
    expect(negotiation).not.toContain("招聘追问练习");
    expect(SALARY_NEGOTIATION_OPENING_PROMPT).toContain("这是谈判练习");
    expect(SALARY_NEGOTIATION_OPENING_PROMPT).toContain("不许承诺现实涨薪幅度");
  });

  it("谈薪入口不再暗示真实 HR 心理、说服效果或涨薪保证", () => {
    expect(toolsPage).toContain("练习多轮模拟谈判；区分模拟报价与已知条件");
    expect(toolsPage).toContain("查看回复建议和结束复盘");
    expect(toolsPage).toContain("模拟 HR · 谈判复盘");
    expect(toolsPage).toContain("开始薪酬谈判练习");
    expect(toolsPage).not.toContain("HR 施压拉扯");
    expect(toolsPage).not.toContain("拆解说服逻辑");
    expect(toolsPage).not.toContain("高情商话术");
  });

  it("练习评分需求不把 STAR 或 authenticity 维度写成事实核验", () => {
    const scoring = section(requirements, "### 5.3 作答与评分");
    expect(scoring).toContain("STAR 仅作经历题的可选组织工具，不要求机械套用");
    expect(scoring).toContain("叙述的具体性、自洽性及与可见材料的一致性");
    expect(scoring).toContain("模型无法核验事实真伪");
    expect(scoring).toContain("缺少数据不等于造假");
    expect(scoring).not.toContain("STAR 完整性");
    expect(scoring).not.toContain("能识别编造");
    expect(ANSWER_SCORING_RULES).toContain("STAR 只作经历梳理工具，不因未套模板扣分");
    expect(ANSWER_SCORING_RULES).toContain("structure 只看信息组织、表达清晰度、主次与逻辑衔接，不替代技术正确性判断");
    expect(ANSWER_SCORING_RULES).toContain("四维各按自身定义独立评分，同一缺陷只在最直接受影响的维度体现");
    expect(ANSWER_SCORING_RULES).toContain("不要把技术错误自动扩成结构差或答题不完整");
    expect(ANSWER_SCORING_RULES).toContain("authenticity 评价叙述的具体性、自洽性与材料一致性，不能核验事实真伪");
    expect(ANSWER_SCORING_RULES).toContain("知识题或明确的假设题没有真实经历陈述时，不因缺少经历材料给 authenticity 扣分");
    expect(ANSWER_SCORING_RULES).toContain("JSON 示例中的分数只展示整数类型，不是默认评分");
    expect(ANSWER_SCORING_RULES).toContain("简短且充分时可以少于示例句数，不重复评分理由或补评题干未要求的内容");
    expect(INTERVIEW_MATCH_SCORE_RULE).toContain("只评价本场回答中已展示的岗位相关证据");
    expect(INTERVIEW_MATCH_SCORE_RULE).toContain("不把简历中提到但本场未展示的技能或经历计作回答证据");
    expect(INTERVIEW_MATCH_SCORE_RULE).toContain("未考察的要求应说明为未知而非候选人不具备");
  });

  it("参考答案需求不承诺权威标准或固定模板，并保留信息不足时的两种表达方式", () => {
    const scoring = section(requirements, "### 5.3 作答与评分");
    expect(scoring).toContain("按题干实际要求给出知识解释、假设情境下的处理思路或基于已知事实的经历示范");
    expect(scoring).toContain("不强求 STAR、特定技术选型或量化成果");
    expect(scoring).toContain("待补充标记或条件式回答框架");
    expect(scoring).not.toContain("标准答案要点");
    expect(scoring).not.toContain("STAR 示范作答");
    expect(REFERENCE_ANSWER_RULES).toContain("用待补充标记或条件式框架");
    expect(REFERENCE_ANSWER_RULES).toContain("不把自己的技术选择或步骤列表写成唯一正确答案");
    expect(REFERENCE_ANSWER_RULES).toContain("只保留与本题要求相关且有来源的事实");
    expect(REFERENCE_ANSWER_RULES).toContain("不带入同一项目中与本题无关的独立工作");
  });

  it("黑话解码需求使用可能解释与风险信号，不承诺识别真实意图或风险概率", () => {
    const jargon = section(requirements, "### 8.2 面试黑话与暗号解码器");
    expect(jargon).toContain("可能的正常/风险解释、判断依据与不确定性");
    expect(jargon).toContain("不能单独证明真实工时、管理水平或隐藏意图");
    expect(jargon).toContain("风险信号强度评分");
    expect(jargon).toContain("不代表真实风险概率");
    expect(jargon).not.toContain("真实含义");
    expect(jargon).not.toContain("整体踩坑指数");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("先解释字面含义，再给出可能的解释与核实问题");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("表示文本中风险信号的强度，不是真实风险概率");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("JSON 示例中的 medium 仅展示合法枚举值，不是默认等级");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("每条线索须结合原文依据、条件和不确定性独立评级");
  });

  it("简历排雷需求允许无明确问题，不暗示模型必须找出高危软肋", () => {
    const defense = section(requirements, "### 8.3 简历排雷与防御演练");
    expect(defense).toContain("严格、直接、讲证据的技术面试官");
    expect(defense).toContain("引用简历原文并说明具体依据");
    expect(defense).toContain("最多 8 项");
    expect(defense).toContain("没有明确问题时可以没有条目");
    expect(defense).toContain("不代表事实已核验或不存在其他风险");
    expect(defense).not.toContain("毒舌");
    expect(defense).not.toContain("高危软肋");
    expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("没有明确问题时 items 为 []，整体 risk_level 为 low");
    expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("无明确问题时说明审阅范围，不夸大缺口");
    expect(RESUME_DEFENSE_DRILL_SYSTEM_PROMPT).toContain("JSON 示例中的 75 仅展示合法分数类型，不是默认分");
    expect(RESUME_DEFENSE_DRILL_SYSTEM_PROMPT).toContain("不受原简历排雷等级或参考示范答案影响");
    expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("每个风险必须有可引用的原文与明确理由");
    expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("没有具体相关禁忌时返回 []");
    expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("不暗示候选人曾失实作答");
    expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain('"taboo_mistakes": []');
  });

  it("PRODUCT 的能力清单覆盖全部导航入口", () => {
    const missing = navEntries()
      .filter((entry) => entry.href !== "/")
      .filter((entry) => !product.includes(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });
});

describe("API 契约文档契约", () => {
  const documented = new Map<string, string[]>();
  for (const [, routePath, methods] of apiDoc.matchAll(/\|\s*`([^`]+)`\s*\|\s*([A-Z, ]+?)\s*\|/gu)) {
    documented.set(routePath!, methods!.split(",").map((m) => m.trim()).sort());
  }

  it("能解析出文档里的端点表（提取器自身有效）", () => {
    expect(documented.get("/api/health")).toEqual(["GET"]);
    expect(documented.get("/api/applications")).toEqual(["GET", "POST"]);
  });

  it("每个 route.ts 的路径与方法都在 docs/API.md 中登记", () => {
    const missing = routes()
      .filter((route) => {
        const listed = documented.get(route.routePath);
        return !listed || listed.join(",") !== route.methods.join(",");
      })
      .map((route) => `${route.routePath} [${route.methods.join(",")}]`);
    expect(missing).toEqual([]);
  });

  it("文档里的端点数量与源码一致，且正文标注的总数正确", () => {
    const actualRoutes = routes();
    const total = actualRoutes.length;
    // 正文写死的数字同样要跟得上，否则「共 73 个」这种说明会先过期
    expect(apiDoc.match(/共 (\d+) 个路由文件/u)?.[1]).toBe(String(total));
    expect([...documented.keys()].sort()).toEqual(actualRoutes.map((route) => route.routePath).sort());
  });

  it("两个自定义备份请求头都被文档化", () => {
    // 密码走 header 而非 body，是脚本作者最容易踩的坑
    expect(apiDoc).toContain("X-Resume-Life-Backup-Password");
    expect(apiDoc).toContain("X-Resume-Life-Preserve-Ai-Config");
  });

  it("投递关联和简历排雷来源的 JSON ID 严格类型边界有文档契约", () => {
    expect(apiDoc).toContain("`resume_id`、`resume_version_id`、`interview_id`、`interview_series_id` 仅接受 JSON 数字类型的正安全整数");
    expect(apiDoc).toContain("`resumeId` 必须是 JSON 数字类型的正安全整数");
    expect(apiDoc).toContain("已有简历存在时省略或清空 `resume_version_id` 仍按既有规则解析默认发布版");
    expect(apiDoc).toContain("数字字符串不再兼容");
  });

  it("API 描述的数据库版本与当前实现一致", () => {
    const documentedVersion = apiDoc.match(/数据库结构版本为\s*`(\d+)`/u)?.[1];
    expect(Number(documentedVersion)).toBe(CURRENT_DB_VERSION);
  });

  it("README 与排障文档的数据库版本与当前实现一致", () => {
    expect(readme.match(/数据库结构版本为 \*\*(\d+)\*\*/u)?.[1]).toBe(String(CURRENT_DB_VERSION));
    expect(troubleshooting.match(/当前数据库结构版本为 `(\d+)`/u)?.[1]).toBe(String(CURRENT_DB_VERSION));
  });
});

describe("运行时版本描述契约", () => {
  it("运行时文档与首版配置示例保持一致", () => {
    expect(troubleshooting).toContain("24.21.0");
    expect(readme).toContain("npm run setup:ocr");
  });

  it("排障文档沿用当前单用户登录决策，不再声称没有账号体系", () => {
    const access = section(troubleshooting, "## 7. 端口与访问范围");
    expect(access).toContain("本地单用户登录");
    expect(access).toContain("ADR.md#adr-0004");
    expect(access).not.toContain("应用没有账号体系");
  });

  it("换端口命令保留 SQLite 与回环地址，并解释 npm 脚本的显式端口", () => {
    const access = section(troubleshooting, "## 7. 端口与访问范围");
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts.start).toContain("--port 3714");
    expect(access).toContain("单独设置 `PORT` 环境变量不能覆盖该参数");
    expect(access).toContain("node --experimental-sqlite node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3715");
  });
});
