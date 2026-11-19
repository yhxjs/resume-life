import { documentTableSegments, type DocumentTableProvenance, type DocumentTableSegment } from "./document-table-provenance";

export type ProjectMaterialRecordSource = {
  title: string;
  content: string;
  tableProvenance?: DocumentTableProvenance | null;
};

type TableDocumentRecord = {
  materialNumber: number;
  title: string;
  tableDocument: { version: 1; format: "docx"; segments: DocumentTableSegment[] };
};
export type ProjectMaterialRecord = { materialNumber: number; title: string; content: string } | TableDocumentRecord;

/** Summary JSONL and interview JSON arrays share the same lossless record shape. */
export function encodeProjectMaterialRecord(material: ProjectMaterialRecordSource, index: number): ProjectMaterialRecord {
  if (material.tableProvenance != null) {
    return { materialNumber: index + 1, title: material.title,
      tableDocument: { version: 1, format: "docx", segments: documentTableSegments(material.content, material.tableProvenance) } };
  }
  // Key order is part of the legacy message compatibility contract.
  return { materialNumber: index + 1, title: material.title, content: material.content };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysEqual = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Recognize the generated record shape, never label-like strings within data. */
export function isProjectTableDocumentRecord(value: unknown): value is TableDocumentRecord {
  if (!record(value) || !keysEqual(value, ["materialNumber", "title", "tableDocument"])
    || typeof value.materialNumber !== "number" || !Number.isSafeInteger(value.materialNumber) || value.materialNumber < 1
    || typeof value.title !== "string") return false;
  const document = value.tableDocument;
  return record(document) && keysEqual(document, ["version", "format", "segments"])
    && document.version === 1 && document.format === "docx" && Array.isArray(document.segments) && document.segments.length > 0
    && document.segments.every(segment => record(segment) && keysEqual(segment, ["kind", "text"])
      && (segment.kind === "text" || segment.kind === "table-layout") && typeof segment.text === "string");
}
