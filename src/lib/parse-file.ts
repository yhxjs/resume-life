import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assertDocxArchiveBudget } from "./docx-budget";
import { createDocumentTableProvenance, MAX_DOCUMENT_TABLE_MARKERS, type DocumentTableProvenance } from "./document-table-provenance";
import {
  FileFormatError,
  runInSandboxedProcess,
  runInSandboxedWorker,
  UNPARSEABLE_MESSAGE,
} from "./parse-sandbox";
import { recognizeScannedPdf, recognizeMixedPdf, recognizeImage } from "./ocr-service";
import { withParsingSlot } from "./parse-concurrency";

export { ParseBusyError } from "./parse-concurrency";

export class PdfNoTextError extends FileFormatError {
  constructor(message = "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件）") {
    super(message);
    this.name = "PdfNoTextError";
  }
}

/** 保留原页序，交给 OCR 检查没有文字层的页面，不能静默返回半份文档。 */
class PdfPartialTextError extends FileFormatError {
  constructor(readonly pageTexts: string[], readonly pageNumbers: number[]) {
    super("PDF 部分页面没有可选文字，需要检查扫描内容");
  }
}

const MAX_DOCX_TEXT_CHARS = 200_000;
/** 纯文本同样必须有界：10 MiB 的 txt 会一次解出千万字符的常驻字符串，
 *  且 /api/import/parse 的 extractOnly 分支会把完整原文原样回传给客户端。
 *  计数基准与 MAX_PROJECT_MATERIAL_CHARS 一致，按 Unicode 码点。 */
const MAX_TEXT_CHARS = 200_000;
const DOCX_TIMEOUT_MS = 10_000;
const PDF_TIMEOUT_MS = 10_000;
// pdf.js 解析大文档比 mammoth 更吃内存，堆上限相应放宽，但必须仍然有界
const PDF_MAX_OLD_SPACE_MB = 512;
// 本文件与 request-limits.ts 的四道上限单位并不一致，改动时别混用：
//   MAX_JSON_REQUEST_BYTES      1 MiB   字节 —— 请求体传输体积
//   MAX_UPLOAD_FILE_BYTES       10 MiB  字节 —— 上传文件体积
//   MAX_PROJECT_MATERIAL_CHARS  200_000 码点 —— 材料正文（assertProjectMaterial）
//   本文件两个 MAX_*_CHARS     200_000 码点 —— 提取出的正文，PDF/docx/txt 各取一道
// 体积是传输层的界，码点是内容层的界：同一份文本的字节数取决于编码，
// 用字节数当内容上限会让中文材料比英文材料更早被拒。
function resolveModulePath(specifier: "mammoth" | "pdf-parse"): string {
  const localRequire = createRequire(import.meta.url);
  const traced = specifier === "mammoth"
    ? localRequire.resolve("mammoth")
    : localRequire.resolve("pdf-parse");
  // Turbopack traces literal resolutions but replaces their paths with module IDs.
  const resolved = typeof traced === "string" ? traced : specifier === "mammoth"
    ? localRequire.resolve(/* turbopackIgnore: true */ "mammoth")
    : localRequire.resolve(/* turbopackIgnore: true */ "pdf-parse");
  return resolved.startsWith("[") || resolved.includes("[external]") ? specifier : resolved;
}

