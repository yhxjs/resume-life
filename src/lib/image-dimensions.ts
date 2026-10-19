import { FileFormatError } from "./parse-sandbox";

const INVALID_IMAGE = "图片文件损坏或不支持该格式";

/** 只读取格式头部，不调用任何像素解码器。 */
export function readImageDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
      throw new FileFormatError(INVALID_IMAGE);
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw new FileFormatError(INVALID_IMAGE);
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7) break;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    throw new FileFormatError(INVALID_IMAGE);
  }

  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const kind = bytes.toString("ascii", 12, 16);
    const start = 20;
    if (kind === "VP8X" && bytes.length >= start + 10) {
      return { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 };
    }
    if (kind === "VP8L" && bytes.length >= start + 5 && bytes[start] === 0x2f) {
      const a = bytes[start + 1]!;
      const b = bytes[start + 2]!;
      const c = bytes[start + 3]!;
      const d = bytes[start + 4]!;
      return { width: 1 + a + ((b & 0x3f) << 8), height: 1 + ((b & 0xc0) >> 6) + (c << 2) + ((d & 0x0f) << 10) };
    }
    if (kind === "VP8 " && bytes.length >= start + 10 && bytes.toString("hex", start + 3, start + 6) === "9d012a") {
      return { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff };
    }
    throw new FileFormatError(INVALID_IMAGE);
  }

  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") {
    const dibSize = bytes.readUInt32LE(14);
    if (dibSize === 12) {
      return { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) };
    }
    if (dibSize >= 40) {
      return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
    }
  }
  throw new FileFormatError(INVALID_IMAGE);
}
