import sharp from "sharp";
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, LevelFormat, LevelSuffix, LineRuleType, Packer,
  Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
  type IRunOptions,
} from "docx";
import { getOrderedBasicKeys, type BasicContent, CustomItem, EducationItem, ModuleData, ProjectItem, SkillsContent, SummaryContent, WorkItem } from "@/lib/modules";
import { parseRichTextToNodes, type RichTextNode } from "@/lib/rich-text";
import { DEFAULT_STYLE, type ResumeStyle } from "@/lib/templates";

type Entry = Partial<EducationItem & WorkItem & ProjectItem & CustomItem>;
type Block = Paragraph | Table;
type DocxOptions = { style?: ResumeStyle; avatar?: Uint8Array };

const ENTRY_KEYS = {
  education: { title: ["school"], sub: ["degree", "field"] },
  work: { title: ["company"], sub: ["title"] },
  projects: { title: ["name"], sub: ["role"] },
  custom: { title: ["title"], sub: ["subTitle"] },
} as const;
const NO_BORDER = { style: BorderStyle.NONE } as const;
const TABLE_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};
const mm = (value: number) => Math.round(value * 1440 / 25.4);
const px = (value: number) => Math.round(value * 15);
const halfPt = (cssPx: number) => Math.round(cssPx * 1.5);

// 编辑器色板使用 hex，浏览器编辑后的内联颜色也可能序列化为 rgb。
function wordColor(color: string): string | undefined {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim())?.[1];
  if (hex) return (hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i.exec(color.trim());
  return rgb ? rgb.slice(1, 4).map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("").toUpperCase() : undefined;
}

function lightTint(color: string): string {
  const hex = wordColor(color) ?? "000000";
  return [0, 2, 4].map((offset) =>
    Math.round(255 * (1 - 31 / 255) + Number.parseInt(hex.slice(offset, offset + 2), 16) * 31 / 255)
      .toString(16).padStart(2, "0")
  ).join("").toUpperCase();
}

function plainRuns(value: string, style: IRunOptions = {}): TextRun[] {
  return value.split(/\r?\n/).map((text, index) => new TextRun({ ...style, text, ...(index ? { break: 1 } : {}) }));
}

function richRuns(nodes: RichTextNode[], style: IRunOptions = {}): TextRun[] {
  return nodes.flatMap((node): TextRun[] => {
    if (node.type === "br") return [new TextRun({ ...style, break: 1 })];
    if (node.type === "strong") return richRuns(node.children, { ...style, bold: true });
    if (node.type === "color") return richRuns(node.children, { ...style, color: wordColor(node.color) ?? style.color });
    return plainRuns(node.text, style);
  });
}

function richParagraph(text: string, style: ResumeStyle, keepLines = false): Paragraph {
  return new Paragraph({
    children: richRuns(parseRichTextToNodes(text)),
    spacing: { after: px(style.descItemGap ?? 2) },
    ...(keepLines ? { keepLines: true } : {}),
  });
}

function table(cells: TableCell[], widths: number[], cantSplit = true): Table {
  return new Table({
    rows: [new TableRow({ children: cells, cantSplit })],
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: TABLE_BORDERS,
  });
}

