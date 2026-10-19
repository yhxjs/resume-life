import type { ResumeSnapshot } from "@/lib/resume-version-types";
import { MODULE_LABELS } from "@/lib/modules";
import { RESUME_TEMPLATES } from "@/lib/template-catalog";

export type ResumeDiffRow = {
  key: string;
  section: string;
  label: string;
  before: string | null;
  after: string | null;
  status: "unchanged" | "added" | "removed" | "changed";
};

const labels: Record<string, string> = {
  name: "姓名 / 名称", gender: "性别", age: "年龄", phone: "电话", email: "邮箱", location: "所在地", birthday: "出生日期", links: "链接",
  avatar: "头像", avatarX: "头像横向位置", avatarY: "头像纵向位置", avatarSize: "头像大小", avatarShape: "头像形状",
  school: "学校", degree: "学历", field: "专业", company: "公司", title: "标题 / 职位", subTitle: "副标题",
  role: "角色", start: "开始时间", end: "结束时间", description: "描述", subItems: "补充信息",
  label: "名称", value: "内容", descriptionItems: "描述", descriptionStyle: "列表样式", items: "技能", text: "正文",
  baseSize: "正文字号", lineHeight: "行高", pageMargin: "页边距", sectionGap: "模块间距", entryGap: "条目间距",
  titleSize: "姓名字号", sectionSize: "模块标题字号", contactSize: "联系信息字号", entryTitleSize: "条目标题字号",
  layout: "布局", asideWidth: "侧栏宽度", headerStyle: "页眉样式", headerBg: "页眉背景", font: "字体",
  accent: "强调色", ink: "标题颜色", muted: "次要文字颜色", titleAlign: "标题对齐", nameSize: "姓名字号",
  nameWeight: "姓名字重", titleRule: "标题分隔线", sectionWeight: "模块标题字重", sectionDeco: "模块标题装饰",
  sectionUppercase: "模块标题大写", entryTitleWeight: "条目标题字重", entrySubAccent: "副标题强调色",
  skillStyle: "技能样式", paragraphGap: "段落间距", contactGap: "联系方式间距", sectionLetterSpacing: "模块标题字距",
  nameTracking: "姓名字距", titleRuleThickness: "标题分隔线粗细", sectionColor: "模块标题颜色",
  sectionTracking: "模块标题字距", sectionDecoColor: "模块装饰颜色", sectionGapBefore: "模块上间距",
  sectionGapAfter: "模块下间距", bulletIndent: "列表缩进", bulletGap: "列表间距", descItemGap: "描述条目间距",
};
const displayValues: Record<string, Record<string, string>> = {
  layout: { single: "单栏", twocol: "双栏" }, font: { serif: "宋体", sans: "黑体" },
  headerStyle: { default: "普通页眉", banner: "通栏色块", card: "卡片" },
  titleAlign: { center: "居中", left: "左对齐" }, titleRule: { none: "无", accent: "强调色", dark: "深灰" },
  sectionDeco: { none: "无", underline: "下划线", leftbar: "左侧线", band: "色块" },
  descriptionStyle: { unordered: "无序列表", ordered: "有序列表" },
  skillStyle: { pill: "标签", line: "单行", list: "列表" }, avatarShape: { circle: "圆形", rounded: "圆角", square: "方形" },
};

type Field = { section: string; label: string; value: string };
type Fields = Map<string, Field>;

function entryName(value: unknown, index: number): string {
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    for (const key of ["company", "school", "name", "title", "label"]) {
      if (typeof entry[key] === "string" && entry[key]) return entry[key] as string;
    }
  }
  return `条目 ${index + 1}`;
}

