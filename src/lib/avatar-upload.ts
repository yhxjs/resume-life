import sharp from "sharp";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export class AvatarInputError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) { super(message); }
}
function imageExtension(bytes: Buffer) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}
/** Shared with Web upload: verify actual image bytes, rotate and bound dimensions. */
export async function normalizeAvatar(bytes: Buffer) {
  if (bytes.length > MAX_AVATAR_BYTES) throw new AvatarInputError("图片过大，头像大小不能超过 5MB", 413);
  const extension = imageExtension(bytes);
  if (!extension) throw new AvatarInputError("不支持的图片格式，仅支持 PNG、JPG、JPEG、WEBP");
  try {
    const normalized = await sharp(bytes).rotate().resize(600, 800, { fit: "inside", withoutEnlargement: true }).toBuffer();
    return { bytes: normalized, extension };
  } catch { throw new AvatarInputError("图片解析失败，请更换图片后重试"); }
}