async function avatarRun(basic: Partial<BasicContent>, bytes?: Uint8Array): Promise<ImageRun | null> {
  if (!basic.avatar || !bytes) return null;
  const size = Math.min(120, Math.max(40, basic.avatarSize ?? 72));
  const shape = basic.avatarShape ?? "rounded";
  const width = Math.round(size * 2);
  const height = shape === "circle" ? width : Math.round(width * 4 / 3);
  let png = await sharp(Buffer.from(bytes)).rotate().resize(width, height, { fit: "cover" }).png().toBuffer();
  if (shape !== "square") {
    const radius = shape === "circle" ? width / 2 : Math.round(width * 0.09);
    const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="white"/></svg>`);
    png = await sharp(png).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  }
  return new ImageRun({ type: "png", data: png, transformation: { width: size, height: shape === "circle" ? size : Math.round(size * 4 / 3) }, altText: { name: "avatar", title: "个人头像", description: "个人头像" } });
}

function basicContactParts(basic: Partial<BasicContent> | undefined): string[] {
  if (!basic) return [];
  const order = getOrderedBasicKeys(basic.fieldOrder);
  const parts: string[] = [];
  for (const k of order) {
    if (k === "links") continue;
    const val = basic[k]?.trim();
    if (val) parts.push(val);
  }
  return parts;
}

async function header(title: string, basic: Partial<BasicContent> | undefined, style: ResumeStyle, width: number, avatar?: Uint8Array): Promise<Block> {
  const name = basic?.name?.trim() || title.trim() || "简历";
  const sep = style.contactSeparator !== undefined ? style.contactSeparator : "·";
  const gap = style.contactGap !== undefined ? style.contactGap : 8;
  const delimiter = !sep ? (gap >= 16 ? "    " : "   ") : (sep.includes(" ") ? sep : ` ${sep} `);
  const contact = basicContactParts(basic).join(delimiter);
  const links = basic?.links?.trim() ?? "";
  const line = [contact, links].filter(Boolean).join(" ｜ ");
  const colored = style.headerStyle === "banner" || style.headerStyle === "card";
  const color = colored ? "FFFFFF" : wordColor(style.ink);
  const alignment = style.titleAlign === "center" ? AlignmentType.CENTER : AlignmentType.LEFT;
  const rule = style.titleRule === "accent" ? style.accent : style.titleRule === "dark" ? "#262626" : null;
  const heading = new Paragraph({
    heading: HeadingLevel.TITLE, alignment, keepNext: Boolean(line),
    children: plainRuns(name, { bold: style.nameWeight >= 600, size: halfPt(style.nameSize), color }),
    spacing: { after: line ? px(4) : 0 },
  });
  const text = line ? [heading, new Paragraph({
    alignment, children: plainRuns(line, { size: halfPt(style.contactSize), color: colored ? "FFFFFF" : wordColor(style.muted) }),
    spacing: { after: 0 },
  })] : [heading];
  const photo = await avatarRun(basic ?? {}, avatar);
  const background = wordColor(style.headerBg || style.accent);
  const box = colored ? { fill: background } : undefined;
  const pad = colored ? px(style.headerStyle === "banner" ? 12 : 14) : 0;
  const photoWidth = photo ? px((basic?.avatarSize ?? 72) + 16) : 0;
  const bottom = rule && !colored ? { style: BorderStyle.SINGLE, color: wordColor(rule), size: Math.max(4, Math.round(style.titleRuleThickness * 6)) } : undefined;
  const left = new TableCell({
    children: text, shading: box, verticalAlign: VerticalAlign.CENTER,
    borders: bottom ? { bottom } : undefined,
    width: { size: width - photoWidth, type: WidthType.DXA },
    margins: { left: colored ? px(14) : 0, right: px(8), top: pad, bottom: pad },
  });
  const cells = [left];
  const widths = [width - photoWidth];
  if (photo) {
    cells.push(new TableCell({
      children: [new Paragraph({ children: [photo], alignment: AlignmentType.RIGHT, spacing: { after: 0 } })],
      shading: box, verticalAlign: VerticalAlign.CENTER,
      borders: bottom ? { bottom } : undefined,
      width: { size: photoWidth, type: WidthType.DXA },
      margins: { left: 0, right: colored ? px(10) : 0, top: pad, bottom: pad },
    }));
    widths.push(photoWidth);
  }
  return table(cells, widths);
}

function sectionLabel(label: string, style: ResumeStyle, center: boolean): Paragraph[] {
  const band = style.sectionDeco === "band";
  const deco = wordColor(style.sectionDecoColor);
  const leftbar = style.sectionDeco === "leftbar";
  const heading = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT,
    keepNext: true,
    children: [new TextRun({ text: label, bold: style.sectionWeight >= 600, size: halfPt(style.sectionSize), color: band ? "FFFFFF" : wordColor(style.sectionColor) })],
    shading: band ? { fill: deco } : undefined,
    border: style.sectionDeco === "underline" ? { bottom: { style: BorderStyle.SINGLE, color: deco, size: 6 } }
      : leftbar ? { left: { style: BorderStyle.SINGLE, color: deco, size: 20, space: 6 } } : undefined,
    spacing: leftbar ? { before: 0, after: 0, line: px(style.sectionSize * 1.4), lineRule: LineRuleType.EXACT }
      : { before: px(style.sectionGapBefore), after: px(style.sectionGapAfter) },
  });
  if (!leftbar) return [heading];
  const spacer = (gap: number) => new Paragraph({ keepNext: true,
    spacing: { after: px(gap), line: 1, lineRule: LineRuleType.EXACT } });
  return [spacer(style.sectionGapBefore), heading, spacer(style.sectionGapAfter)];
}

// 将一条经历串成独立的分页组；实际页高由 Word/WPS 排版决定。
function entryPagination(hasFollowing: boolean) {
  return { keepNext: hasFollowing, keepLines: true };
}

function entryHeading(entry: Entry, type: "education" | "work" | "projects" | "custom", style: ResumeStyle, width: number, hasDetails: boolean): Block | null {
  const keys = ENTRY_KEYS[type];
  const primary = keys.title.map((key) => entry[key]).filter((value) => value?.trim()).join(" · ");
  const secondary = keys.sub.map((key) => entry[key]).filter((value) => value?.trim()).join(" · ");
  const period = [entry.start, entry.end].filter((value) => value?.trim()).join(" ~ ");
  if (!primary && !secondary && !period) return null;
  const title = new Paragraph({
    heading: HeadingLevel.HEADING_2, ...entryPagination(hasDetails),
    children: [
      ...plainRuns(primary, { bold: style.entryTitleWeight >= 600, size: halfPt(style.entryTitleSize), color: wordColor(style.ink) }),
      ...(secondary ? plainRuns(`${primary ? " | " : ""}${secondary}`, { size: halfPt(Math.max(10, style.entryTitleSize - 1)), color: wordColor(style.entrySubAccent ? style.accent : style.muted) }) : []),
    ],
    spacing: { before: px(style.entryGap), after: 0 },
  });
  if (!period) return title;
  const dateWidth = Math.min(mm(65), Math.round(width * 0.5));
  return table([
    new TableCell({ children: [title], width: { size: width - dateWidth, type: WidthType.DXA }, margins: { top: 0, bottom: 0, left: 0, right: px(8) } }),
    new TableCell({
      children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: plainRuns(period, { size: halfPt(style.contactSize), color: wordColor(style.muted) }),
        spacing: { after: 0 },
        ...entryPagination(hasDetails),
      })],
      width: { size: dateWidth, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    }),
  ], [width - dateWidth, dateWidth]);
}

function moduleBlocks(mod: ModuleData, style: ResumeStyle, width: number, nextListInstance: () => number): Block[] {
  const body: Block[] = [];
  if (mod.type === "basic") {
    const basic = (mod.content ?? {}) as Partial<BasicContent>;
    const parts = basicContactParts(basic);
    if (basic.links?.trim()) parts.push(basic.links.trim());
    const lines = parts.join(" ｜ ");
    if (lines) body.push(new Paragraph({ children: plainRuns(lines) }));
  } else if (mod.type === "education" || mod.type === "work" || mod.type === "projects" || mod.type === "custom") {
    const entries: Entry[] = Array.isArray(mod.content) ? mod.content
      : mod.content && typeof mod.content === "object" && typeof (mod.content as { text?: string }).text === "string"
        ? [{ description: (mod.content as { text: string }).text }] : [];
    for (const entry of entries) {
      const subItems = (entry.subItems ?? []).filter((sub) => sub.label?.trim() || sub.value?.trim());
      const descriptions = entry.descriptionItems?.filter((text) => text.trim()) ?? [];
      const hasDescription = descriptions.length > 0 || Boolean(entry.description?.trim());
      const heading = entryHeading(entry, mod.type, style, width, subItems.length > 0 || hasDescription);
      if (heading) body.push(heading);
      for (const [index, sub] of subItems.entries()) {
        body.push(new Paragraph({
          children: [new TextRun({ text: sub.label?.trim() ? `${sub.label}：` : "", bold: true }), ...plainRuns(sub.value ?? "")],
          spacing: { after: px(style.descItemGap ?? 2) },
          ...entryPagination(index < subItems.length - 1 || hasDescription),
        }));
      }
      if (descriptions.length) {
        const instance = nextListInstance();
        for (const [index, text] of descriptions.entries()) body.push(new Paragraph({
          children: richRuns(parseRichTextToNodes(text)), spacing: { after: px(style.descItemGap ?? 2) },
          ...entryPagination(index < descriptions.length - 1),
          ...(entry.descriptionStyle === "ordered"
            ? { numbering: { reference: "resume-ordered", level: 0, instance } }
            : { numbering: { reference: "resume-bullet", level: 0 } }),
        }));
      } else if (entry.description?.trim()) body.push(richParagraph(entry.description, style, true));
    }
  } else if (mod.type === "skills") {
    const skills = (mod.content ?? {}) as Partial<SkillsContent>;
    const items = (skills.items ?? []).filter((item) => item.trim());
    if (items.length && style.skillStyle === "line") {
      body.push(new Paragraph({ children: plainRuns(items.join(" ｜ ")) }));
    } else if (items.length && style.skillStyle === "pill") {
      body.push(new Paragraph({ children: items.flatMap((item) => [
        ...plainRuns(item, { color: wordColor(style.accent), shading: { fill: lightTint(style.accent) } }),
        new TextRun("  "),
      ]) }));
    } else {
      for (const item of items) body.push(new Paragraph({ children: plainRuns(item), numbering: { reference: "resume-bullet", level: 0 } }));
    }
  } else if (mod.type === "summary") {
    const summary = (mod.content ?? {}) as Partial<SummaryContent>;
    const items = (summary.descriptionItems ?? []).filter((text) => text.trim());
    if (items.length) {
      const instance = nextListInstance();
      for (const [index, text] of items.entries()) body.push(new Paragraph({
        children: richRuns(parseRichTextToNodes(text)), spacing: { after: px(style.descItemGap ?? 2) },
        ...entryPagination(index < items.length - 1),
        ...(summary.descriptionStyle === "ordered"
          ? { numbering: { reference: "resume-ordered", level: 0, instance } }
          : { numbering: { reference: "resume-bullet", level: 0 } }),
      }));
    } else if (summary.text?.trim()) body.push(richParagraph(summary.text, style));
  }
  return body.length ? [...sectionLabel(mod.label, style, style.layout === "single" && style.titleAlign === "center"), ...body] : [];
}

/** 按当前 PDF 模板参数生成可编辑的 A4 DOCX：标题日期同行，头像和章节样式写入 Word。 */
export async function resumeToDocx(title: string, modules: ModuleData[], options: DocxOptions = {}): Promise<Buffer> {
  const style = options.style ?? DEFAULT_STYLE;
  const contentWidth = mm(210 - style.pageMargin * 2);
  const firstBasic = modules.find((mod) => mod.type === "basic");
  const basic = firstBasic?.content as Partial<BasicContent> | undefined;
  const children: Block[] = [await header(title, basic, style, contentWidth, options.avatar)];
  const visibleModules = modules.filter((mod) => mod !== firstBasic);
  let listInstance = 0;
  const nextListInstance = () => listInstance++;
  const listIndent = px(style.baseSize * 1.1);

  if (style.layout === "twocol") {
    const asideWidth = mm(style.asideWidth);
    const mainWidth = contentWidth - asideWidth;
    const main: Block[] = [];
    const aside: Block[] = [];
    for (const mod of visibleModules) {
      const entry = mod.type === "education" || mod.type === "work" || mod.type === "projects" || mod.type === "custom";
      (entry ? main : aside).push(...moduleBlocks(mod, style, entry ? mainWidth : asideWidth, nextListInstance));
    }
    children.push(table([
      new TableCell({ children: main.length ? main : [new Paragraph("")], width: { size: mainWidth, type: WidthType.DXA }, margins: { left: 0, right: px(12), top: 0, bottom: 0 } }),
      new TableCell({ children: aside.length ? aside : [new Paragraph("")], width: { size: asideWidth, type: WidthType.DXA },
        borders: { left: { style: BorderStyle.SINGLE, color: "E2E2E2", size: 6 } },
        margins: { left: px(12), right: 0, top: 0, bottom: 0 } }),
    ], [mainWidth, asideWidth], false));
  } else {
    for (const mod of visibleModules) children.push(...moduleBlocks(mod, style, contentWidth, nextListInstance));
  }

  const font = style.font === "serif" ? "SimSun" : "Microsoft YaHei";
  const document = new Document({
    title: title.trim() || "简历", creator: "Resume Life",
    styles: { default: {
      document: {
        run: { font: { ascii: style.font === "serif" ? "Georgia" : "Calibri", hAnsi: style.font === "serif" ? "Georgia" : "Calibri", eastAsia: font },
          size: halfPt(style.baseSize), color: wordColor(style.text) },
        paragraph: { spacing: { after: px(style.descItemGap ?? 2), line: Math.round(240 * style.lineHeight) } },
      },
    } },
    numbering: { config: [
      { reference: "resume-bullet", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", suffix: LevelSuffix.SPACE,
        style: { paragraph: { indent: { left: listIndent, hanging: listIndent } } } }] },
      { reference: "resume-ordered", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", start: 1, suffix: LevelSuffix.SPACE,
        style: { paragraph: { indent: { left: listIndent, hanging: listIndent } } } }] },
    ] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: {
      top: mm(style.pageMargin), bottom: mm(style.pageMargin), left: mm(style.pageMargin), right: mm(style.pageMargin),
    } } }, children }],
  });
  return Packer.toBuffer(document);
}