function flatten(fields: Fields, key: string, label: string, section: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      if (value.length) fields.set(key, { section, label, value: value.join("\n") });
    } else value.forEach((item, index) => {
      const id = item && typeof item === "object" && "id" in item ? String(item.id) : String(index);
      flatten(fields, `${key}/${id}`, entryName(item, index), section, item);
    });
  } else if (typeof value === "object") {
    for (const [field, content] of Object.entries(value)) {
      if (field === "id") continue;
      const record = value as Record<string, unknown>;
      if (field === "description" && Array.isArray(record.descriptionItems) && record.descriptionItems.length) continue;
      const fieldLabel = section === "排版设置" && field === "text" ? "正文颜色" : labels[field] ?? field;
      flatten(fields, `${key}/${field}`, [label, fieldLabel].filter(Boolean).join(" · "), section, content);
    }
  } else {
    const field = key.split("/").at(-1)!;
    fields.set(key, { section, label, value: typeof value === "boolean" ? value ? "是" : "否" : displayValues[field]?.[String(value)] ?? String(value) });
  }
}

function fieldsOf(snapshot: ResumeSnapshot | null): Fields {
  const fields: Fields = new Map();
  if (!snapshot) return fields;
  fields.set("title", { section: "简历设置", label: "简历名称", value: snapshot.title });
  fields.set("template", { section: "简历设置", label: "页面模板", value: RESUME_TEMPLATES.find((template) => template.key === snapshot.template)?.label ?? `自定义模板 ${snapshot.template.replace("custom:", "#")}` });
  flatten(fields, "style", "", "排版设置", snapshot.resolved_style);
  for (const item of snapshot.modules) {
    const key = `module/${item.key}`;
    fields.set(`${key}/label`, { section: item.label, label: "模块名称", value: item.label });
    fields.set(`${key}/type`, { section: item.label, label: "模块类型", value: MODULE_LABELS[item.type] });
    flatten(fields, `${key}/content`, "", item.label, item.content);
  }
  return fields;
}

/** 只比较共同节点的相对顺序，插入或删除节点不误报其他节点移动。 */
function orderRow(key: string, section: string, before: { id: string; name: string }[], after: { id: string; name: string }[]): ResumeDiffRow[] {
  const beforeIds = new Set(before.map((item) => item.id));
  const afterIds = new Set(after.map((item) => item.id));
  const left = before.filter((item) => afterIds.has(item.id));
  const right = after.filter((item) => beforeIds.has(item.id));
  if (left.map((item) => item.id).join("\0") === right.map((item) => item.id).join("\0")) return [];
  return [{ key, section, label: "排列顺序", before: left.map((item) => item.name).join(" → "), after: right.map((item) => item.name).join(" → "), status: "changed" }];
}

export function compareResumeVersions(before: ResumeSnapshot | null, after: ResumeSnapshot): ResumeDiffRow[] {
  const left = fieldsOf(before);
  const right = fieldsOf(after);
  const rows: ResumeDiffRow[] = Array.from(new Set([...left.keys(), ...right.keys()]), (key) => {
    const old = left.get(key);
    const next = right.get(key);
    const from = old?.value ?? null;
    const to = next?.value ?? null;
    return { key, section: next?.section ?? old!.section, label: next?.label ?? old!.label,
      before: from, after: to, status: from === to ? "unchanged" : from === null ? "added" : to === null ? "removed" : "changed" };
  });
  if (before) {
    const modules = (snapshot: ResumeSnapshot) => snapshot.modules.map((module) => ({ id: module.key, name: module.label }));
    rows.push(...orderRow("module-order", "简历设置", modules(before), modules(after)));
    for (const item of after.modules) {
      const old = before.modules.find((previous) => previous.key === item.key);
      if (!old || !Array.isArray(old.content) || !Array.isArray(item.content)) continue;
      const entries = (content: unknown[]) => content.map((item, index) => ({ id: String((item as { id?: string })?.id ?? index), name: entryName(item, index) }));
      rows.push(...orderRow(`module/${item.key}/order`, item.label, entries(old.content), entries(item.content)));
    }
  }
  return rows;
}

/** 以 Unicode 字符为单位保留共同前后文，不切断 emoji。 */
export function changedText(before: string, after: string) {
  const left = Array.from(before);
  const right = Array.from(after);
  let start = 0;
  while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
  let end = 0;
  while (end < Math.min(left.length, right.length) - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
  return { prefix: left.slice(0, start).join(""), before: left.slice(start, left.length - end).join(""),
    after: right.slice(start, right.length - end).join(""), suffix: end ? left.slice(-end).join("") : "" };
}
