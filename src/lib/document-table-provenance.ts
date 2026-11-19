import { createHash } from "node:crypto";

/** v1 only identifies generated DOCX table labels, not headers, notes or all layout. */
export type DocumentTableProvenance = {
  version: 1;
  format: "docx";
  offsetUnit: "utf16";
  textSha256: string;
  markers: { start: number; end: number }[];
};

export const MAX_DOCUMENT_TABLE_MARKERS = 20_000;
export const MAX_DOCUMENT_TABLE_PROVENANCE_BYTES = 1_000_000;

export class DocumentTableProvenanceError extends Error {
  constructor() {
    super("文档表格来源信息损坏或与正文不符，请重新导入材料");
    this.name = "DocumentTableProvenanceError";
  }
}

const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysEqual = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const splitSurrogate = (text: string, offset: number) => offset > 0 && offset < text.length
  && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
  && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;

/** Hash binds offsets to text; it is not authentication of client-supplied data. */
export function validateDocumentTableProvenance(value: unknown, text: string): DocumentTableProvenance {
  const fail = (): never => { throw new DocumentTableProvenanceError(); };
  if (!record(value) || !keysEqual(value, ["version", "format", "offsetUnit", "textSha256", "markers"])
      || value.version !== 1 || value.format !== "docx" || value.offsetUnit !== "utf16"
      || value.textSha256 !== textHash(text) || !Array.isArray(value.markers)
      || value.markers.length > MAX_DOCUMENT_TABLE_MARKERS) return fail();
  let previousEnd = 0;
  const markers = Array.from(value.markers, marker => {
    if (!record(marker) || !keysEqual(marker, ["start", "end"])
        || typeof marker.start !== "number" || typeof marker.end !== "number"
        || !Number.isSafeInteger(marker.start) || !Number.isSafeInteger(marker.end)
        || marker.start < previousEnd || marker.start >= marker.end || marker.end > text.length
        || splitSurrogate(text, marker.start) || splitSurrogate(text, marker.end)) return fail();
    previousEnd = marker.end;
    return { start: marker.start, end: marker.end };
  });
  // Return a canonical copy so mutation/property order cannot change revisions.
  return { version: 1, format: "docx", offsetUnit: "utf16", textSha256: value.textSha256 as string, markers };
}

export function createDocumentTableProvenance(text: string, markers: DocumentTableProvenance["markers"]): DocumentTableProvenance {
  return validateDocumentTableProvenance({ version: 1, format: "docx", offsetUnit: "utf16", textSha256: textHash(text), markers }, text);
}

export function serializeDocumentTableProvenance(value: unknown, text: string): string {
  const serialized = JSON.stringify(validateDocumentTableProvenance(value, text));
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_TABLE_PROVENANCE_BYTES) throw new DocumentTableProvenanceError();
  return serialized;
}

/** Absence is unknown; an explicit object with markers:[] means known no table labels. */
export function parseDocumentTableProvenance(serialized: string | null | undefined, text: string): DocumentTableProvenance | null {
  if (serialized === null || serialized === undefined) return null;
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_TABLE_PROVENANCE_BYTES) throw new DocumentTableProvenanceError();
  try {
    return validateDocumentTableProvenance(JSON.parse(serialized), text);
  } catch {
    throw new DocumentTableProvenanceError();
  }
}

export type DocumentTableSegment = { kind: "text" | "table-layout"; text: string };

/** Emit text exactly once. Text may itself contain labels/JSON; its kind never changes. */
export function documentTableSegments(text: string, provenance: DocumentTableProvenance): DocumentTableSegment[] {
  const { markers } = validateDocumentTableProvenance(provenance, text);
  const segments: DocumentTableSegment[] = [];
  let offset = 0;
  for (const marker of markers) {
    if (offset < marker.start) segments.push({ kind: "text", text: text.slice(offset, marker.start) });
    segments.push({ kind: "table-layout", text: text.slice(marker.start, marker.end) });
    offset = marker.end;
  }
  if (offset < text.length || segments.length === 0) segments.push({ kind: "text", text: text.slice(offset) });
  return segments;
}
