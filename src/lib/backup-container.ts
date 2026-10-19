import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
} from "node:crypto";
import { assertEncryptedBackupBytes } from "@/lib/backup-limits";

export const BACKUP_MEDIA_TYPE = "application/vnd.resume-life.backup";
export const BACKUP_FILE_EXTENSION = ".rlbackup";

const MAGIC = Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0x00, 0x01]);
const HEADER_LENGTH_BYTES = 4;
const MAX_HEADER_BYTES = 4096;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PASSWORD_HEADER_CHARACTERS = 1366;
const AUTHENTICATION_MESSAGE = "密码错误或备份已损坏";

type BackupHeader = {
  format: "resume-life";
  version: 1;
  createdAt: string;
  kdf: {
    name: "PBKDF2-HMAC-SHA256";
    iterations: 600000;
    salt: string;
  };
  cipher: {
    name: "AES-256-GCM";
    iv: string;
    tagBytes: 16;
  };
};

type EncryptedSourceState = {
  iterator: AsyncIterator<Uint8Array>;
  current: Buffer;
  done: boolean;
};

export class BackupContainerFormatError extends Error {
  constructor(message = "备份容器格式无效") {
    super(message);
    this.name = "BackupContainerFormatError";
  }
}

export class BackupAuthenticationError extends Error {
  constructor() {
    super(AUTHENTICATION_MESSAGE);
    this.name = "BackupAuthenticationError";
  }
}

export function assertBackupPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("备份密码必须是字符串");
  }

  let codePoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("备份密码包含未配对的 surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("备份密码包含未配对的 surrogate");
    }
    codePoints += 1;
  }

  if (codePoints < 12 || codePoints > 256) {
    throw new RangeError("备份密码长度必须为 12 到 256 个 Unicode code point");
  }
  return value;
}

export function encodeBackupPasswordHeader(password: string): string {
  return Buffer.from(assertBackupPassword(password), "utf8").toString("base64url");
}

