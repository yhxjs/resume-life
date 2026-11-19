import { describe, expect, it } from "vitest";
import { documentTableCases, extractDocumentTableSample } from "../../../evals/document-table-fixture";
import { buildProjectSummaryMessages, PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "../project-summary-llm";
import { PROJECT_TABLE_DOCUMENT_FORMAT_RULES } from "../prompt-guidelines";
import { checkSafeModelInput } from "../safe-llm";
import { emptySummary } from "../summary";

describe("项目总结评测保留 DOCX typed 来源", () => {
  it.each(documentTableCases.map(sample => [sample.id, sample] as const))("%s sends extracted provenance in both modes", async (_id, sample) => {
    const extracted = await extractDocumentTableSample(sample);
    const material = {
      title: "合成 Word 表格",
      content: extracted.text,
      tableProvenance: extracted.tableProvenance,
    };
    const materialText = serializeProjectSummaryMaterial(material, 0);
    const record = JSON.parse(materialText) as Record<string, unknown>;

    expect(record).toHaveProperty("tableDocument");
    expect(record).not.toHaveProperty("content");
    expect(extracted.tableProvenance.markers.length).toBeGreaterThan(0);

    const messages = buildProjectSummaryMessages({
      projectName: sample.projectName,
      materialText,
      archive: emptySummary(),
    });
    expect(messages[0]!.parts).toContainEqual({ trust: "trusted", text: PROJECT_TABLE_DOCUMENT_FORMAT_RULES });

    for (const system of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT]) {
      const assembled = checkSafeModelInput(system, messages);
      const serialized = assembled[1]!.content;
      expect(serialized).toContain('"tableDocument"');
      expect(serialized).toContain("table-layout");
    }
  });
});
