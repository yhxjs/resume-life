import { BASIC_REORDERABLE_FIELD_KEYS, type ModuleData, type BasicContent, type WorkItem, type ProjectItem, type EducationItem, type CustomItem } from "@/lib/modules";
import type { ResumeWithModules } from "@/lib/resumes";
import { parseRichTextToNodes, type RichTextNode } from "@/lib/rich-text";

export type NameMaskMode = "surname_only" | "placeholder" | "keep";
export type PhoneMaskMode = "prefix_only" | "mask_middle" | "placeholder" | "remove";
export type EmailMaskMode = "mask_account" | "placeholder" | "remove";
export type LocationMaskMode = "city_only" | "placeholder" | "remove";
export type BirthdayMaskMode = "year_only" | "placeholder" | "remove";
export type LinksMaskMode = "domain_only" | "remove";

export type CustomSensitiveRule = {
  id: string;
  source: string;
  replacement: string;
  matchCase?: boolean;
};

export type AnonymizeConfig = {
  name: { enabled: boolean; mode: NameMaskMode; customPlaceholder?: string };
  phone: { enabled: boolean; mode: PhoneMaskMode };
  email: { enabled: boolean; mode: EmailMaskMode };
  location: { enabled: boolean; mode: LocationMaskMode };
  birthday: { enabled: boolean; mode: BirthdayMaskMode };
  links: { enabled: boolean; mode: LinksMaskMode };
  avatar: { enabled: boolean };
  customRules: CustomSensitiveRule[];
};

