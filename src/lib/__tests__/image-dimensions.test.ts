import { describe, expect, it } from "vitest";
import { readImageDimensions } from "../image-dimensions";
import { FileFormatError } from "../parse-sandbox";

function png(width = 320, height = 240) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
function sof(marker = 0xc0) {
  const segment = Buffer.alloc(9);
  segment[0] = 0xff; segment[1] = marker;
  segment.writeUInt16BE(7, 2); segment[4] = 8;
  segment.writeUInt16BE(240, 5); segment.writeUInt16BE(320, 7);
  return segment;
}
const jpeg = (...segments: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments]);
function webp(kind: string) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8); bytes.write(kind, 12); bytes.writeUInt32LE(10, 16);
  return bytes;
}
function bmp(dibSize = 40) {
  const bytes = Buffer.alloc(26);
  bytes.write("BM", 0); bytes.writeUInt32LE(dibSize, 14);
  if (dibSize === 12) { bytes.writeUInt16LE(320, 18); bytes.writeUInt16LE(240, 20); }
  else { bytes.writeInt32LE(320, 18); bytes.writeInt32LE(-240, 22); }
  return bytes;
}

describe("图片头部尺寸读取", () => {
  it("PNG 读取完整 32 位尺寸字段，零尺寸交给调用方资源预算", () => {
    expect(readImageDimensions(png())).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(png(0, 0xffffffff))).toEqual({ width: 0, height: 0xffffffff });
  });
  it.each(["length", "type", "signature", "truncated"])("PNG 拒绝损坏的 %s", kind => {
    let bytes = png();
    if (kind === "length") bytes.writeUInt32BE(12, 8);
    if (kind === "type") bytes.write("IDAT", 12);
    if (kind === "signature") bytes[0] = 0;
    if (kind === "truncated") bytes = bytes.subarray(0, 23);
    expect(() => readImageDimensions(bytes)).toThrow(FileFormatError);
  });
  it.each([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])("JPEG SOF %i 支持尺寸读取", marker => {
    expect(readImageDimensions(jpeg(sof(marker)))).toEqual({ width: 320, height: 240 });
  });
  it("JPEG 跳过 APP 段、填充和独立 marker", () => {
    const app = Buffer.from([0xff, 0xe0, 0, 4, 0, 0]);
    const standalone = Buffer.from([0xff, 0xff, 0x01, 0xff, 0xd0, 0xff, 0xd7]);
    expect(readImageDimensions(jpeg(app, standalone, sof()))).toEqual({ width: 320, height: 240 });
  });
  it.each([
    Buffer.from([0xff, 0xe0, 0, 1]), Buffer.from([0xff, 0xe0, 0, 20]),
    Buffer.from([0xff, 0xc0, 0, 6, 0, 0, 0, 0]), Buffer.from([0xff, 0xe0, 0]),
    Buffer.from([0xff, 0xff]), Buffer.from([0x99, 0xe0, 0, 2]),
    Buffer.from([0xff, 0xda]), Buffer.from([0xff, 0xd9]),
  ])("JPEG 拒绝截断、无尺寸或非法段 %j", segment => {
    expect(() => readImageDimensions(jpeg(segment))).toThrow(FileFormatError);
  });
  it("WebP VP8X 正确处理 24 位尺寸加一", () => {
    const bytes = webp("VP8X");
    bytes.writeUIntLE(0xffffff, 24, 3); bytes.writeUIntLE(0, 27, 3);
    expect(readImageDimensions(bytes)).toEqual({ width: 0x1000000, height: 1 });
  });
  it.each([[1, 1], [320, 240], [16384, 16384]])("WebP VP8L 读取跨字节尺寸 %i × %i", (width, height) => {
    const bytes = webp("VP8L");
    const w = width - 1, h = height - 1;
    bytes[20] = 0x2f; bytes[21] = w & 0xff;
    bytes[22] = ((w >> 8) & 0x3f) | ((h & 3) << 6);
    bytes[23] = (h >> 2) & 0xff; bytes[24] = ((h >> 10) & 0xf) | 0x10;
    expect(readImageDimensions(bytes)).toEqual({ width, height });
  });
  it("WebP VP8 有损帧读取尺寸并忽略缩放标志位", () => {
    const bytes = webp("VP8 ");
    Buffer.from("9d012a", "hex").copy(bytes, 23);
    bytes.writeUInt16LE(320 | 0xc000, 26); bytes.writeUInt16LE(240 | 0x8000, 28);
    expect(readImageDimensions(bytes)).toEqual({ width: 320, height: 240 });
  });
  it.each(["unknown", "lossless-signature", "lossy-signature", "container", "truncated"])("WebP 拒绝 %s", kind => {
    let bytes = webp(kind === "lossless-signature" ? "VP8L" : kind === "unknown" ? "XXXX" : "VP8 ");
    if (kind === "container") bytes.write("NOPE", 8);
    if (kind === "truncated") bytes = bytes.subarray(0, 29);
    expect(() => readImageDimensions(bytes)).toThrow(FileFormatError);
  });
  it("BMP CORE 与 INFO 头部读取尺寸，兼容从上到下的负高度", () => {
    expect(readImageDimensions(bmp(12))).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(bmp())).toEqual({ width: 320, height: 240 });
    expect(readImageDimensions(bmp(108))).toEqual({ width: 320, height: 240 });
  });
  it.each([bmp(16), bmp().subarray(0, 25), Buffer.alloc(0), Buffer.from("GIF89a"), Buffer.from("<svg/>")])("不支持或损坏的格式返回统一错误", bytes => {
    expect(() => readImageDimensions(bytes)).toThrowError(new FileFormatError("图片文件损坏或不支持该格式"));
  });
});
