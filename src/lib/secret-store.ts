import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";
const TEST_KEY = "resume-life-test-settings-key";

export class SettingsSecretError extends Error {}

function encryptionKey(): Buffer {
  const configured = process.env.RESUME_LIFE_SETTINGS_KEY?.trim();
  const raw = configured || (process.env.NODE_ENV === "test" ? TEST_KEY : "");
  if (!raw) {
    throw new SettingsSecretError("未配置 RESUME_LIFE_SETTINGS_KEY；请在启动环境中设置并妥善保管随机加密密钥，重启应用后再保存 AI 凭证");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(value: string): string {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(value: string): string {
  if (!value) return value;
  if (!isEncryptedSecret(value)) throw new SettingsSecretError("设置中的凭证必须使用加密格式");
  const encoded = value.slice(PREFIX.length).split(".");
  if (encoded.length !== 3) throw new SettingsSecretError("设置中的加密凭证格式无效");
  try {
    const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded;
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivEncoded!, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagEncoded!, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof SettingsSecretError) throw error;
    throw new SettingsSecretError("设置中的加密凭证无法解密", { cause: error });
  }
}