export const DEFAULT_ANONYMIZE_CONFIG: AnonymizeConfig = {
  name: { enabled: true, mode: "surname_only", customPlaceholder: "某候选人" },
  phone: { enabled: true, mode: "prefix_only" },
  email: { enabled: true, mode: "mask_account" },
  location: { enabled: true, mode: "city_only" },
  birthday: { enabled: true, mode: "year_only" },
  links: { enabled: true, mode: "remove" },
  avatar: { enabled: true },
  customRules: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAnonymizeConfig(value: unknown): value is AnonymizeConfig {
  if (!isRecord(value)) return false;
  const modes = {
    name: ["surname_only", "placeholder", "keep"],
    phone: ["prefix_only", "mask_middle", "placeholder", "remove"],
    email: ["mask_account", "placeholder", "remove"],
    location: ["city_only", "placeholder", "remove"],
    birthday: ["year_only", "placeholder", "remove"],
    links: ["domain_only", "remove"],
  };
  for (const [key, allowedModes] of Object.entries(modes)) {
    const section = value[key];
    if (!isRecord(section) || typeof section.enabled !== "boolean"
      || typeof section.mode !== "string" || !allowedModes.includes(section.mode)) {
      return false;
    }
  }
  const name = value.name as Record<string, unknown>;
  if (name.customPlaceholder !== undefined && typeof name.customPlaceholder !== "string") return false;
  if (!isRecord(value.avatar) || typeof value.avatar.enabled !== "boolean") return false;
  if (!Array.isArray(value.customRules)) return false;
  return value.customRules.every((rule) => isRecord(rule)
    && typeof rule.id === "string" && typeof rule.source === "string" && typeof rule.replacement === "string"
    && (rule.matchCase === undefined || typeof rule.matchCase === "boolean"));
}


const COMMON_COMPOUND_SURNAMES = [
  "诸葛", "欧阳", "司马", "上官", "夏侯", "公孙", "皇甫", "慕容",
  "申屠", "公冶", "呼延", "宇文", "司徒", "司空", "端木", "尉迟",
];

export function maskPersonName(name: string, mode: NameMaskMode = "surname_only", placeholder = "某候选人"): string {
  const trimmed = (name || "").trim();
  if (!trimmed || mode === "keep") return trimmed;
  if (mode === "placeholder") return (placeholder || "某候选人").trim();

  for (const compound of COMMON_COMPOUND_SURNAMES) {
    if (trimmed.startsWith(compound) && trimmed.length > 2) {
      return compound + "*".repeat(trimmed.length - compound.length);
    }
  }

  if (/^[一-龥]+$/.test(trimmed)) {
    if (trimmed.length === 1) return trimmed;
    return trimmed[0] + "*".repeat(trimmed.length - 1);
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) {
    return parts
      .map((p) => (p.length > 1 ? p[0] + "*".repeat(Math.max(1, p.length - 1)) : p))
      .join(" ");
  }

  return trimmed.length > 1 ? trimmed[0] + "*".repeat(trimmed.length - 1) : trimmed;
}

export function maskPhoneNumber(phone: string, mode: PhoneMaskMode = "prefix_only"): string {
  const trimmed = (phone || "").trim();
  if (!trimmed) return "";
  if (mode === "remove") return "";
  if (mode === "placeholder") return "[手机号保密]";

  const match = trimmed.match(/^(?:(?:\+?86[- ]?)?)(1[3-9]\d{9})$/);
  if (match && match[1]) {
    const raw = match[1];
    if (mode === "prefix_only") {
      return `${raw.slice(0, 3)}********`;
    }
    return `${raw.slice(0, 3)}****${raw.slice(7)}`;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 7) {
    const head = digits.slice(0, 3);
    if (mode === "prefix_only") {
      return `${head}********`;
    }
    const tail = digits.slice(-4);
    return `${head}****${tail}`;
  }

  return trimmed.replace(/\d/g, "*");
}

export function maskEmailAddress(email: string, mode: EmailMaskMode = "mask_account"): string {
  const trimmed = (email || "").trim();
  if (!trimmed) return "";
  if (mode === "remove") return "";
  if (mode === "placeholder") return "[邮箱保密]";

  const match = trimmed.match(/^([a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*)@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/i);
  if (!match) return "[邮箱保密]";

  const account = match[1]!;
  const domain = match[2]!;
  const maskedAccount = account.length > 1 ? `${account[0]}***` : "*";
  return `${maskedAccount}@${domain}`;
}

export function maskLocationText(location: string, mode: LocationMaskMode = "city_only"): string {
  const trimmed = (location || "").trim();
  if (!trimmed) return "";
  if (mode === "remove") return "";
  if (mode === "placeholder") return "[现居地保密]";

  const muniMatch = trimmed.match(/(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/);
  if (muniMatch) return muniMatch[1]!;

  const provCityMatch = trimmed.match(/(?:.*?省\s*)?([^省\s]+?(?:市|自治州|地区|盟))/);
  const city = provCityMatch?.[1];
  if (city && /^[\u4e00-\u9fff]{2,16}(?:市|自治州|地区|盟)$/.test(city) && !/[路街巷号室楼]/.test(city) && !trimmed.includes(`${city}场`)) {
    return city;
  }

  return "[现居地保密]";
}

export function maskBirthdayText(birthday: string, mode: BirthdayMaskMode = "year_only"): string {
  const trimmed = (birthday || "").trim();
  if (!trimmed) return "";
  if (mode === "remove") return "";
  if (mode === "placeholder") return "[出生年月保密]";

  const yearMatch = trimmed.match(/(\d{4})/);
  if (yearMatch) return `${yearMatch[1]}年`;
  return "[出生年月保密]";
}

export function maskLinksText(links: string, mode: LinksMaskMode = "remove"): string {
  const trimmed = (links || "").trim();
  if (!trimmed || mode === "remove") return "";

  const lines = trimmed.split("\n");
  const processed = lines
    .map((line) => {
      const l = line.trim();
      if (!l) return "";
      try {
        const urlStr = l.startsWith("http://") || l.startsWith("https://") ? l : `https://${l}`;
        const u = new URL(urlStr);
        return `${u.hostname}/***`;
      } catch {
        return `${l.split("/")[0]}/***`;
      }
    })
    .filter(Boolean);

  return processed.join("\n");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ReplacementObserver = (rule: CustomSensitiveRule) => void;

export function replaceSensitiveText(text: string, rules: CustomSensitiveRule[], onReplacement?: ReplacementObserver): string {
  return applyTextRules(text, rules, onReplacement);
}

function applyTextRules(text: string, rules: CustomSensitiveRule[], onReplacement?: ReplacementObserver): string {
  if (!text || !rules.length) return text;

  const validRules = rules
    .filter((r) => r.source && r.source.trim())
    .sort((a, b) => b.source.trim().length - a.source.trim().length);

  let result = text;
  for (const r of validRules) {
    const src = r.source.trim();
    if (!src) continue;
    const flags = r.matchCase ? "g" : "gi";
    const regex = new RegExp(escapeRegex(src), flags);
    result = result.replace(regex, () => {
      onReplacement?.(r);
      return r.replacement;
    });
  }
  return result;
}

function transformAstTextNodes(nodes: RichTextNode[], rules: CustomSensitiveRule[], onReplacement?: ReplacementObserver): RichTextNode[] {
  type TextNode = Extract<RichTextNode, { type: "text" }>;
  const paragraphs: TextNode[][] = [[]];
  const collect = (children: RichTextNode[]): RichTextNode[] => children.flatMap<RichTextNode>((node) => {
    if (node.type === "text") {
      return node.text.split(/(\r\n|[\r\n\u2028\u2029])/).map((text): TextNode => {
        const leaf: TextNode = { type: "text", text };
        if (/^[\r\n\u2028\u2029]+$/.test(text)) paragraphs.push([]);
        else paragraphs[paragraphs.length - 1]!.push(leaf);
        return leaf;
      });
    }
    if (node.type === "br") paragraphs.push([]);
    if (node.type === "strong" || node.type === "color") return { ...node, children: collect(node.children) };
    return node;
  });
  const updatedNodes = collect(nodes);
  const validRules = rules.filter((r) => r.source && r.source.trim() && !/[\r\n\u2028\u2029]/.test(r.source.trim()))
    .sort((a, b) => b.source.trim().length - a.source.trim().length);

  for (const paragraph of paragraphs) {
    for (const rule of validRules) {
      let offset = 0;
      const spans = paragraph.map((node) => {
        const start = offset;
        offset += node.text.length;
        return { node, start, end: offset };
      });
      const text = paragraph.map((node) => node.text).join("");
      const regex = new RegExp(escapeRegex(rule.source.trim()), rule.matchCase ? "g" : "gi");
      // 倒序写回原叶节点，避免长度变化影响前面的匹配；替换文本继承起点格式。
      for (const match of Array.from(text.matchAll(regex)).reverse()) {
        onReplacement?.(rule);
        const start = match.index;
        const end = start + match[0].length;
        for (const span of spans) {
          if (span.end <= start || span.start >= end) continue;
          const from = Math.max(0, start - span.start);
          const to = Math.min(span.end - span.start, end - span.start);
          const replacement = span.start <= start ? rule.replacement : "";
          span.node.text = span.node.text.slice(0, from) + replacement + span.node.text.slice(to);
        }
      }
    }
  }
  return updatedNodes;
}

function astToHtml(nodes: RichTextNode[]): string {
  let res = "";
  for (const n of nodes) {
    if (n.type === "text") {
      res += n.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    } else if (n.type === "br") {
      res += "<br>";
    } else if (n.type === "strong") {
      res += `<strong>${astToHtml(n.children)}</strong>`;
    } else if (n.type === "color") {
      res += `<span style="color: ${n.color}">${astToHtml(n.children)}</span>`;
    }
  }
  return res;
}

export function replaceSensitiveRichText(html: string, rules: CustomSensitiveRule[]): string {
  return applyRichTextRules(html, rules);
}

function applyRichTextRules(html: string, rules: CustomSensitiveRule[], onReplacement?: ReplacementObserver): string {
  if (!html || !rules.length) return html;
  // 通用解析器会丢弃块标签，先留下段落边界，避免把两段拼成一个敏感词。
  const nodes = parseRichTextToNodes(html.replace(/<\/?(?:p|div|li|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n"));
  const updatedNodes = transformAstTextNodes(nodes, rules, onReplacement);
  return astToHtml(updatedNodes);
}

export function anonymizeResumeModules(modules: ModuleData[], config: AnonymizeConfig, onReplacement?: ReplacementObserver): ModuleData[] {
  return transformResumeModules(modules, config, onReplacement);
}

function transformResumeModules(modules: ModuleData[], config: AnonymizeConfig, onReplacement?: ReplacementObserver): ModuleData[] {
  const cloned: ModuleData[] = structuredClone(modules);
  const validRules = config.customRules.filter((r) => r.source && r.source.trim());
  const replaceText = (text: string) => applyTextRules(text, validRules, onReplacement);
  const replaceRichText = (html: string) => applyRichTextRules(html, validRules, onReplacement);

  for (const mod of cloned) {
    mod.label = replaceText(mod.label);
    if (mod.type === "basic") {
      const basic = (mod.content ?? {}) as Partial<BasicContent>;

      if (config.name.enabled && typeof basic.name === "string") {
        basic.name = maskPersonName(basic.name, config.name.mode, config.name.customPlaceholder);
      }
      if (config.phone.enabled && typeof basic.phone === "string") {
        basic.phone = maskPhoneNumber(basic.phone, config.phone.mode);
      }
      if (config.email.enabled && typeof basic.email === "string") {
        basic.email = maskEmailAddress(basic.email, config.email.mode);
      }
      if (config.location.enabled && typeof basic.location === "string") {
        basic.location = maskLocationText(basic.location, config.location.mode);
      }
      if (config.birthday.enabled && typeof basic.birthday === "string") {
        basic.birthday = maskBirthdayText(basic.birthday, config.birthday.mode);
      }
      if (config.links.enabled && typeof basic.links === "string") {
        basic.links = maskLinksText(basic.links, config.links.mode);
      }
      if (config.avatar.enabled) {
        delete basic.avatar;
        delete basic.avatarX;
        delete basic.avatarY;
        delete basic.avatarSize;
        delete basic.avatarShape;
      }

      if (validRules.length > 0) {
        for (const key of ["name", ...BASIC_REORDERABLE_FIELD_KEYS] as const) {
          const value = basic[key];
          if (typeof value === "string") basic[key] = replaceText(value);
        }
      }

      mod.content = basic;
      continue;
    }

    if (mod.type === "work") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as WorkItem[];
      for (const item of items) {
        if (validRules.length > 0) {
          if (item.company) item.company = replaceText(item.company);
          if (item.title) item.title = replaceText(item.title);
          if (item.description) item.description = replaceRichText(item.description);
          if (Array.isArray(item.descriptionItems)) {
            item.descriptionItems = item.descriptionItems.map((desc) => replaceRichText(desc));
          }
          if (Array.isArray(item.subItems)) {
            for (const sub of item.subItems) {
              if (sub.label) sub.label = replaceText(sub.label);
              if (sub.value) sub.value = replaceText(sub.value);
            }
          }
        }
      }
      mod.content = items;
      continue;
    }

    if (mod.type === "projects") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as ProjectItem[];
      for (const item of items) {
        if (validRules.length > 0) {
          if (item.name) item.name = replaceText(item.name);
          if (item.role) item.role = replaceText(item.role);
          if (item.description) item.description = replaceRichText(item.description);
          if (Array.isArray(item.descriptionItems)) {
            item.descriptionItems = item.descriptionItems.map((desc) => replaceRichText(desc));
          }
          if (Array.isArray(item.subItems)) {
            for (const sub of item.subItems) {
              if (sub.label) sub.label = replaceText(sub.label);
              if (sub.value) sub.value = replaceText(sub.value);
            }
          }
        }
      }
      mod.content = items;
      continue;
    }

    if (mod.type === "education") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as EducationItem[];
      for (const item of items) {
        if (validRules.length > 0) {
          if (item.school) item.school = replaceText(item.school);
          if (item.degree) item.degree = replaceText(item.degree);
          if (item.field) item.field = replaceText(item.field);
          if (item.description) item.description = replaceRichText(item.description);
        }
      }
      mod.content = items;
      continue;
    }

    if (mod.type === "skills") {
      const skills = (mod.content ?? {}) as { items?: string[] };
      if (Array.isArray(skills.items) && validRules.length > 0) {
        skills.items = skills.items.map((it) => replaceText(it));
      }
      mod.content = skills;
      continue;
    }

    if (mod.type === "summary") {
      const summary = (mod.content ?? {}) as { text?: string; descriptionItems?: string[] };
      if (typeof summary.text === "string" && validRules.length > 0) {
        summary.text = replaceRichText(summary.text);
      }
      if (Array.isArray(summary.descriptionItems) && validRules.length > 0) {
        summary.descriptionItems = summary.descriptionItems.map((text) => replaceRichText(text));
      }
      mod.content = summary;
      continue;
    }

    if (mod.type === "custom") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as CustomItem[];
      for (const item of items) {
        if (validRules.length > 0) {
          if (item.title) item.title = replaceText(item.title);
          if (item.subTitle) item.subTitle = replaceText(item.subTitle);
          if (item.description) item.description = replaceRichText(item.description);
          if (Array.isArray(item.descriptionItems)) {
            item.descriptionItems = item.descriptionItems.map((desc) => replaceRichText(desc));
          }
          if (Array.isArray(item.subItems)) {
            for (const sub of item.subItems) {
              if (sub.label) sub.label = replaceText(sub.label);
              if (sub.value) sub.value = replaceText(sub.value);
            }
          }
        }
      }
      mod.content = items;
      continue;
    }
  }

  return cloned;
}

export function anonymizeResumeTitle(title: string, modules: ModuleData[], config: AnonymizeConfig): string {
  let rawTitle = (title || "简历").trim();
  const basicMod = modules.find((m) => m.type === "basic");
  const rawName = ((basicMod?.content ?? {}) as Partial<BasicContent>).name;
  if (config.name.enabled && rawName && typeof rawName === "string" && rawName.trim()) {
    const maskedName = maskPersonName(rawName, config.name.mode, config.name.customPlaceholder);
    rawTitle = rawTitle.replace(new RegExp(escapeRegex(rawName.trim()), "g"), () => maskedName);
  }

  const titleWithRules = replaceSensitiveText(rawTitle, config.customRules);
  return titleWithRules.startsWith("[脱敏版]") ? titleWithRules : `[脱敏版] ${titleWithRules}`;
}

export function anonymizeResumeData(data: ResumeWithModules, config: AnonymizeConfig): ResumeWithModules {
  const clonedResume = structuredClone(data.resume);
  const anonymizedModules = anonymizeResumeModules(data.modules, config);
  clonedResume.title = anonymizeResumeTitle(data.resume.title, data.modules, config);

  return {
    ...data,
    resume: clonedResume,
    modules: anonymizedModules,
  };
}

export type AnonymizeStatistics = {
  maskedBasicCount: number;
  replacedRulesCount: number;
  replacedOccurrencesCount: number;
};

export function calculateAnonymizeStats(modules: ModuleData[], config: AnonymizeConfig): AnonymizeStatistics {
  let maskedBasicCount = 0;
  const basicMod = modules.find((m) => m.type === "basic");
  if (basicMod) {
    const b = (basicMod.content ?? {}) as Partial<BasicContent>;
    if (config.name.enabled && b.name) maskedBasicCount++;
    if (config.phone.enabled && b.phone) maskedBasicCount++;
    if (config.email.enabled && b.email) maskedBasicCount++;
    if (config.location.enabled && b.location) maskedBasicCount++;
    if (config.birthday.enabled && b.birthday) maskedBasicCount++;
    if (config.links.enabled && b.links) maskedBasicCount++;
    if (config.avatar.enabled && b.avatar) maskedBasicCount++;
  }

  let replacedOccurrencesCount = 0;
  const replacedRules = new Set<CustomSensitiveRule>();
  // 与转换同源计数：只统计实际显示字段中的替换，包含跨富文本节点的匹配。
  transformResumeModules(modules, config, (rule) => {
    replacedRules.add(rule);
    replacedOccurrencesCount++;
  });
  const replacedRulesCount = replacedRules.size;

  return {
    maskedBasicCount,
    replacedRulesCount,
    replacedOccurrencesCount,
  };
}

export type IdentifiedEntityKind = "company" | "project" | "school";

export type IdentifiedResumeEntity = {
  id: string;
  kind: IdentifiedEntityKind;
  source: string;
  defaultReplacement: string;
};

/** 从简历数据中自动提取用户已填写的真实公司、项目、学校等实体并生成默认占位符 */
export function extractResumeEntities(modules: ModuleData[]): IdentifiedResumeEntity[] {
  const entities: IdentifiedResumeEntity[] = [];
  const seenSources = new Set<string>();

  let companyIdx = 1;
  let projectIdx = 1;
  let schoolIdx = 1;

  for (const mod of modules) {
    if (mod.type === "work") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as WorkItem[];
      for (const item of items) {
        const comp = (item.company || "").trim();
        if (comp && !seenSources.has(comp.toLowerCase())) {
          seenSources.add(comp.toLowerCase());
          let defaultReplacement = `[某工作单位${companyIdx}]`;
          if (/科技|网络|互联网|字节|腾讯|阿里|美团|快手|百度|滴滴|网易|华为|小米/.test(comp)) {
            defaultReplacement = `[某头部互联网企业${companyIdx > 1 ? companyIdx : ""}]`;
          } else if (/银行|证券|基金|金融|保险|投资/.test(comp)) {
            defaultReplacement = `[某金融投资机构${companyIdx > 1 ? companyIdx : ""}]`;
          } else if (/医院|医疗|健康|制药|生物/.test(comp)) {
            defaultReplacement = `[某医疗健康企业${companyIdx > 1 ? companyIdx : ""}]`;
          }

          entities.push({
            id: `auto-comp-${companyIdx}`,
            kind: "company",
            source: comp,
            defaultReplacement,
          });
          companyIdx++;
        }
      }
    }

    if (mod.type === "projects") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as ProjectItem[];
      for (const item of items) {
        const projName = (item.name || "").trim();
        if (projName && !seenSources.has(projName.toLowerCase())) {
          seenSources.add(projName.toLowerCase());
          entities.push({
            id: `auto-proj-${projectIdx}`,
            kind: "project",
            source: projName,
            defaultReplacement: `[某核心业务项目${projectIdx}]`,
          });
          projectIdx++;
        }
      }
    }

    if (mod.type === "education") {
      const items = (Array.isArray(mod.content) ? mod.content : []) as EducationItem[];
      for (const item of items) {
        const school = (item.school || "").trim();
        if (school && !seenSources.has(school.toLowerCase())) {
          seenSources.add(school.toLowerCase());
          entities.push({
            id: `auto-school-${schoolIdx}`,
            kind: "school",
            source: school,
            defaultReplacement: `[某高等院校${schoolIdx}]`,
          });
          schoolIdx++;
        }
      }
    }
  }

  return entities;
}