async function extractDocxInWorker(data: Buffer, signal?: AbortSignal): Promise<ExtractedFileContent> {
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    let mammothPath;
    try {
      mammothPath = require.resolve(workerData.mammothPath);
    } catch {
      mammothPath = require.resolve("mammoth");
    }
    const mammothRequire = require("node:module").createRequire(mammothPath);
    const unzip = mammothRequire("./unzip");
    const docxReader = mammothRequire("./docx/docx-reader");
    const parseXml = (xml) => {
      const { DOMParser } = mammothRequire("@xmldom/xmldom");
      let invalid = false;
      const document = new DOMParser({ errorHandler: () => { invalid = true; } }).parseFromString(xml, "text/xml");
      if (invalid) throw new Error("Invalid DOCX XML");
      return document;
    };
    const serializeXml = (document) => new (mammothRequire("@xmldom/xmldom").XMLSerializer)().serializeToString(document);

    const wordNamespaces = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
    const wordChild = (node, name) => Array.from(node?.childNodes || []).find(child =>
      child.localName === name && wordNamespaces.includes(child.namespaceURI));
    const wordAttribute = (node, name) => {
      for (const namespace of wordNamespaces) if (node?.hasAttributeNS(namespace, name)) return node.getAttributeNS(namespace, name);
      return null;
    };
    const onOff = (node) => node ? !["0", "false", "off"].includes((wordAttribute(node, "val") || "").toLowerCase()) : undefined;
    let styleVisibility;
    const invalidStyleMarkers = new Set();
    const readStyleVisibility = (xml) => {
      if (!xml.includes("vanish")) return;
      const root = parseXml(xml).documentElement;
      const fallback = onOff(wordChild(wordChild(wordChild(wordChild(root, "docDefaults"), "rPrDefault"), "rPr"), "vanish")) ?? false;
      const styles = { paragraph: new Map(), character: new Map() };
      const defaults = {};
      for (const style of Array.from(root.childNodes)) {
        if (!wordNamespaces.includes(style.namespaceURI) || style.localName !== "style") continue;
        const type = wordAttribute(style, "type"), id = wordAttribute(style, "styleId");
        if (!Object.hasOwn(styles, type) || !id) continue;
        // 样式的 pPr 不允许段落标记 rPr；Word 对此有修复行为，不能猜测后继续输出。
        const malformed = wordChild(wordChild(wordChild(style, "pPr"), "rPr"), "vanish");
        styles[type].set(id, { hidden: malformed ? null : onOff(wordChild(wordChild(style, "rPr"), "vanish")), base: wordAttribute(wordChild(style, "basedOn"), "val") });
        if (["1", "true", "on"].includes((wordAttribute(style, "default") || "").toLowerCase())) defaults[type] = id;
      }
      const cache = { paragraph: new Map(), character: new Map() };
      const resolve = (type, id) => {
        const entries = styles[type], saved = cache[type];
        if (!entries.has(id)) id = type === "paragraph" ? defaults[type] : undefined;
        const chain = new Set();
        let value = fallback;
        while (entries.has(id)) {
          if (saved.has(id)) { value = saved.get(id); break; }
          if (chain.has(id)) { value = null; break; }
          chain.add(id);
          const style = entries.get(id);
          if (style.hidden !== undefined) { value = style.hidden; break; }
          id = style.base;
        }
        for (const item of chain) saved.set(item, value);
        return value;
      };
      const elements = (node) => Array.from(node?.childNodes || []).filter(item => wordNamespaces.includes(item.namespaceURI));
      const collect = (node, name) => {
        const found = [];
        for (const item of elements(node)) {
          if (item.localName === name) found.push(item);
          else if (item.localName === "sdt") found.push(...collect(wordChild(item, "sdtContent"), name));
          else if (["ins", "moveTo", "customXml"].includes(item.localName)) found.push(...collect(item, name));
        }
        return found;
      };
      const numeric = (node, initial, minimum = 0) => {
        if (!node) return initial;
        const value = wordAttribute(node, "val");
        return /^[0-9]+$/.test(value || "") && Number.isSafeInteger(Number(value)) && Number(value) >= minimum ? Number(value) : null;
      };
      const lookKeys = { firstRow: 32, lastRow: 64, firstColumn: 128, lastColumn: 256, noHBand: 512, noVBand: 1024 };
      const lookSettings = (node) => {
        if (!node) return {};
        const raw = wordAttribute(node, "val"), value = raw === null ? 0 : /^[0-9a-f]{1,4}$/i.test(raw) ? parseInt(raw, 16) : null;
        const result = {};
        for (const [key, bit] of Object.entries(lookKeys)) {
          const explicit = wordAttribute(node, key)?.toLowerCase();
          result[key] = explicit !== undefined
            ? ["1", "true", "on"].includes(explicit) ? true : ["0", "false", "off"].includes(explicit) ? false : null
            : value === null ? null : Boolean(value & bit);
        }
        return result;
      };
      const tableStyles = new Map(), resolvedTables = new Map(), tableCells = new WeakMap();
      for (const node of elements(root)) {
        if (node.localName !== "style" || wordAttribute(node, "type") !== "table") continue;
        const id = wordAttribute(node, "styleId");
        if (!id) continue;
        const properties = wordChild(node, "tblPr"), conditions = {};
        for (const condition of elements(node).filter(item => item.localName === "tblStylePr")) {
          conditions[wordAttribute(condition, "type")] = onOff(wordChild(wordChild(condition, "rPr"), "vanish"));
        }
        tableStyles.set(id, {
          base: wordAttribute(wordChild(node, "basedOn"), "val"), hidden: onOff(wordChild(wordChild(node, "rPr"), "vanish")), conditions,
          rowBand: numeric(wordChild(properties, "tblStyleRowBandSize"), undefined), columnBand: numeric(wordChild(properties, "tblStyleColBandSize"), undefined),
          look: lookSettings(wordChild(properties, "tblLook")),
        });
        if (["1", "true", "on"].includes((wordAttribute(node, "default") || "").toLowerCase())) defaults.table = id;
      }
      const tableSettings = (id) => {
        if (!tableStyles.has(id)) id = defaults.table;
        const chain = new Set();
        let result = { hidden: fallback, conditions: {}, rowBand: 0, columnBand: 0, look: {} };
        while (tableStyles.has(id)) {
          if (resolvedTables.has(id)) { result = resolvedTables.get(id); break; }
          if (chain.has(id)) { result = null; break; }
          chain.add(id);
          id = tableStyles.get(id).base;
        }
        for (const key of [...chain].reverse()) {
          const current = tableStyles.get(key);
          if (result) {
            const conditions = { ...result.conditions };
            for (const [name, value] of Object.entries(current.conditions)) {
              if (value !== undefined || !Object.hasOwn(conditions, name)) conditions[name] = value;
            }
            result = {
              hidden: current.hidden ?? result.hidden, conditions,
              rowBand: current.rowBand === undefined ? result.rowBand : current.rowBand,
              columnBand: current.columnBand === undefined ? result.columnBand : current.columnBand,
              look: { ...result.look, ...current.look },
            };
          }
          resolvedTables.set(key, result);
        }
        return result;
      };
      const readTableCells = (table) => {
        const properties = wordChild(table, "tblPr");
        const setting = tableSettings(wordAttribute(wordChild(properties, "tblStyle"), "val"));
        if (!setting) return null;
        const cells = new Map();
        const rows = collect(table, "tr").filter(row => !wordChild(wordChild(row, "trPr"), "del"));
        let headerCount = 1;
        // Word 从首行起算，只有紧随其后的连续标题行扩展 firstRow 范围。
        while (headerCount < rows.length && onOff(wordChild(wordChild(rows[headerCount], "trPr"), "tblHeader"))) headerCount++;
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const row = rows[rowIndex], props = wordChild(row, "trPr");
          let column = numeric(wordChild(props, "gridBefore"), 0);
          const after = numeric(wordChild(props, "gridAfter"), 0);
          if (column === null || after === null) return null;
          const rowCells = collect(row, "tc");
          for (let cellIndex = 0; cellIndex < rowCells.length; cellIndex++) {
            const cell = rowCells[cellIndex];
            const span = numeric(wordChild(wordChild(cell, "tcPr"), "gridSpan"), 1, 1);
            if (span === null || !Number.isSafeInteger(column + span + after)) return null;
            // 条件列样式按原始 tc 序号计算；gridBefore / gridSpan 不改变序号。
            cells.set(cell, { row, rowIndex, cellIndex, first: cellIndex === 0, last: cellIndex === rowCells.length - 1 });
            column += span;
          }
        }
        const rowBand = numeric(wordChild(properties, "tblStyleRowBandSize"), setting.rowBand);
        const columnBand = numeric(wordChild(properties, "tblStyleColBandSize"), setting.columnBand);
        for (const [cell, position] of cells) {
          const look = { firstRow: true, lastRow: false, firstColumn: true, lastColumn: false, noHBand: false, noVBand: true,
            ...setting.look, ...lookSettings(wordChild(properties, "tblLook")),
            ...lookSettings(wordChild(wordChild(position.row, "tblPrEx"), "tblLook")) };
          if (Object.values(look).includes(null) || rowBand === null || columnBand === null) { cells.set(cell, null); continue; }
          const conditions = setting.conditions;
          const firstRow = look.firstRow && position.rowIndex < headerCount;
          const lastRow = look.lastRow && position.rowIndex === rows.length - 1;
          const firstColumn = look.firstColumn && position.first;
          const lastColumn = look.lastColumn && position.last;
          const rowStart = look.firstRow && Object.hasOwn(conditions, "firstRow") ? headerCount : 0;
          const columnStart = look.firstColumn && Object.hasOwn(conditions, "firstCol") ? 1 : 0;
          let value = setting.hidden;
          const apply = (name, active) => { if (active && conditions[name] !== undefined) value = conditions[name]; };
          if (!look.noVBand && columnBand > 0 && position.cellIndex >= columnStart) apply(Math.floor((position.cellIndex - columnStart) / columnBand) % 2 ? "band2Vert" : "band1Vert", true);
          if (!look.noHBand && rowBand > 0 && position.rowIndex >= rowStart) apply(Math.floor((position.rowIndex - rowStart) / rowBand) % 2 ? "band2Horz" : "band1Horz", true);
          // Word 页面确认：行覆盖列，角落覆盖行；cnfStyle 是缓存，不覆盖实际几何条件。
          apply("firstCol", firstColumn); apply("lastCol", lastColumn);
          apply("firstRow", firstRow); apply("lastRow", lastRow);
          apply("nwCell", firstRow && firstColumn); apply("neCell", firstRow && lastColumn);
          apply("swCell", lastRow && firstColumn); apply("seCell", lastRow && lastColumn);
          cells.set(cell, value);
        }
        return cells;
      };
      const tableVisibility = (run) => {
        let cell;
        for (let ancestor = run.parentNode; ancestor; ancestor = ancestor.parentNode) {
          if (!wordNamespaces.includes(ancestor.namespaceURI)) continue;
          if (ancestor.localName === "tc" && !cell) cell = ancestor;
          if (ancestor.localName === "tbl") {
            if (!tableCells.has(ancestor)) tableCells.set(ancestor, readTableCells(ancestor));
            const cells = tableCells.get(ancestor);
            return cells === null ? null : cells.has(cell) ? cells.get(cell) : fallback;
          }
        }
        return fallback;
      };

      return (run) => {
        let paragraph = run.parentNode;
        while (paragraph && !(wordNamespaces.includes(paragraph.namespaceURI) && paragraph.localName === "p")) paragraph = paragraph.parentNode;
        const p = resolve("paragraph", wordAttribute(wordChild(wordChild(paragraph, "pPr"), "pStyle"), "val"));
        const c = resolve("character", wordAttribute(wordChild(wordChild(run, "rPr"), "rStyle"), "val"));
        const t = tableVisibility(run);
        // Word 的样式链取最近显式值；表格、段落、字符层共同决定可见性。
        // 此组合按 Word 导出页面验证，不能用 OR 或最后值覆盖替代；直接格式另行绝对覆盖。
        return t === null || p === null || c === null ? null : Boolean(Number(t) ^ Number(p) ^ Number(c));
      };
    };
    let invalidTable = false;
    const invalidTableMarkers = new Set();
    // 生成的布局说明不能把空文档变成“有正文”；用内部身份区分，保留同名用户文字。
    const generatedLabels = new Map();
    const generatedLabel = (value, family) => {
      const marker = require("node:crypto").randomUUID();
      generatedLabels.set(marker, { value, family });
      return marker;
    };
    const normalizeTables = (document, namespace) => {
      const isWord = (node, name) => node?.namespaceURI === namespace && node.localName === name;
      const children = (node) => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1);
      const child = (node, name) => children(node).find(item => isWord(item, name));
      const invalidGrid = new Error("Invalid DOCX table grid");
      const fail = () => { throw invalidGrid; };
      const number = (node, fallback, minimum) => {
        if (!node) return fallback;
        const value = node.getAttributeNS(namespace, "val");
        if (!/^[0-9]+$/.test(value || "")) return fail();
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum) return fail();
        return result;
      };
      const merge = (properties, name) => {
        const node = child(properties, name);
        if (!node) return null;
        const value = node.getAttributeNS(namespace, "val") || "continue";
        if (!["restart", "continue"].includes(value)) return fail();
        return value;
      };
      // 只遍历当前表格的可见包装节点，不能读属性修订、删除内容或嵌套表的行。
      const collect = (node, name) => {
        const result = [];
        for (const item of children(node)) {
          if (isWord(item, name)) result.push(item);
          else if (isWord(item, "sdt")) result.push(...collect(child(item, "sdtContent"), name));
          else if (["customXml", "ins", "moveTo"].some(tag => isWord(item, tag))) result.push(...collect(item, name));
        }
        return result;
      };
      let changed = false;
      // 从内到外替换，保留嵌套边界；不按跨度复制文字或展开空白网格。
      for (const table of Array.from(document.getElementsByTagNameNS(namespace, "tbl")).reverse()) {
        let ignored = false;
        for (let ancestor = table.parentNode; ancestor; ancestor = ancestor.parentNode) {
          if (ancestor.namespaceURI === namespace &&
              (["del", "moveFrom", "sdtPr", "drawing"].includes(ancestor.localName) || ancestor.localName.endsWith("PrChange") ||
               isWord(ancestor, "tr") && child(child(ancestor, "trPr"), "del"))) ignored = true;
        }
        if (ignored) continue;
        const fragment = document.createDocumentFragment();
        const label = (value, generated = true) => {
          const element = (name) => document.createElementNS(namespace, table.prefix ? table.prefix + ":" + name : name);
          const paragraph = element("p"), run = element("r"), text = element("t");
          text.appendChild(document.createTextNode(generated ? generatedLabel(value, "table") : value));
          run.appendChild(text); paragraph.appendChild(run); fragment.appendChild(paragraph);
        };
        try {
          const rows = [];
          let previous = new Map();
          for (const row of collect(table, "tr")) {
            const properties = child(row, "trPr");
            if (child(properties, "del")) continue;
            const before = number(child(properties, "gridBefore"), 0, 0);
            const after = number(child(properties, "gridAfter"), 0, 0);
            let column = before + 1;
            const cells = [];
            let horizontal = null;
            for (const cell of collect(row, "tc")) {
              const props = child(cell, "tcPr");
              const width = number(child(props, "gridSpan"), 1, 1);
              const vertical = merge(props, "vMerge");
              const horizontalMerge = merge(props, "hMerge");
              if (!Number.isSafeInteger(column + width + after)) fail();
              if (horizontalMerge === "continue") {
                if (!horizontal || horizontal.vertical !== vertical) fail();
                horizontal.width += width;
              } else {
                const item = { node: cell, column, width, vertical, height: 1 };
                cells.push(item);
                horizontal = horizontalMerge === "restart" ? item : null;
              }
              column += width;
            }
            const current = new Map();
            const visibleCells = [];
            for (const cell of cells) {
              if (cell.vertical === "continue") {
                const origin = previous.get(cell.column);
                if (!origin || origin.width !== cell.width) fail();
                origin.height++;
                current.set(cell.column, origin);
              } else {
                visibleCells.push(cell);
                if (cell.vertical === "restart") current.set(cell.column, cell);
              }
            }
            previous = current;
            rows.push({ before, after, cells: visibleCells });
          }
          label("[表格]");
          for (let index = 0; index < rows.length; index++) {
            const row = rows[index];
            label("[第 " + (index + 1) + " 行" + (row.before ? "；前空缺 " + row.before + " 列" : "") +
              (row.after ? "；后空缺 " + row.after + " 列" : "") + "]");
            for (const cell of row.cells) {
              label("[第 " + (index + 1) + " 行，第 " + cell.column + " 列" +
                (cell.height > 1 ? "；跨 " + cell.height + " 行" : "") + (cell.width > 1 ? "；跨 " + cell.width + " 列" : "") + "]");
              for (const node of Array.from(cell.node.childNodes)) {
                if (!isWord(node, "tcPr")) fragment.appendChild(node.cloneNode(true));
              }
            }
          }
          label("[表格结束]");
        } catch (error) {
          if (error !== invalidGrid) throw error;
          // Mammoth 也会读取未引用的注。只在错误表格实际进入正文时拒绝整份提取，
          // 随机内部标记不会与用户文字冲突，也不会进入结果或模型请求。
          const marker = require("node:crypto").randomUUID();
          invalidTableMarkers.add(marker);
          label(marker, false);
        }
        table.parentNode.replaceChild(fragment, table);
        changed = true;
      }
      return changed;
    };
    const normalizeXml = (xml) => {
      // 仅对可能含不受支持节点的 XML 解析工作副本；不改 ZIP、依赖或用户文本。
      if (!styleVisibility && !xml.includes(":cr") && !xml.includes("<cr") && !xml.includes("<![CDATA[") &&
          !xml.includes("wordprocessingShape") && !xml.includes("AlternateContent") && !xml.includes("vanish") &&
          !xml.includes(":tbl") && !xml.includes("<tbl")) return xml;
      const document = parseXml(xml);
      let changed = false;
      const shapeNamespace = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
      const compatibilityNamespace = "http://schemas.openxmlformats.org/markup-compatibility/2006";
      // 先将备用布局收敛到唯一分支，防止之后扫描 drawing 时读到隐藏 Choice。
      for (const node of Array.from(document.getElementsByTagNameNS(compatibilityNamespace, "AlternateContent")).reverse()) {
        const choice = Array.from(node.childNodes).find(child => {
          if (child.namespaceURI !== compatibilityNamespace || child.localName !== "Choice") return false;
          const required = (child.getAttribute("Requires") || "").trim().split(/\\s+/).filter(Boolean);
          return required.length && required.every(prefix => child.lookupNamespaceURI(prefix) === shapeNamespace);
        });
        const selected = choice || Array.from(node.childNodes).find(child =>
          child.namespaceURI === compatibilityNamespace && child.localName === "Fallback");
        const fragment = document.createDocumentFragment();
        for (const child of Array.from(selected?.childNodes || [])) fragment.appendChild(child.cloneNode(true));
        node.parentNode.replaceChild(fragment, node);
        changed = true;
      }
      for (const namespace of ["http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "http://purl.oclc.org/ooxml/wordprocessingml/main"]) {
        // 直接格式优先；否则读取共享样式，不能让隐藏的旧事实进入材料。
        for (const run of Array.from(document.getElementsByTagNameNS(namespace, "r"))) {
          const direct = onOff(wordChild(wordChild(run, "rPr"), "vanish"));
          const hidden = direct !== undefined ? direct : styleVisibility?.(run);
          if (hidden === null) {
            // 错误只在内容实际被读取时触发，不让未引用的注或弃用分支污染结果。
            const marker = require("node:crypto").randomUUID();
            invalidStyleMarkers.add(marker);
            const text = document.createElementNS(namespace, run.prefix ? run.prefix + ":t" : "t");
            text.appendChild(document.createTextNode(marker));
            while (run.firstChild) run.removeChild(run.firstChild);
            run.appendChild(text);
            changed = true;
          } else if (hidden) {
            run.parentNode.removeChild(run);
            changed = true;
          }
        }
        // 现代文本框与 VML 同样按锚定段落后独立正文读取，不依靠坐标猜浮动阅读顺序。
        for (const drawing of Array.from(document.getElementsByTagNameNS(namespace, "drawing")).reverse()) {
          const contents = Array.from(drawing.getElementsByTagNameNS(shapeNamespace, "txbx"))
            .flatMap(box => Array.from(box.childNodes).filter(child =>
              child.namespaceURI === namespace && child.localName === "txbxContent"));
          if (contents.length) {
            const container = document.createElementNS(namespace, drawing.prefix ? drawing.prefix + ":pict" : "pict");
            for (const content of contents) container.appendChild(content.cloneNode(true));
            drawing.parentNode.replaceChild(container, drawing);
            changed = true;
          }
        }
        for (const node of Array.from(document.getElementsByTagNameNS(namespace, "cr"))) {
          node.parentNode.replaceChild(document.createElementNS(namespace, node.prefix ? node.prefix + ":br" : "br"), node);
          changed = true;
        }
        // mammoth 忽略 CDATA；在 Word 文本节点内将其转为等价文本，合并相邻文本节点。
        for (const node of Array.from(document.getElementsByTagNameNS(namespace, "t"))) {
          for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === 4) {
              node.replaceChild(document.createTextNode(child.data), child);
              changed = true;
            }
          }
          node.normalize();
        }
        if (normalizeTables(document, namespace)) changed = true;
      }
      return changed ? serializeXml(document) : xml;
    };
    let invalidSection = false;
    const prepareDocx = async (sourceFile) => {
      const { mainDocument, styles } = await docxReader._findPartPaths(sourceFile);
      if (styles && sourceFile.exists(styles)) styleVisibility = readStyleVisibility(await sourceFile.read(styles, "utf-8"));
      const file = { ...sourceFile, read(name, encoding) {
        return sourceFile.read(name, encoding).then(value => encoding === "utf-8" ? normalizeXml(value) : value);
      } };
      const source = await file.read(mainDocument, "utf-8");
      if (!source.includes("headerReference") && !source.includes("footerReference")) return file;
      const posix = require("node:path").posix;
      const wordNamespaces = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
      const relationshipNamespaces = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];
      const packageNamespace = "http://schemas.openxmlformats.org/package/2006/relationships";
      const isWord = (node, name) => node?.localName === name && wordNamespaces.includes(node.namespaceURI);
      const children = (node) => Array.from(node?.childNodes || []).filter(child => child.nodeType === 1);
      const child = (node, name) => children(node).find(item => isWord(item, name));
      const attribute = (node, name, namespaces = wordNamespaces) => {
        for (const namespace of namespaces) if (node?.hasAttributeNS(namespace, name)) return node.getAttributeNS(namespace, name);
        return null;
      };
      const enabled = (node) => !!node && !["0", "false", "off"].includes((attribute(node, "val") || "").toLowerCase());
      const fail = () => { invalidSection = true; throw new Error("Invalid DOCX section reference"); };
      const relsPath = (part) => posix.join(posix.dirname(part), "_rels", posix.basename(part) + ".rels");
      const readRelationships = async (part) => {
        const name = relsPath(part);
        const document = parseXml(file.exists(name) ? await file.read(name, "utf-8") : '<Relationships xmlns="' + packageNamespace + '"/>');
        const entries = new Map();
        for (const node of children(document.documentElement)) {
          if (node.namespaceURI !== packageNamespace || node.localName !== "Relationship") continue;
          const id = node.getAttribute("Id");
          if (!id || entries.has(id)) fail();
          entries.set(id, node);
        }
        return { document, entries };
      };
      const targetPath = (part, node) => {
        if (!node || !["", "Internal"].includes(node.getAttribute("TargetMode") || "")) return fail();
        let target;
        try { target = decodeURIComponent(node.getAttribute("Target") || ""); } catch { return fail(); }
        if (!target || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target) ||
            target.includes(String.fromCharCode(92)) || target.includes("?") || target.includes("#")) return fail();
        const resolved = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(part), target));
        if (resolved === ".." || resolved.startsWith("../") || !file.exists(resolved)) return fail();
        return resolved;
      };
      const relationshipType = (node, type) => relationshipNamespaces.some(namespace => node?.getAttribute("Type") === namespace + "/" + type);
      const relationships = await readRelationships(mainDocument);
      let evenAndOdd = false;
      const settingsRelation = [...relationships.entries.values()].find(node => relationshipType(node, "settings"));
      if (settingsRelation) {
        const settings = parseXml(await file.read(targetPath(mainDocument, settingsRelation), "utf-8"));
        evenAndOdd = enabled(child(settings.documentElement, "evenAndOddHeaders"));
      }
      const document = parseXml(source);
      const body = child(document.documentElement, "body");
      if (!body) return fail();
      const sections = [];
      const collectSections = (container) => {
        for (const item of children(container)) {
          const properties = isWord(item, "sectPr") ? item : isWord(item, "p") ? child(child(item, "pPr"), "sectPr") : null;
          if (properties) sections.push(properties);
          else if (isWord(item, "sdt")) collectSections(child(item, "sdtContent"));
          else if (["customXml", "ins", "moveTo"].some(name => isWord(item, name))) collectSections(item);
        }
      };
      collectSections(body);
      if (!isWord(children(body).at(-1), "sectPr")) sections.push(null);
      const inherited = { header: new Map(), footer: new Map() };
      const parts = new Map();
      for (let index = 0; index < sections.length; index++) {
        const section = sections[index];
        const firstPage = enabled(child(section, "titlePg"));
        for (const kind of ["header", "footer"]) {
          for (const ref of children(section).filter(node => isWord(node, kind + "Reference"))) {
            const type = attribute(ref, "type");
            const id = attribute(ref, "id", relationshipNamespaces);
            if (!["default", "first", "even"].includes(type) || !id) return fail();
            inherited[kind].set(type, id);
          }
          for (const type of ["first", "default", "even"]) {
            if (type === "first" && !firstPage || type === "even" && !evenAndOdd) continue;
            const id = inherited[kind].get(type);
            if (!id) continue;
            const relation = relationships.entries.get(id);
            if (!relationshipType(relation, kind)) return fail();
            const name = targetPath(mainDocument, relation);
            const key = kind + ":" + name;
            if (!parts.has(key)) parts.set(key, { kind, name, uses: [] });
            const variant = type === "first" ? "首页" : (firstPage ? "非首页" : "") +
              (type === "even" ? "偶数页" : evenAndOdd ? "奇数页" : firstPage ? "" : "默认");
            parts.get(key).uses.push("第 " + (index + 1) + " 节" + variant);
          }
        }
      }
      let relationshipSequence = 0;
      const createWordElement = (name) => document.createElementNS(document.documentElement.namespaceURI,
        document.documentElement.prefix ? document.documentElement.prefix + ":" + name : name);
      const endProperties = isWord(body.lastChild, "sectPr") ? body.lastChild : null;
      for (const part of parts.values()) {
        const partDocument = parseXml(await file.read(part.name, "utf-8"));
        if (!isWord(partDocument.documentElement, part.kind === "header" ? "hdr" : "ftr")) return fail();
        const partRelationships = await readRelationships(part.name);
        const remappedIds = new Map();
        // 引入的内容使用自身关系表；重映射 ID，避免与正文同名链接/图片发生串用。
        for (const node of Array.from(partDocument.getElementsByTagName("*"))) {
          let ignored = false;
          for (let ancestor = node; ancestor; ancestor = ancestor.parentNode) {
            if (wordNamespaces.includes(ancestor.namespaceURI) &&
                (["del", "moveFrom"].includes(ancestor.localName) || ancestor.localName.endsWith("PrChange"))) ignored = true;
          }
          if (ignored) continue;
          for (const namespace of relationshipNamespaces) for (const name of ["id", "embed", "link"]) {
            if (!node.hasAttributeNS(namespace, name)) continue;
            const id = node.getAttributeNS(namespace, name);
            if (!remappedIds.has(id)) {
              const relation = partRelationships.entries.get(id);
              if (!relation) return fail();
              let newId;
              do { newId = "import-section-" + (++relationshipSequence); } while (relationships.entries.has(newId));
              const copy = relationships.document.importNode(relation, true);
              copy.setAttribute("Id", newId);
              if ((copy.getAttribute("TargetMode") || "") !== "External") copy.setAttribute("Target", "/" + targetPath(part.name, relation));
              relationships.document.documentElement.appendChild(copy);
              relationships.entries.set(newId, copy);
              remappedIds.set(id, newId);
            }
            const original = node.getAttributeNodeNS(namespace, name);
            node.setAttributeNS(namespace, original.name, remappedIds.get(id));
          }
        }
        const label = createWordElement("p"), run = createWordElement("r"), text = createWordElement("t");
        text.appendChild(document.createTextNode(generatedLabel("[" + (part.kind === "header" ? "页眉" : "页脚") + "：" + part.uses.join("；") + "]", "section")));
        run.appendChild(text); label.appendChild(run); body.insertBefore(label, endProperties);
        for (const node of Array.from(partDocument.documentElement.childNodes)) body.insertBefore(document.importNode(node, true), endProperties);
      }
      const replacements = new Map([[mainDocument, serializeXml(document)], [relsPath(mainDocument), serializeXml(relationships.document)]]);
      return { ...file, read(name, encoding) {
        return encoding === "utf-8" && replacements.has(name) ? Promise.resolve(replacements.get(name)) : file.read(name, encoding);
      } };
    };
    const chunks = [];
    let codePoints = 0;
    let utf16Offset = 0;
    const tableMarkerOffsets = [];
    let tooManyTableMarkers = false;
    let tooLong = false;
    let missingNote = false;
    let hasSourceText = false;
    let documentNotes;
    const referencedNotes = new Map();
    const noteQueue = [];
    const noteCounts = { footnote: 0, endnote: 0 };
    const append = (value) => {
      // 分隔符同样计入 Unicode 码点上限，超限正文不经过 IPC。
      for (const character of value) {
        if (++codePoints > workerData.maxChars) {
          tooLong = true;
          throw new Error("DOCX text limit exceeded");
        }
      }
      chunks.push(value);
      utf16Offset += value.length;
    };
    const visit = (element) => {
      if (element.type === "text") {
        if (invalidStyleMarkers.has(element.value)) throw new Error("Invalid DOCX style inheritance");
        if (invalidTableMarkers.has(element.value)) {
          invalidTable = true;
          throw new Error("Invalid DOCX table grid");
        }
        if (generatedLabels.has(element.value)) {
          const label = generatedLabels.get(element.value);
          if (label.family === "table") {
            if (tableMarkerOffsets.length / 2 >= workerData.maxTableMarkers) {
              tooManyTableMarkers = true;
              throw new Error("DOCX table marker limit exceeded");
            }
            const start = utf16Offset;
            append(label.value);
            tableMarkerOffsets.push(start, utf16Offset);
          } else append(label.value);
        }
        else {
          if (element.value.trim()) hasSourceText = true;
          append(element.value);
        }
      }
      else if (element.type === "tab") append(String.fromCharCode(9));
      else if (element.type === "break") append(String.fromCharCode(10));
      else if (element.type === "noteReference") {
        const key = element.noteType + ":" + element.noteId;
        let note = referencedNotes.get(key);
        if (!note) {
          const resolved = documentNotes?.resolve(element);
          if (!resolved || !Array.isArray(resolved.body) || !Object.hasOwn(noteCounts, element.noteType)) {
            missingNote = true;
            throw new Error("Missing DOCX note");
          }
          const label = "[" + (element.noteType === "footnote" ? "脚注" : "尾注") + " " + (++noteCounts[element.noteType]) + "]";
          note = { label, body: resolved.body };
          referencedNotes.set(key, note);
          noteQueue.push(note);
        }
        append(note.label);
      }
      else {
        for (const child of element.children || []) visit(child);
        if (element.type === "paragraph") append(String.fromCharCode(10, 10));
      }
    };
    // 复用固定版本 mammoth 1.13.0 的 extractRawText 读取链路，只替换丢换行的序列化器。
    // 内部 API 升级需跑真实 DOCX 回归；不走 HTML 转换，避免读取无关样式映射和图像。
    unzip.openZip({ buffer: Buffer.from(workerData.data) })
      .then(prepareDocx)
      .then(file => docxReader.read(file, {}, { externalFileAccess: false }))
      .then((result) => {
        documentNotes = result.value.notes;
        visit(result.value);
        // 只输出实际引用的注，保留正文中的标记与定义关系；队列防止循环引用重复展开。
        for (let index = 0; index < noteQueue.length; index++) {
          const note = noteQueue[index];
          append(note.label + String.fromCharCode(10));
          for (const child of note.body) visit(child);
        }
        // 每个跨度仅传两个32位偏移量，20k标记最多160KB；不复制内部随机身份或整份文本。
        const tableMarkers = new Uint32Array(hasSourceText ? tableMarkerOffsets : []);
        parentPort.postMessage({ value: hasSourceText ? chunks.join("") : "", tableMarkers }, [tableMarkers.buffer]);
      }).catch(() => parentPort.postMessage(tooLong ? { tooLong: true } : tooManyTableMarkers ? { tooManyTableMarkers: true } : missingNote ? { missingNote: true } : invalidSection ? { invalidSection: true } : invalidTable ? { invalidTable: true } : { invalid: true }));
  `;
  return runInSandboxedWorker<{ value?: unknown; tableMarkers?: unknown; tooManyTableMarkers?: unknown; tooLong?: unknown; invalid?: unknown; missingNote?: unknown; invalidSection?: unknown; invalidTable?: unknown }, ExtractedFileContent>(
    workerSource,
    {
      data,
      mammothPath: resolveModulePath("mammoth"),
      maxChars: MAX_DOCX_TEXT_CHARS,
      maxTableMarkers: MAX_DOCUMENT_TABLE_MARKERS,
    },
    { timeoutMs: DOCX_TIMEOUT_MS, maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    "Word 文档解析超时",
    (message) => {
      if (message.tooLong) throw new FileFormatError(`Word 文档提取文本不得超过 ${MAX_DOCX_TEXT_CHARS} 字符`);
      if (message.tooManyTableMarkers) throw new FileFormatError(`Word 文档的表格结构标记不得超过 ${MAX_DOCUMENT_TABLE_MARKERS} 个`);
      if (message.missingNote) throw new FileFormatError("Word 文档的脚注或尾注引用缺失，请检查文件后重试");
      if (message.invalidSection) throw new FileFormatError("Word 文档的页眉或页脚引用无效，请检查文件后重试");
      if (message.invalidTable) throw new FileFormatError("Word 文档的表格合并信息无效，请在 Word 中检查表格并另存为 DOCX 后重试");
      if (typeof message.value !== "string" || message.invalid) throw new FileFormatError(UNPARSEABLE_MESSAGE);
      const offsets = message.tableMarkers;
      if (!ArrayBuffer.isView(offsets) || Object.prototype.toString.call(offsets) !== "[object Uint32Array]" ||
          offsets.byteLength > MAX_DOCUMENT_TABLE_MARKERS * 2 * Uint32Array.BYTES_PER_ELEMENT || offsets.byteLength % 8 !== 0) {
        throw new FileFormatError(UNPARSEABLE_MESSAGE);
      }
      const values = offsets as Uint32Array;
      const markers = Array.from({ length: values.length / 2 }, (_, index) => ({ start: values[index * 2]!, end: values[index * 2 + 1]! }));
      return { text: message.value, tableProvenance: createDocumentTableProvenance(message.value, markers) };
    },
    { signal }
  );
}

async function extractPdfInProcess(data: Buffer, signal?: AbortSignal): Promise<string> {
  const childSource = `
    let pdfParseModule;
    try {
      pdfParseModule = require(process.argv[1]);
    } catch {
      pdfParseModule = require("pdf-parse");
    }
    const { PDFParse } = pdfParseModule;
    // 与 docx 同构：在沙箱内判定超限，超长正文不经过 IPC 回传
    const MAX_CHARS = ${MAX_TEXT_CHARS};
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", async () => {
      let parser;
      try {
        parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)) });
        let text = "";
        let pageTexts = null;
        const blankPages = new Set();
        try {
          await parser.load();
          const doc = parser.doc;
          if (doc && doc.numPages > 0) {
            const extractedPages = [];
            for (let p = 1; p <= doc.numPages; p++) {
              const page = await doc.getPage(p);
              const tc = await page.getTextContent({ includeMarkedContent: true });
              const items = [];
              const markedItems = new Map();
              const markedStack = [];
              let fullyMarked = true;
              for (const source of tc.items) {
                if (source.type === "beginMarkedContentProps" || source.type === "beginMarkedContent") {
                  const id = typeof source.id === "string" ? source.id : markedStack.at(-1);
                  markedStack.push(id);
                  if (id && !markedItems.has(id)) markedItems.set(id, []);
                } else if (source.type === "endMarkedContent") {
                  if (!markedStack.length) fullyMarked = false;
                  markedStack.pop();
                } else if (typeof source.str === "string" && source.str.length) {
                  const item = { str: source.str, x: source.transform[4], y: source.transform[5],
                    width: source.width, height: source.height };
                  items.push(item);
                  const id = markedStack.at(-1);
                  if (id) markedItems.get(id).push(item);
                  else if (source.str.trim()) fullyMarked = false;
                }
              }
              if (markedStack.length) fullyMarked = false;
              // PDF 字体切换可能拆开邮箱或代码；保留显式空白，仅在可见间隔处补空格。
              const joinLine = (line) => line.map((item, index) => {
                const previous = line[index - 1];
                const gap = previous ? item.x - previous.x - previous.width : 0;
                const threshold = previous ? Math.max(1, Math.min(previous.height, item.height) / 10) : 0;
                const separator = previous && gap > threshold &&
                  previous.str.trimEnd() === previous.str && item.str.trimStart() === item.str ? " " : "";
                return separator + item.str;
              }).join("");
              const renderText = (sourceItems) => {
                const sorted = [...sourceItems].sort((a, b) => Math.abs(a.y - b.y) <= 4 ? a.x - b.x : b.y - a.y);
                const lines = [];
                let cur = [];
                let lastY = null;
                for (const it of sorted) {
                  if (lastY === null || Math.abs(it.y - lastY) <= 4) {
                    cur.push(it);
                  } else {
                    lines.push(joinLine(cur));
                    cur = [it];
                  }
                  lastY = it.y;
                }
                if (cur.length) lines.push(joinLine(cur));
                return lines.join(String.fromCharCode(10));
              };
              let pageText = renderText(items);
              // 仅在每段可见文字都被结构树唯一引用时采用标签顺序；否则保留全部几何文本。
              if (fullyMarked && markedItems.size) {
                try {
                  const tree = await page.getStructTree();
                  if (tree) {
                    const blocks = new Set(["P", "H", "H1", "H2", "H3", "H4", "H5", "H6",
                      "Sect", "Div", "LI", "LBody", "Caption", "BlockQuote", "Code", "Note", "Figure", "Formula", "TD", "TH"]);
                    const seenNodes = new Set();
                    const referenced = new Set();
                    const segments = [];
                    const visit = (node, block, row, cell, depth) => {
                      if (!node || typeof node !== "object" || depth > 128 || seenNodes.size >= 100000 || seenNodes.has(node)) {
                        throw new Error("Invalid PDF structure");
                      }
                      seenNodes.add(node);
                      if (node.type === "content") {
                        if (typeof node.id !== "string" || referenced.has(node.id)) throw new Error("Duplicate PDF content");
                        referenced.add(node.id);
                        const group = markedItems.get(node.id);
                        if (group?.length) {
                          const previous = segments.at(-1);
                          if (previous && previous.block === block && previous.row === row && previous.cell === cell) {
                            for (const item of group) previous.items.push(item);
                          } else segments.push({ block, row, cell, items: [...group] });
                        }
                        return;
                      }
                      if (blocks.has(node.role)) block = node;
                      if (node.role === "TR") { row = node; cell = null; }
                      if (node.role === "TD" || node.role === "TH") cell = node;
                      for (const child of node.children || []) visit(child, block, row, cell, depth + 1);
                    };
                    visit(tree, tree, null, null, 0);
                    if ([...markedItems].some(([id, group]) => group.some(item => item.str.trim()) && !referenced.has(id))) {
                      throw new Error("Incomplete PDF structure");
                    }
                    const rendered = segments.map(segment => ({ ...segment, text: renderText(segment.items).trim() }))
                      .filter(segment => segment.text);
                    const structuredText = rendered.map((segment, index) => {
                      const previous = rendered[index - 1];
                      const separator = previous
                        ? String.fromCharCode(segment.row && previous.row === segment.row && previous.cell !== segment.cell ? 9 : 10)
                        : "";
                      return separator + segment.text;
                    }).join("");
                    if (structuredText) pageText = structuredText;
                  }
                } catch { /* 标签残缺或读取失败不应丢弃可见正文。 */ }
              }
              extractedPages.push(pageText);
              // 没有文字也没有绘制操作的空页无需栅格化；有图形仍交给渲染检查。
              if (!pageText.trim() && !(await page.getOperatorList()).fnArray.length) blankPages.add(p);
              page.cleanup();
            }
            pageTexts = extractedPages;
            text = pageTexts.join(String.fromCharCode(10) + String.fromCharCode(10)).trim();
          }
        } catch {
          // 视觉排序提取失败时回退到默认 getText
        }
        if (!text) {
          const result = await parser.getText();
          text = result.text || "";
          if (Array.isArray(result.pages) && result.pages.length === result.total &&
              result.pages.every((page, index) => page.num === index + 1 && typeof page.text === "string")) {
            pageTexts = result.pages.map((page) => page.text);
          }
        }
        // 过滤掉纯分页占位符，判断是否有实质内容
        const stripped = text.replace(new RegExp("--\\\\s*\\\\d+\\\\s+of\\\\s+\\\\d+\\\\s*--", "gi"), "").trim();
        if (!stripped) {
          process.stdout.write(JSON.stringify({ noText: true }));
          return;
        }
        // 沙箱内按 Unicode 码点判定上限，超长正文不经过 IPC。
        let codePoints = 0;
        for (const character of text) {
          if (++codePoints > MAX_CHARS) {
            process.stdout.write(JSON.stringify({ tooLong: true }));
            return;
          }
        }
        const pageNumbers = pageTexts?.flatMap((page, index) => !page.trim() && !blankPages.has(index + 1) ? [index + 1] : []);
        process.stdout.write(JSON.stringify({ value: text,
          missingPageTexts: pageNumbers?.length ? pageTexts : undefined,
          pageNumbers: pageNumbers?.length ? pageNumbers : undefined }));
      } catch {
        process.stdout.write(JSON.stringify({ invalid: true }));
      } finally {
        try { await parser?.destroy(); } catch { /* 销毁失败不影响已取到的结果 */ }
      }
    });
  `;
  return runInSandboxedProcess<string>(
    childSource,
    resolveModulePath("pdf-parse"),
    data,
    { timeoutMs: PDF_TIMEOUT_MS, maxOldSpaceSizeMb: PDF_MAX_OLD_SPACE_MB },
    "PDF 解析超时",
    (stdout) => {
      const message = JSON.parse(stdout) as { value?: unknown; tooLong?: unknown; invalid?: unknown; noText?: unknown; missingPageTexts?: unknown; pageNumbers?: unknown };
      if (message.tooLong) throw new FileFormatError(`PDF 提取文本不得超过 ${MAX_TEXT_CHARS} 字符`);
      if (message.noText) throw new PdfNoTextError();
      if (typeof message.value !== "string" || message.invalid) throw new FileFormatError(UNPARSEABLE_MESSAGE);
      if (message.missingPageTexts !== undefined) {
        if (!Array.isArray(message.missingPageTexts) || !message.missingPageTexts.length ||
            !message.missingPageTexts.every((page): page is string => typeof page === "string")) {
          throw new FileFormatError(UNPARSEABLE_MESSAGE);
        }
        const pageTexts = message.missingPageTexts as string[];
        if (!Array.isArray(message.pageNumbers) || !message.pageNumbers.length ||
            !message.pageNumbers.every((page, index, numbers): page is number => Number.isSafeInteger(page) &&
              page > 0 && page <= pageTexts.length && (index === 0 || page > numbers[index - 1]) && !pageTexts[page - 1]!.trim())) {
          throw new FileFormatError(UNPARSEABLE_MESSAGE);
        }
        throw new PdfPartialTextError(pageTexts, message.pageNumbers);
      }
      return message.value;
    },
    { signal }
  );
}

/** 按 Unicode 码点计数，与 request-limits.ts 的 assertProjectMaterial 同构；超限即提前退出 */
function exceedsMaxChars(text: string, maxChars: number): boolean {
  let codePoints = 0;
  const iterator = text[Symbol.iterator]();
  while (!iterator.next().done) {
    codePoints += 1;
    if (codePoints > maxChars) return true;
  }
  return false;
}

function decodeTextBuffer(data: Buffer): string {
  // 明确的 BOM 优先于编码猜测；尤其不能把 UTF-16 解成带 NUL 的 GBK/UTF-8。
  const prefix = data.subarray(0, 4).toString("hex");
  if (prefix === "fffe0000" || prefix === "0000feff") {
    throw new FileFormatError("暂不支持 UTF-32 文本，请另存为 UTF-8 后重试");
  }
  const encoding = prefix.startsWith("fffe") ? "utf-16le"
    : prefix.startsWith("feff") ? "utf-16be"
      : prefix.startsWith("efbbbf") ? "utf-8" : undefined;
  if (encoding) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch {
      throw new FileFormatError("文本编码损坏，请另存为 UTF-8 后重试");
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(data);
    } catch {
      return new TextDecoder("utf-8", { fatal: false }).decode(data);
    }
  }
}

export type ExtractTextOptions = {
  signal?: AbortSignal;
  /** Explicitly inspect all PDF pages as images when the text layer loses layout or content. */
  pdfMode?: "auto" | "image";
};

export type ExtractedFileContent = {
  text: string;
  tableProvenance?: DocumentTableProvenance;
  ocr?: {
    engine: "vision" | "local";
    pageCount: number;
    sourceType?: "pdf" | "image";
  };
};

/** 按扩展名提取文件的纯文本及结构化元信息（如 OCR 识别方法），供简历/材料解析使用 */
export async function extractContentFromFile(
  filename: string,
  data: Buffer,
  options?: ExtractTextOptions
): Promise<ExtractedFileContent> {
  return withParsingSlot(() => extractFileContent(filename, data, options), options?.signal);
}

async function extractFileContent(
  filename: string,
  data: Buffer,
  options?: ExtractTextOptions
): Promise<ExtractedFileContent> {
  const ext = path.extname(filename).toLowerCase();
  if (options?.pdfMode === "image" && ext !== ".pdf") {
    throw new FileFormatError("按页面图片识别仅支持 PDF 文件");
  }
  switch (ext) {
    case ".pdf": {
      try {
        // 显式选择复用扫描件的有界 OCR 管线，不把文字层结果与 OCR 全文重复合并。
        if (options?.pdfMode === "image") throw new PdfNoTextError();
        const text = await extractPdfInProcess(data, options?.signal);
        return { text };
      } catch (err) {
        options?.signal?.throwIfAborted();
        if (err instanceof PdfNoTextError || err instanceof PdfPartialTextError) {
          try {
            const ocrResult = err instanceof PdfPartialTextError
              ? await recognizeMixedPdf(data, err.pageTexts, err.pageNumbers, options?.signal)
              : options?.pdfMode === "image"
                ? await recognizeScannedPdf(data, options?.signal, "requested")
              : await recognizeScannedPdf(data, options?.signal);
            if (exceedsMaxChars(ocrResult.text, MAX_TEXT_CHARS)) {
              throw new FileFormatError(`PDF 提取文本不得超过 ${MAX_TEXT_CHARS} 字符`);
            }
            return {
              text: ocrResult.text,
              ...(ocrResult.engine ? { ocr: {
                engine: ocrResult.engine,
                pageCount: ocrResult.pageCount,
                sourceType: "pdf",
              } as const } : {}),
            };
          } catch (ocrErr) {
            options?.signal?.throwIfAborted();
            throw ocrErr instanceof FileFormatError
              ? ocrErr
              : new FileFormatError(
                  ocrErr instanceof Error
                    ? `${options?.pdfMode === "image" ? "PDF 图片" : "扫描版 PDF"}识别失败：${ocrErr.message}`
                    : "扫描版 PDF OCR 识别失败"
                );
          }
        }
        // 沙箱主动抛出的 FileFormatError 带具体原因（超长、超时），必须原样透出：
        // 两个调用方路由都把 err.message 回显给客户端，覆写成通用文案会让用户
        // 只看到「文件内容无法解析」，无从判断该换个文件还是改小一点。
        throw err instanceof FileFormatError ? err : new FileFormatError(UNPARSEABLE_MESSAGE);
      }
    }
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
    case ".bmp": {
      try {
        const ocrResult = await recognizeImage(data, options?.signal);
        if (exceedsMaxChars(ocrResult.text, MAX_TEXT_CHARS)) {
          throw new FileFormatError(`图片提取文本不得超过 ${MAX_TEXT_CHARS} 字符`);
        }
        return {
          text: ocrResult.text,
          ocr: {
            engine: ocrResult.engine,
            pageCount: ocrResult.pageCount,
            sourceType: "image",
          },
        };
      } catch (ocrErr) {
        options?.signal?.throwIfAborted();
        throw ocrErr instanceof FileFormatError
          ? ocrErr
          : new FileFormatError(
              ocrErr instanceof Error
                ? `图片识别失败：${ocrErr.message}`
                : "图片 OCR 识别失败"
            );
      }
    }
    case ".docx": {
      try {
        assertDocxArchiveBudget(data);
        return await extractDocxInWorker(data, options?.signal);
      } catch (err) {
        options?.signal?.throwIfAborted();
        // 同上。注意 DocxBudgetError 不是 FileFormatError，仍会落到通用文案；
        // 沙箱超时也走 parse-sandbox 的通用文案分支——这两处属既有行为，不在本次收口范围。
        throw err instanceof FileFormatError ? err : new FileFormatError(UNPARSEABLE_MESSAGE);
      }
    }
    case ".txt":
    case ".md":
    case ".markdown": {
      const text = decodeTextBuffer(data);
      if (exceedsMaxChars(text, MAX_TEXT_CHARS)) {
        throw new FileFormatError(`文本不得超过 ${MAX_TEXT_CHARS} 字符`);
      }
      return { text };
    }
    default:
      throw new FileFormatError(`暂不支持该文件类型：${ext || "(无扩展名)"}，请上传 PDF、图片（PNG/JPG/WEBP）、Word（docx）、txt 或 md`);
  }
}

export async function extractContentFromPath(
  filename: string,
  filePath: string,
  options?: ExtractTextOptions
): Promise<ExtractedFileContent> {
  return withParsingSlot(async () => {
    const data = await fs.promises.readFile(filePath, { signal: options?.signal });
    options?.signal?.throwIfAborted();
    return extractFileContent(filename, data, options);
  }, options?.signal);
}

/** 按扩展名提取文件的纯文本 */
export async function extractTextFromFile(
  filename: string,
  data: Buffer,
  options?: ExtractTextOptions
): Promise<string> {
  const result = await extractContentFromFile(filename, data, options);
  return result.text;
}

export async function extractTextFromPath(
  filename: string,
  filePath: string,
  options?: ExtractTextOptions
): Promise<string> {
  const result = await extractContentFromPath(filename, filePath, options);
  return result.text;
}
