/**
 * Report names share one portable namespace, including the suite summary.
 * @param {string} id
 * @param {boolean} [allowHierarchy]
 * @returns {{ fileId: string; key: string } | null}
 */
export function evaluationArtifactIdentity(id, allowHierarchy = false) {
  const pattern = allowHierarchy ? /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/i : /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!pattern.test(id)) return null;
  const fileId = id.replaceAll("/", "-");
  const key = fileId.toLowerCase();
  // Device aliases remain reserved with a .json or .png extension on Windows.
  if (key === "summary" || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(key)) return null;
  return { fileId, key };
}

const invalidSelection = "样本 ID 必须有效、唯一且不能共用报告文件名";

/** @param {unknown} value @returns {string[]} */
export function parseEvaluationSampleIds(value) {
  if (!Array.isArray(value)) throw new Error(invalidSelection);
  const outputKeys = new Set();
  return Array.from(value, id => {
    const identity = typeof id === "string" ? evaluationArtifactIdentity(id, true) : null;
    if (!identity || outputKeys.has(identity.key)) throw new Error(invalidSelection);
    outputKeys.add(identity.key);
    return id;
  });
}

/** @param {string | undefined} value @returns {string[]} */
export function parseEvaluationSampleEnvironment(value) {
  if (value === undefined) return [];
  try {
    return parseEvaluationSampleIds(JSON.parse(value));
  } catch {
    throw new Error(invalidSelection);
  }
}

/** @param {readonly string[]} ids @returns {string} */
export function evaluationSamplePattern(ids) {
  return `^(?:${ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
}

/** The CLI order is metadata; the suite retains its own execution order.
 * @param {readonly string[]} requestedIds
 * @param {unknown} recordedIds
 * @returns {boolean}
 */
export function hasExactEvaluationSampleIds(requestedIds, recordedIds) {
  return new Set(requestedIds).size === requestedIds.length &&
    Array.isArray(recordedIds) && recordedIds.length === requestedIds.length &&
    new Set(recordedIds).size === recordedIds.length &&
    requestedIds.every(id => recordedIds.includes(id));
}