export function decodeBackupPasswordHeader(value: string | null): string {
  try {
    if (value === null || value.length > MAX_PASSWORD_HEADER_CHARACTERS ||
        !/^[A-Za-z0-9_-]*$/.test(value)) {
      throw new Error("invalid base64url");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    const password = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return assertBackupPassword(password);
  } catch {
    throw new BackupContainerFormatError("备份密码请求头无效");
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256", (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function createBackupCipher(key: Buffer, iv: Buffer) {
  try {
    return createCipheriv("aes-256-gcm", key, iv);
  } finally {
    key.fill(0);
  }
}

function createBackupDecipher(key: Buffer, iv: Buffer) {
  try {
    return createDecipheriv("aes-256-gcm", key, iv);
  } finally {
    key.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function decodeHeaderBytes(value: unknown, expectedLength: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BackupContainerFormatError();
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== expectedLength || bytes.toString("base64url") !== value) {
    throw new BackupContainerFormatError();
  }
  return bytes;
}

function parseHeader(headerBytes: Buffer): { header: BackupHeader; salt: Buffer; iv: Buffer } {
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
  } catch {
    throw new BackupContainerFormatError();
  }

  if (!isRecord(input) || input.format !== "resume-life" || input.version !== 1 ||
      !isCanonicalIsoDate(input.createdAt) ||
      !isRecord(input.kdf) || input.kdf.name !== "PBKDF2-HMAC-SHA256" ||
      input.kdf.iterations !== PBKDF2_ITERATIONS ||
      !isRecord(input.cipher) || input.cipher.name !== "AES-256-GCM" ||
      input.cipher.tagBytes !== TAG_BYTES) {
    throw new BackupContainerFormatError();
  }

  const salt = decodeHeaderBytes(input.kdf.salt, SALT_BYTES);
  const iv = decodeHeaderBytes(input.cipher.iv, IV_BYTES);
  const header: BackupHeader = {
    format: "resume-life",
    version: 1,
    createdAt: input.createdAt as string,
    kdf: {
      name: "PBKDF2-HMAC-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: salt.toString("base64url"),
    },
    cipher: {
      name: "AES-256-GCM",
      iv: iv.toString("base64url"),
      tagBytes: TAG_BYTES,
    },
  };
  if (!Buffer.from(JSON.stringify(header), "utf8").equals(headerBytes)) {
    throw new BackupContainerFormatError();
  }
  return { header, salt, iv };
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

async function readExactly(state: EncryptedSourceState, length: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;

  while (offset < length) {
    if (state.current.length === 0) {
      const next = await state.iterator.next();
      if (next.done) {
        state.done = true;
        throw new BackupContainerFormatError();
      }
      state.current = asBuffer(next.value);
      if (state.current.length === 0) continue;
    }

    const count = Math.min(length - offset, state.current.length);
    state.current.copy(result, offset, 0, count);
    state.current = state.current.subarray(count);
    offset += count;
  }
  return result;
}

export function createEncryptedBackupStream(
  password: string,
  plaintext: AsyncIterable<Buffer>,
  now = new Date(),
): AsyncIterable<Buffer> {
  const validPassword = assertBackupPassword(password);

  return (async function* encrypt(): AsyncIterable<Buffer> {
    const source = plaintext[Symbol.asyncIterator]();
    let sourceDone = false;
    let failed = false;
    let encryptedBytes = 0;

    function appendEncrypted(chunk: Buffer): Buffer {
      const nextBytes = encryptedBytes + chunk.byteLength;
      assertEncryptedBackupBytes(nextBytes);
      encryptedBytes = nextBytes;
      return chunk;
    }

    try {
      const salt = randomBytes(SALT_BYTES);
      const iv = randomBytes(IV_BYTES);
      const header: BackupHeader = {
        format: "resume-life",
        version: 1,
        createdAt: now.toISOString(),
        kdf: {
          name: "PBKDF2-HMAC-SHA256",
          iterations: PBKDF2_ITERATIONS,
          salt: salt.toString("base64url"),
        },
        cipher: {
          name: "AES-256-GCM",
          iv: iv.toString("base64url"),
          tagBytes: TAG_BYTES,
        },
      };
      const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
      const lengthBytes = Buffer.alloc(HEADER_LENGTH_BYTES);
      lengthBytes.writeUInt32BE(headerBytes.length);
      const prefix = Buffer.concat([MAGIC, lengthBytes, headerBytes]);
      const key = await deriveKey(validPassword, salt);
      const cipher = createBackupCipher(key, iv);
      cipher.setAAD(prefix);

      yield appendEncrypted(prefix);
      for (;;) {
        const next = await source.next();
        if (next.done) {
          sourceDone = true;
          break;
        }
        const encrypted = cipher.update(next.value);
        if (encrypted.length > 0) yield appendEncrypted(encrypted);
      }
      const final = cipher.final();
      if (final.length > 0) yield appendEncrypted(final);
      yield appendEncrypted(cipher.getAuthTag());
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!sourceDone && source.return) {
        try {
          await source.return();
        } catch (error) {
          if (!failed) throw error;
        }
      }
    }
  })();
}

export function decryptBackupStream(
  password: string,
  encrypted: AsyncIterable<Uint8Array>,
): AsyncIterable<Buffer> {
  const validPassword = assertBackupPassword(password);

  return (async function* decrypt(): AsyncIterable<Buffer> {
    const state: EncryptedSourceState = {
      iterator: encrypted[Symbol.asyncIterator](),
      current: Buffer.alloc(0),
      done: false,
    };
    let failed = false;

    try {
      const magic = await readExactly(state, MAGIC.length);
      if (!magic.equals(MAGIC)) throw new BackupContainerFormatError();

      const lengthBytes = await readExactly(state, HEADER_LENGTH_BYTES);
      const headerLength = lengthBytes.readUInt32BE(0);
      if (headerLength > MAX_HEADER_BYTES) throw new BackupContainerFormatError();

      const headerBytes = await readExactly(state, headerLength);
      const { salt, iv } = parseHeader(headerBytes);
      const prefix = Buffer.concat([magic, lengthBytes, headerBytes]);
      const key = await deriveKey(validPassword, salt);
      const decipher = createBackupDecipher(key, iv);
      decipher.setAAD(prefix);
      let tagTail = Buffer.alloc(0);

      function update(data: Buffer): Buffer[] {
        if (data.length === 0) return [];
        const output: Buffer[] = [];
        let offset = 0;

        if (tagTail.length < TAG_BYTES) {
          const count = Math.min(TAG_BYTES - tagTail.length, data.length);
          tagTail = Buffer.concat([tagTail, data.subarray(0, count)]);
          offset = count;
          if (offset === data.length) return output;
        }

        const remaining = data.subarray(offset);
        if (remaining.length >= TAG_BYTES) {
          const fromTail = decipher.update(tagTail);
          if (fromTail.length > 0) output.push(fromTail);
          const fromCurrentLength = remaining.length - TAG_BYTES;
          if (fromCurrentLength > 0) {
            const fromCurrent = decipher.update(remaining.subarray(0, fromCurrentLength));
            if (fromCurrent.length > 0) output.push(fromCurrent);
          }
          tagTail = Buffer.from(remaining.subarray(fromCurrentLength));
        } else {
          const fromTail = decipher.update(tagTail.subarray(0, remaining.length));
          if (fromTail.length > 0) output.push(fromTail);
          tagTail = Buffer.concat([tagTail.subarray(remaining.length), remaining]);
        }
        return output;
      }

      // GCM 在 final 前产出的明文尚未认证；Task 3 必须先写入隔离暂存库，
      // 仅在本迭代器正常完成后提交，认证失败时丢弃暂存库。
      if (state.current.length > 0) {
        const current = state.current;
        state.current = Buffer.alloc(0);
        for (const chunk of update(current)) yield chunk;
      }

      while (!state.done) {
        const next = await state.iterator.next();
        if (next.done) {
          state.done = true;
          break;
        }
        for (const chunk of update(asBuffer(next.value))) yield chunk;
      }

      if (tagTail.length < TAG_BYTES) throw new BackupContainerFormatError();
      try {
        decipher.setAuthTag(tagTail);
        const final = decipher.final();
        if (final.length > 0) yield final;
      } catch {
        throw new BackupAuthenticationError();
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!state.done && state.iterator.return) {
        try {
          await state.iterator.return();
        } catch (error) {
          if (!failed) throw error;
        }
      }
    }
  })();
}
