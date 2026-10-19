/** JD 考点画像的领域类型与 AI 输出规整（工具箱首个工具，见 CONTEXT.md） */

export type JdMustSkill = {
  /** 考点/技能名（2-8 字，作雷达轴标签） */
  name: string;
  /** 必考程度 1-10，雷达取值 */
  weight: number;
  /** 判断依据（JD 中的哪条要求支撑这个判断） */
  why: string;
};

export type JdFollowup = {
  /** 追问方向/话题 */
  topic: string;
  /** 该方向下最可能被追问的具体问题 */
  questions: string[];
};

export type JdCompanyStyle = {
  /** 公司/团队风格猜测（一句话） */
  style: string;
  /** 从 JD 中读出的推断信号 */
  signals: string[];
};

export type JdPortraitResult = {
  /** 岗位速写：一句话概括方向/级别/技术栈 */
  role: string;
  mustSkills: JdMustSkill[];
  followups: JdFollowup[];
  companyStyle: JdCompanyStyle;
};

const MAX_SKILLS = 8;
const MAX_FOLLOWUPS = 6;
const MAX_QUESTIONS = 5;
const MAX_SIGNALS = 5;

/** 把 0-10 以外的必考程度拉回量表（容忍百分比写法），非法值回退 5 */
function normalizeWeight(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 5;
  const v = n > 10 && n <= 100 ? n / 10 : n;
  return Math.round(Math.min(10, Math.max(1, v)));
}

function strList(raw: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, max);
}

/** 清洗 AI 生成的画像：必考技能/追问方向/公司风格三者缺一即整体无效返回 null（提示重试） */
export function normalizeJdPortrait(raw: unknown): JdPortraitResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const role = typeof o.role === "string" ? o.role.trim().slice(0, 60) : "";

  const skills: JdMustSkill[] = [];
  if (Array.isArray(o.must_skills)) {
    for (const item of o.must_skills.slice(0, MAX_SKILLS)) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;
      const name = typeof s.name === "string" ? s.name.trim().slice(0, 20) : "";
      if (!name) continue;
      skills.push({
        name,
        weight: normalizeWeight(s.weight),
        why: typeof s.why === "string" ? s.why.trim().slice(0, 120) : "",
      });
    }
  }
  // 雷达至少三个轴才成立；LLM 按必考程度降序给出，这里排序兜底
  if (skills.length < 3) return null;
  skills.sort((a, b) => b.weight - a.weight);

  const followups: JdFollowup[] = [];
  if (Array.isArray(o.followups)) {
    for (const item of o.followups.slice(0, MAX_FOLLOWUPS)) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const topic = typeof f.topic === "string" ? f.topic.trim().slice(0, 40) : "";
      if (!topic) continue;
      const questions = strList(f.questions, MAX_QUESTIONS, 120);
      followups.push({ topic, questions });
    }
  }
  if (followups.length === 0) return null;

  const styleRaw = o.company_style;
  let companyStyle: JdCompanyStyle | null = null;
  if (styleRaw && typeof styleRaw === "object") {
    const c = styleRaw as Record<string, unknown>;
    const style = typeof c.style === "string" ? c.style.trim().slice(0, 80) : "";
    if (style) companyStyle = { style, signals: strList(c.signals, MAX_SIGNALS, 120) };
  }
  if (!companyStyle) return null;

  return { role, mustSkills: skills, followups, companyStyle };
}

/** 解析库中保存的画像 JSON（写入前已过 normalizeJdPortrait 校验，读取只做防损坏的形状检查） */
export function parseJdPortraitResult(json: string): JdPortraitResult | null {
  try {
    const parsed = JSON.parse(json) as JdPortraitResult;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.mustSkills)) return null;
    return parsed;
  } catch {
    return null;
  }
}
