/** Build a replayable plan from original bytes and a caller-reviewed structured resume. No model is invoked. */
export function importedResumePlan({ id, filename, bytes, result }) {
  return { id, variables: { filename, base64: Buffer.from(bytes).toString("base64"), result }, steps: [
    { id: "uploaded", kind: "upload", arguments: { filename: "$input.filename", base64: "$input.base64", purpose: "resume" } },
    { id: "extracted", kind: "job", tool: "extract_uploaded_file", arguments: { uploadId: "$steps.uploaded.uploadId" } },
    { id: "source", kind: "context", tool: "get_file_import_context", arguments: { source: { extractionKey: "$steps.extracted.extractionKey", target: { kind: "resume" } } } },
    { id: "proposal", kind: "write", tool: "submit_file_import", arguments: { source: { extractionKey: "$steps.extracted.extractionKey", target: { kind: "resume" } }, expectedRevision: "$steps.source.revision", result: "$input.result" } },
    { id: "preview", kind: "context", tool: "preview_file_import", arguments: { proposalKey: "$steps.proposal.proposalKey" } },
    { id: "saved", kind: "write", tool: "save_file_import", arguments: { proposalKey: "$steps.proposal.proposalKey", kind: "resume", previewToken: "$steps.preview.previewToken" } },
  ] };
}
