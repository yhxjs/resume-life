import { stripRichText } from "@/lib/rich-text";

/**
 * 模块的六种结构类型，决定编辑器形态与渲染方式。
 * 注意：模块实例的稳定标识是 ModuleData.key（内置模块 key 与类型同名，
 * 自定义模块为生成的 mod_* 标识），同一类型可添加多个自定义模块。
 */
export const MODULE_KEYS = ["basic", "education", "work", "projects", "skills", "summary", "custom"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** 新建简历时初始化的默认模块集合（不默认插入自定义模块） */
export const DEFAULT_INITIAL_MODULE_KEYS = ["basic", "education", "work", "projects", "skills", "summary"] as const;

export const MODULE_LABELS: Record<ModuleKey, string> = {
  basic: "基本信息",
  education: "教育经历",
  work: "工作经历",
  projects: "项目经历",
  skills: "技能",
  summary: "自我评价",
  custom: "自定义",
};

export type AvatarShape = "circle" | "rounded" | "square";

export function isLocalAvatarUrl(value: string): boolean {
  const match = /^\/api\/uploads\/([A-Za-z0-9._-]{1,128})(?:\?v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.exec(value);
  return Boolean(match && /\.(?:png|jpe?g|webp)$/i.test(match[1]!));
}

export const BASIC_REORDERABLE_FIELD_KEYS = [
  "gender",
  "age",
  "phone",
  "email",
  "location",
  "birthday",
  "links",
] as const;
export type BasicReorderableFieldKey = (typeof BASIC_REORDERABLE_FIELD_KEYS)[number];

export function getOrderedBasicKeys(fieldOrder?: unknown): BasicReorderableFieldKey[] {
  const saved = Array.isArray(fieldOrder) ? fieldOrder : [];
  const allowed = new Set<string>(BASIC_REORDERABLE_FIELD_KEYS);
  const valid = saved.filter((k): k is BasicReorderableFieldKey => typeof k === "string" && allowed.has(k));
  const deduped: BasicReorderableFieldKey[] = Array.from(new Set(valid));
  for (const k of BASIC_REORDERABLE_FIELD_KEYS) {
    if (!deduped.includes(k)) deduped.push(k);
  }
  return deduped;
}

export type BasicContent = {
  name: string;
  phone: string;
  email: string;
  location: string;
  gender?: string;
  age?: string;
  birthday: string;
  links: string;
  fieldOrder?: string[];
  avatar?: string;
  avatarX?: number;
  avatarY?: number;
  avatarSize?: number;
  avatarShape?: AvatarShape;
};
export type EducationItem = {
  id: string;
  school: string;
  degree: string;
  field: string;
  start: string;
  end: string;
  description: string;
};
export type EntrySubItem = {
  id: string;
  label: string;
  value: string;
};
export type ProjectSubItem = EntrySubItem;
export type WorkSubItem = EntrySubItem;
export type DescriptionListStyle = "unordered" | "ordered";
export type WorkItem = {
  id: string;
  company: string;
  title: string;
  start: string;
  end: string;
  description: string;
  subItems?: WorkSubItem[];
  descriptionItems?: string[];
  descriptionStyle?: DescriptionListStyle;
};
export type ProjectItem = {
  id: string;
  name: string;
  role: string;
  start: string;
  end: string;
  description: string;
  subItems?: ProjectSubItem[];
  descriptionItems?: string[];
  descriptionStyle?: DescriptionListStyle;
};
export type SkillsContent = { items: string[] };
export type SummaryContent = {
  text: string;
  descriptionItems?: string[];
  descriptionStyle?: DescriptionListStyle;
};
export type CustomSubItem = EntrySubItem;
export type CustomItem = {
  id: string;
  title: string;
  subTitle?: string;
  start?: string;
  end?: string;
  description: string;
  subItems?: CustomSubItem[];
  descriptionItems?: string[];
  descriptionStyle?: DescriptionListStyle;
};
export type CustomContent = CustomItem[];

export type ModuleContentMap = {
  basic: BasicContent;
  education: EducationItem[];
  work: WorkItem[];
  projects: ProjectItem[];
  skills: SkillsContent;
  summary: SummaryContent;
  custom: CustomContent;
};

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === "string" && (MODULE_KEYS as readonly string[]).includes(value);
}

/** 一条模块实例：key 为简历内稳定标识，label 为显示名（简历内唯一），sort 决定顺序 */
export type ModuleData = {
  key: string;
  type: ModuleKey;
  label: string;
  sort: number;
  content: unknown;
  revision?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** PATCH 边界只接受符合模块形状的显式草稿；补默认值仍由 normalizeContent 负责。 */
export function isValidModuleContentInput(type: ModuleKey, raw: unknown): boolean {
  const strings = (o: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => !Object.hasOwn(o, key) || typeof o[key] === "string");
  if (type === "basic") {
    if (!isRecord(raw) || !strings(raw, ["name", "phone", "email", "location", "gender", "age", "birthday", "links", "avatar"])) return false;
    if (Object.hasOwn(raw, "fieldOrder") && (!Array.isArray(raw.fieldOrder) || !raw.fieldOrder.every((k) => typeof k === "string"))) return false;
    if (!["avatarX", "avatarY", "avatarSize"].every((key) => !Object.hasOwn(raw, key) ||
      (typeof raw[key] === "number" && Number.isFinite(raw[key])))) return false;
    return !Object.hasOwn(raw, "avatarShape") || ["circle", "rounded", "square"].includes(raw.avatarShape as string);
  }
  if (type === "skills") return isRecord(raw) && (!Object.hasOwn(raw, "items") ||
    (Array.isArray(raw.items) && raw.items.every((value) => typeof value === "string")));
  if (type === "summary") {
    if (!isRecord(raw) || !strings(raw, ["text"])) return false;
    if (Object.hasOwn(raw, "descriptionStyle") && !["ordered", "unordered"].includes(raw.descriptionStyle as string)) return false;
    return !Object.hasOwn(raw, "descriptionItems") ||
      (Array.isArray(raw.descriptionItems) && raw.descriptionItems.every((value) => typeof value === "string"));
  }
  if (!Array.isArray(raw)) return false;
  const fields = type === "education"
    ? ["id", "school", "degree", "field", "start", "end", "description"]
    : type === "work"
      ? ["id", "company", "title", "start", "end", "description"]
      : type === "projects"
        ? ["id", "name", "role", "start", "end", "description"]
        : ["id", "title", "subTitle", "start", "end", "description"];
  return raw.every((entry) => {
    if (!isRecord(entry) || !strings(entry, fields)) return false;
    if (type === "education") return true;
    if (Object.hasOwn(entry, "descriptionStyle") && !["ordered", "unordered"].includes(entry.descriptionStyle as string)) return false;
    if (Object.hasOwn(entry, "descriptionItems") &&
      (!Array.isArray(entry.descriptionItems) || !entry.descriptionItems.every((item) => typeof item === "string"))) return false;
    return !Object.hasOwn(entry, "subItems") ||
      (Array.isArray(entry.subItems) && entry.subItems.every((item) =>
        isRecord(item) && strings(item, ["id", "label", "value"])));
  });
}

/** 简历字数：CJK 字符（含中文标点）逐字计数，连续英文/数字计为一词；跳过 id 等机器字段 */
export function resumeWordCount(modules: ModuleData[]): number {
  let count = 0;
  const walk = (fieldKey: string | null, value: unknown) => {
    if (typeof value === "string") {
      if (fieldKey === "id" || fieldKey === "descriptionStyle" || fieldKey === "avatar") return;
      const plainText = stripRichText(value);
      count +=
        plainText.match(/[A-Za-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g)?.length ?? 0;
      return;
    }
    if (fieldKey === "descriptionItems") return;
    if (Array.isArray(value)) {
      for (const v of value) walk(null, v);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(k, v);
    }
  };
  for (const mod of modules) walk(null, mod.content);
  return count;
}

let moduleKeySeq = 0;
/** 生成自定义模块的稳定标识（mod_* 前缀，避免与内置 key 冲突） */
export function genModuleKey(): string {
  moduleKeySeq += 1;
  return `mod_${Date.now().toString(36)}_${moduleKeySeq}`;
}

export function defaultContent<K extends ModuleKey>(key: K): ModuleContentMap[K] {
  // 用具名字面量而非逐分支强转：每个字段都由类型系统校验，泛型索引也无需断言
  const defaults: ModuleContentMap = {
    basic: {
      name: "",
      phone: "",
      email: "",
      location: "",
      gender: "",
      age: "",
      birthday: "",
      links: "",
      fieldOrder: [...BASIC_REORDERABLE_FIELD_KEYS],
      avatar: "",
      avatarX: 0,
      avatarY: 0,
      avatarSize: 72,
      avatarShape: "rounded",
    },
    education: [],
    work: [],
    projects: [],
    skills: { items: [] },
    summary: { text: "", descriptionItems: [], descriptionStyle: "unordered" },
    custom: [],
  };
  return defaults[key];
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function item(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withId(value: Record<string, unknown>, fallbackId: string): Record<string, unknown> {
  return { ...value, id: typeof value.id === "string" && value.id ? value.id : fallbackId };
}

let idSeq = 0;
function genId(): string {
  idSeq += 1;
  return `it_${Date.now().toString(36)}_${idSeq}`;
}

function normalizeSubItems(rawSub: unknown): EntrySubItem[] {
  const list = Array.isArray(rawSub) ? rawSub : [];
  return list.map((s) => {
    const so = item(s);
    return {
      id: typeof so.id === "string" && so.id ? so.id : genId(),
      label: str(so.label),
      value: str(so.value),
    };
  });
}

function normalizeDescriptionItemsAndStyle(o: Record<string, unknown>): {
  description: string;
  descriptionItems: string[];
  descriptionStyle: DescriptionListStyle;
} {
  const descriptionStyle: DescriptionListStyle =
    o.descriptionStyle === "ordered" ? "ordered" : "unordered";

  let descriptionItems: string[];
  if (Array.isArray(o.descriptionItems)) {
    descriptionItems = o.descriptionItems
      .filter((x): x is string => typeof x === "string")
      .map((x) => x);
  } else if (typeof o.description === "string" && o.description.trim()) {
    descriptionItems = o.description
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } else {
    descriptionItems = [];
  }

  const description =
    descriptionItems.length > 0
      ? descriptionItems.join("\n")
      : str(o.description);

  return { description, descriptionItems, descriptionStyle };
}

/** 逐字段清洗模块内容：非法类型回退默认值、补齐列表项 id，落库前统一走这里 */
export function normalizeContent<K extends ModuleKey>(key: K, raw: unknown): ModuleContentMap[K] {
  switch (key) {
    case "basic": {
      const o = item(raw);
      const res: BasicContent = {
        name: str(o.name),
        phone: str(o.phone),
        email: str(o.email),
        location: str(o.location),
        gender: str(o.gender),
        age: str(o.age),
        birthday: str(o.birthday),
        links: str(o.links),
      };

      res.fieldOrder = getOrderedBasicKeys(o.fieldOrder);

      if (typeof o.avatar === "string" && isLocalAvatarUrl(o.avatar.trim())) {
        res.avatar = o.avatar.trim();
      }
      if (typeof o.avatarX === "number" && Number.isFinite(o.avatarX)) {
        res.avatarX = Math.min(Math.max(Math.round(o.avatarX), -180), 0);
      }
      if (typeof o.avatarY === "number" && Number.isFinite(o.avatarY)) {
        res.avatarY = Math.min(Math.max(Math.round(o.avatarY), -30), 30);
      }
      if (typeof o.avatarSize === "number" && Number.isFinite(o.avatarSize) && o.avatarSize > 0) {
        res.avatarSize = Math.min(Math.max(Math.round(o.avatarSize), 40), 160);
      }
      if (o.avatarShape === "square" || o.avatarShape === "rounded" || o.avatarShape === "circle") {
        res.avatarShape = o.avatarShape;
      }

      return res as ModuleContentMap[K];
    }
    case "education": {
      const list = Array.isArray(raw) ? raw : [];
      return list.map((v) => {
        const o = withId(item(v), genId());
        return {
          id: str(o.id),
          school: str(o.school),
          degree: str(o.degree),
          field: str(o.field),
          start: str(o.start),
          end: str(o.end),
          description: str(o.description),
        };
      }) as ModuleContentMap[K];
    }
    case "work": {
      const list = Array.isArray(raw) ? raw : [];
      return list.map((v) => {
        const o = withId(item(v), genId());
        const subItems = normalizeSubItems(o.subItems);
        const { description, descriptionItems, descriptionStyle } =
          normalizeDescriptionItemsAndStyle(o);

        return {
          id: str(o.id),
          company: str(o.company),
          title: str(o.title),
          start: str(o.start),
          end: str(o.end),
          description,
          subItems,
          descriptionItems,
          descriptionStyle,
        };
      }) as ModuleContentMap[K];
    }
    case "projects": {
      const list = Array.isArray(raw) ? raw : [];
      return list.map((v) => {
        const o = withId(item(v), genId());
        const subItems = normalizeSubItems(o.subItems);
        const { description, descriptionItems, descriptionStyle } =
          normalizeDescriptionItemsAndStyle(o);

        return {
          id: str(o.id),
          name: str(o.name),
          role: str(o.role),
          start: str(o.start),
          end: str(o.end),
          description,
          subItems,
          descriptionItems,
          descriptionStyle,
        };
      }) as ModuleContentMap[K];
    }
    case "skills": {
      const o = item(raw);
      const items = Array.isArray(o.items) ? o.items.filter((v): v is string => typeof v === "string") : [];
      return { items } as ModuleContentMap[K];
    }
    case "summary": {
      const o = item(raw);
      const { descriptionItems, descriptionStyle } = normalizeDescriptionItemsAndStyle({ ...o, description: o.text });
      return {
        text: descriptionItems.map((value) => value.trim()).filter(Boolean).join("\n"),
        descriptionItems,
        descriptionStyle,
      } as ModuleContentMap[K];
    }
    case "custom": {
      const list = Array.isArray(raw) ? raw : [];
      return list.map((v) => {
        const o = withId(item(v), genId());
        const subItems = normalizeSubItems(o.subItems);
        const { description, descriptionItems, descriptionStyle } =
          normalizeDescriptionItemsAndStyle(o);

        return {
          id: str(o.id),
          title: str(o.title),
          subTitle: str(o.subTitle),
          start: str(o.start),
          end: str(o.end),
          description,
          subItems,
          descriptionItems,
          descriptionStyle,
        };
      }) as ModuleContentMap[K];
    }
  }
}
