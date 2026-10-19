export const MAX_DOCX_ENTRIES = 256;
export const MAX_DOCX_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export class DocxBudgetError extends Error {}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new DocxBudgetError("DOCX 缺少有效的 ZIP 中央目录");
}

export function assertDocxArchiveBudget(data: Buffer): void {
  if (data.length < 22) throw new DocxBudgetError("DOCX 压缩包结构无效");
  const end = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(end + 4);
  const centralDisk = data.readUInt16LE(end + 6);
  const entriesOnDisk = data.readUInt16LE(end + 8);
  const entryCount = data.readUInt16LE(end + 10);
  const centralSize = data.readUInt32LE(end + 12);
  const centralOffset = data.readUInt32LE(end + 16);
  const commentLength = data.readUInt16LE(end + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
      entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new DocxBudgetError("DOCX 不支持多卷或 ZIP64 压缩包");
  }
  if (entryCount > MAX_DOCX_ENTRIES) throw new DocxBudgetError("DOCX 包含过多文件");
  if (end + 22 + commentLength !== data.length || centralOffset + centralSize !== end) {
    throw new DocxBudgetError("DOCX ZIP 目录范围无效");
  }

  let offset = centralOffset;
  let totalExpanded = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) {
      throw new DocxBudgetError("DOCX ZIP 条目结构无效");
    }
    const flags = data.readUInt16LE(offset + 8);
    const compressed = data.readUInt32LE(offset + 20);
    const expanded = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const entryCommentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || expanded === 0xffffffff || localOffset === 0xffffffff) {
      throw new DocxBudgetError("DOCX 含加密或 ZIP64 条目");
    }
    if (expanded > MAX_DOCX_ENTRY_BYTES) throw new DocxBudgetError("DOCX 单个文件展开后过大");
    totalExpanded += expanded;
    if (totalExpanded > MAX_DOCX_EXPANDED_BYTES) throw new DocxBudgetError("DOCX 展开后总体积过大");
    if (expanded > 1024 * 1024 && expanded / Math.max(1, compressed) > MAX_COMPRESSION_RATIO) {
      throw new DocxBudgetError("DOCX 压缩比异常");
    }
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new DocxBudgetError("DOCX ZIP 本地条目偏移无效");
    }
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressed > centralOffset) throw new DocxBudgetError("DOCX ZIP 条目数据范围无效");
    offset += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (offset !== end) throw new DocxBudgetError("DOCX ZIP 中央目录长度无效");
}
