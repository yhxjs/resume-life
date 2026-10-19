import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_MEDIA_TYPE,
  BackupAuthenticationError,
  BackupContainerFormatError,
  assertBackupPassword,
  createEncryptedBackupStream,
  decodeBackupPasswordHeader,
  decryptBackupStream,
  encodeBackupPasswordHeader,
} from "../backup-container";

const MAGIC = Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0x00, 0x01]);
const AUTHENTICATION_MESSAGE = "密码错误或备份已损坏";
const FIXTURE_PASSWORD = "correct horse battery";
const FIXTURE_PLAINTEXT_CHUNKS = [
  Buffer.from("first plaintext chunk\n"),
  Buffer.from("second plaintext chunk with enough bytes to stream\n"),
  Buffer.from("third plaintext chunk"),
];
const FIXTURE_PLAINTEXT = Buffer.concat(FIXTURE_PLAINTEXT_CHUNKS);

type PublicHeader = {
  format: string;
  version: number;
  createdAt: string;
  kdf: { name: string; iterations: number; salt: string };
  cipher: { name: string; iv: string; tagBytes: number };
};

async function* chunksOf<T extends Uint8Array>(chunks: readonly T[]): AsyncIterable<T> {
  for (const chunk of chunks) yield chunk;
}

async function* splitAtBoundaries(buffer: Buffer, sizes: readonly number[]): AsyncIterable<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const size = sizes[index % sizes.length];
    yield buffer.subarray(offset, Math.min(offset + size!, buffer.length));
    offset += size!;
    index += 1;
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseContainer(container: Buffer): {
  header: PublicHeader;
  headerBytes: Buffer;
  prefixLength: number;
} {
  expect(container.subarray(0, MAGIC.length)).toEqual(MAGIC);
  const headerLength = container.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const headerBytes = container.subarray(headerStart, headerStart + headerLength);
  return {
    header: JSON.parse(headerBytes.toString("utf8")) as PublicHeader,
    headerBytes,
    prefixLength: headerStart + headerLength,
  };
}

function validHeader(overrides: Partial<PublicHeader> = {}): PublicHeader {
  const base: PublicHeader = {
    format: "resume-life",
    version: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    kdf: {
      name: "PBKDF2-HMAC-SHA256",
      iterations: 600_000,
      salt: Buffer.alloc(16, 1).toString("base64url"),
    },
    cipher: {
      name: "AES-256-GCM",
      iv: Buffer.alloc(12, 2).toString("base64url"),
      tagBytes: 16,
    },
  };
  return {
    ...base,
    ...overrides,
    kdf: { ...base.kdf, ...overrides.kdf },
    cipher: { ...base.cipher, ...overrides.cipher },
  };
}

function rawContainer(header: PublicHeader, body = Buffer.alloc(16)): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  return Buffer.concat([MAGIC, length, headerBytes, body]);
}

function independentlyEncrypt(
  password: string,
  plaintext: Buffer,
  rawHeader?: string,
): Buffer {
  const headerText = rawHeader ?? JSON.stringify({
    format: "resume-life",
    version: 1,
    createdAt: "2026-09-17T00:00:00.000Z",
    kdf: {
      name: "PBKDF2-HMAC-SHA256",
      iterations: 600000,
      salt: randomBytes(16).toString("base64url"),
    },
    cipher: {
      name: "AES-256-GCM",
      iv: randomBytes(12).toString("base64url"),
      tagBytes: 16,
    },
  });
  const header = JSON.parse(headerText) as PublicHeader;
  const headerBytes = Buffer.from(headerText, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.length);
  const prefix = Buffer.concat([MAGIC, length, headerBytes]);
  const key = pbkdf2Sync(
    password,
    Buffer.from(header.kdf.salt, "base64url"),
    600000,
    32,
    "sha256",
  );
  const cipher = (() => {
    try {
      return createCipheriv("aes-256-gcm", key, Buffer.from(header.cipher.iv, "base64url"));
    } finally {
      key.fill(0);
    }
  })();
  cipher.setAAD(prefix);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([prefix, ciphertext, cipher.getAuthTag()]);
}

function independentlyDecrypt(password: string, container: Buffer): Buffer {
  const { header, prefixLength } = parseContainer(container);
  const key = pbkdf2Sync(
    password,
    Buffer.from(header.kdf.salt, "base64url"),
    600000,
    32,
    "sha256",
  );
  const decipher = (() => {
    try {
      return createDecipheriv("aes-256-gcm", key, Buffer.from(header.cipher.iv, "base64url"));
    } finally {
      key.fill(0);
    }
  })();
  decipher.setAAD(container.subarray(0, prefixLength));
  decipher.setAuthTag(container.subarray(container.length - 16));
  return Buffer.concat([
    decipher.update(container.subarray(prefixLength, container.length - 16)),
    decipher.final(),
  ]);
}

function flipCiphertextBit(container: Buffer): Buffer {
  const copy = Buffer.from(container);
  const { prefixLength } = parseContainer(copy);
  copy[prefixLength]! ^= 0x01;
  return copy;
}

function flipHeaderFieldBit(container: Buffer, field: "salt" | "iv"): Buffer {
  const copy = Buffer.from(container);
  const { header, headerBytes } = parseContainer(copy);
  const value = field === "salt" ? header.kdf.salt : header.cipher.iv;
  const marker = `"${field}":"${value}"`;
  const valueOffset = headerBytes.toString("utf8").indexOf(marker) + field.length + 4;

  for (let index = 0; index < value.length - 1; index += 1) {
    for (let bit = 0; bit < 7; bit += 1) {
      const candidate = value.charCodeAt(index) ^ (1 << bit);
      if (/^[A-Za-z0-9_-]$/.test(String.fromCharCode(candidate))) {
        copy[MAGIC.length + 4 + valueOffset + index] = candidate;
        return copy;
      }
    }
  }
  throw new Error(`无法翻转 ${field} 的合法 base64url 位`);
}

async function expectAuthenticationFailure(source: AsyncIterable<Buffer>): Promise<void> {
  let thrown: unknown;
  try {
    await collect(source);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(BackupAuthenticationError);
  expect((thrown as Error).message).toBe(AUTHENTICATION_MESSAGE);
}

let encryptedFixture: Buffer;

beforeAll(async () => {
  encryptedFixture = await collect(
    createEncryptedBackupStream(
      FIXTURE_PASSWORD,
      chunksOf(FIXTURE_PLAINTEXT_CHUNKS),
      new Date("2026-09-17T00:00:00.000Z"),
    ),
  );
});

describe("备份密码", () => {
  it("按 Unicode code point 执行 12..256 的长度边界", () => {
    expect(() => assertBackupPassword("a".repeat(11))).toThrow();
    expect(assertBackupPassword("a".repeat(12))).toBe("a".repeat(12));
    expect(assertBackupPassword("a".repeat(256))).toBe("a".repeat(256));
    expect(() => assertBackupPassword("a".repeat(257))).toThrow();

    const passwordWithEmoji = `${"a".repeat(11)}🔐`;
    expect([...passwordWithEmoji]).toHaveLength(12);
    expect(assertBackupPassword(passwordWithEmoji)).toBe(passwordWithEmoji);
  });

  it.each(["\uD800", "\uDC00", `valid-password\uD800`])("拒绝未配对 surrogate %#", (value) => {
    expect(() => assertBackupPassword(value)).toThrow();
  });

  it("拒绝非字符串", () => {
    expect(() => assertBackupPassword(null)).toThrow();
    expect(() => assertBackupPassword(123)).toThrow();
  });

  it("以 canonical base64url 往返 Unicode 密码", () => {
    const password = "密碼🔐résumé安全口令";
    const encoded = encodeBackupPasswordHeader(password);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(password);
    expect(decodeBackupPasswordHeader(encoded)).toBe(password);
  });

  it("拒绝缺失、非法、非 canonical 及解码后过短的 header", () => {
    expect(() => decodeBackupPasswordHeader(null)).toThrow();
    expect(() => decodeBackupPasswordHeader("abc+")).toThrow();
    expect(() => decodeBackupPasswordHeader("YWJj=")).toThrow();
    expect(() => decodeBackupPasswordHeader("A")).toThrow();
    expect(() => decodeBackupPasswordHeader(Buffer.from("too-short").toString("base64url"))).toThrow();
  });

  it("在正则和 base64 解码前拒绝超过 1366 字符的 header", () => {
    const from = vi.spyOn(Buffer, "from");
    try {
      expect(() => decodeBackupPasswordHeader("a".repeat(1367)))
        .toThrow(BackupContainerFormatError);
      expect(from).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
    }
  });

  it("拒绝 canonical base64url 包装的非法 UTF-8", () => {
    const invalidUtf8 = Buffer.from([0xff]).toString("base64url");
    expect(() => decodeBackupPasswordHeader(invalidUtf8)).toThrow(BackupContainerFormatError);
  });
});

describe("加密容器", () => {
  it("公开稳定的媒体类型与扩展名", () => {
    expect(BACKUP_MEDIA_TYPE).toBe("application/vnd.resume-life.backup");
    expect(BACKUP_FILE_EXTENSION).toBe(".rlbackup");
  });

  it("使用随机 salt/IV，并写入可识别的 magic、公开头和 createdAt", async () => {
    const now = new Date("2026-09-17T08:09:10.123Z");
    const plaintext = Buffer.from("same plaintext");
    const first = await collect(createEncryptedBackupStream(FIXTURE_PASSWORD, chunksOf([plaintext]), now));
    const second = await collect(createEncryptedBackupStream(FIXTURE_PASSWORD, chunksOf([plaintext]), now));
    const firstParsed = parseContainer(first);
    const secondParsed = parseContainer(second);

    expect(first.equals(second)).toBe(false);
    expect(firstParsed.header).toEqual({
      format: "resume-life",
      version: 1,
      createdAt: now.toISOString(),
      kdf: {
        name: "PBKDF2-HMAC-SHA256",
        iterations: 600_000,
        salt: expect.any(String),
      },
      cipher: {
        name: "AES-256-GCM",
        iv: expect.any(String),
        tagBytes: 16,
      },
    });
    expect(Buffer.from(firstParsed.header.kdf.salt, "base64url")).toHaveLength(16);
    expect(Buffer.from(firstParsed.header.cipher.iv, "base64url")).toHaveLength(12);
    expect(firstParsed.header.kdf.salt).not.toBe(secondParsed.header.kdf.salt);
    expect(firstParsed.header.cipher.iv).not.toBe(secondParsed.header.cipher.iv);
  });

  it("多个明文 chunk 经任意密文边界流式往返", async () => {
    const decrypted = await collect(
      decryptBackupStream(FIXTURE_PASSWORD, splitAtBoundaries(encryptedFixture, [1, 2, 7, 3, 11, 5, 13])),
    );

    expect(decrypted).toEqual(FIXTURE_PLAINTEXT);
  });

  it("无需等待完整密文即可产出 decipher.update 块", async () => {
    const { prefixLength } = parseContainer(encryptedFixture);
    const split = prefixLength + 32;
    let remainderAllowed = false;
    let sourceRequests = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            sourceRequests += 1;
            if (index === 0) {
              index += 1;
              return { done: false as const, value: encryptedFixture.subarray(0, split) };
            }
            if (index === 1) {
              if (!remainderAllowed) throw new Error("解密器在产出前索取了剩余密文");
              index += 1;
              return { done: false as const, value: encryptedFixture.subarray(split) };
            }
            return { done: true as const, value: undefined };
          },
        };
      },
    };

    const iterator = decryptBackupStream(FIXTURE_PASSWORD, source)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.length).toBeGreaterThan(0);
    expect(sourceRequests).toBe(1);

    remainderAllowed = true;
    const output = [Buffer.from(first.value)];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      output.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(output)).toEqual(FIXTURE_PLAINTEXT);
  });
});

describe("Node crypto 交叉兼容", () => {
  it("独立 pbkdf2Sync/createDecipheriv 可解密流式导出", () => {
    expect(independentlyDecrypt(FIXTURE_PASSWORD, encryptedFixture)).toEqual(FIXTURE_PLAINTEXT);
  });

  it("可解密由独立 pbkdf2Sync/createCipheriv 构造的 canonical 容器", async () => {
    const plaintext = Buffer.from("independently encrypted plaintext");
    const container = independentlyEncrypt(FIXTURE_PASSWORD, plaintext);

    expect(await collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([container])))).toEqual(plaintext);
  });

  it("只篡改等长 canonical createdAt 数字也因 AAD 认证失败", async () => {
    const container = independentlyEncrypt(FIXTURE_PASSWORD, Buffer.from("AAD protected"));
    const tampered = Buffer.from(container);
    const { header, headerBytes } = parseContainer(container);
    const dateOffset = headerBytes.indexOf(header.createdAt);
    expect(dateOffset).toBeGreaterThanOrEqual(0);
    tampered[MAGIC.length + 4 + dateOffset + 9] = "8".charCodeAt(0);

    const tamperedCreatedAt = parseContainer(tampered).header.createdAt;
    expect(tamperedCreatedAt).toBe("2026-09-18T00:00:00.000Z");
    expect(new Date(tamperedCreatedAt).toISOString()).toBe(tamperedCreatedAt);
    await expectAuthenticationFailure(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([tampered])));
  });
});

describe("源 AsyncIterator 关闭语义", () => {
  it("加密源 next 失败时调用 return，且 return 失败不覆盖 next 错误", async () => {
    const nextError = new Error("plaintext next failed");
    const returnError = new Error("plaintext return failed");
    let returnCalls = 0;
    const plaintext: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw nextError;
          },
          async return() {
            returnCalls += 1;
            throw returnError;
          },
        };
      },
    };
    const iterator = createEncryptedBackupStream(FIXTURE_PASSWORD, plaintext)[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.next()).rejects.toBe(nextError);
    expect(returnCalls).toBe(1);
  });

  it("消费者在首个加密块后停止时关闭尚未读取的明文源", async () => {
    let returnCalls = 0;
    const plaintext: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: Buffer.from("unused plaintext") };
          },
          async return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterator = createEncryptedBackupStream(FIXTURE_PASSWORD, plaintext)[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    expect(returnCalls).toBe(1);
  });

  it("解密格式错误时关闭密文源，且 return 失败不覆盖格式错误", async () => {
    const returnError = new Error("encrypted return failed");
    let returnCalls = 0;
    const encrypted: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next() {
            if (sent) return { done: true as const, value: undefined };
            sent = true;
            return { done: false as const, value: Buffer.from("invalid magic") };
          },
          async return() {
            returnCalls += 1;
            throw returnError;
          },
        };
      },
    };

    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, encrypted)))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
    expect(returnCalls).toBe(1);
  });

  it("消费者在首个解密块后停止时关闭密文源", async () => {
    const container = independentlyEncrypt(FIXTURE_PASSWORD, Buffer.alloc(64, 7));
    let returnCalls = 0;
    const encrypted: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          async next() {
            if (sent) return { done: true as const, value: undefined };
            sent = true;
            return { done: false as const, value: container };
          },
          async return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterator = decryptBackupStream(FIXTURE_PASSWORD, encrypted)[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await iterator.return?.();
    expect(returnCalls).toBe(1);
  });
});

describe("格式拒绝", () => {
  it("拒绝缺少 magic 的 JSON 明文", async () => {
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([Buffer.from('{"format":"resume-life"}')]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  it("拒绝非 canonical ISO 的 createdAt", async () => {
    const container = rawContainer(validHeader({ createdAt: "September 17, 2026" }));

    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([container]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  const canonicalHeader = JSON.stringify(validHeader());
  it.each([
    ["顶层额外字段", canonicalHeader.replace('"version":1', '"extra":true,"version":1')],
    ["KDF 额外字段", canonicalHeader.replace('"iterations":600000', '"extra":true,"iterations":600000')],
    ["cipher 额外字段", canonicalHeader.replace('"tagBytes":16', '"extra":true,"tagBytes":16')],
    ["顶层重复字段", canonicalHeader.replace('"version":1', '"version":1,"version":1')],
    ["KDF 重复字段", canonicalHeader.replace('"iterations":600000', '"iterations":600000,"iterations":600000')],
    ["cipher 重复字段", canonicalHeader.replace('"tagBytes":16', '"tagBytes":16,"tagBytes":16')],
  ])("拒绝正确认证但包含%s的公开头", async (_name, headerText) => {
    const container = independentlyEncrypt(FIXTURE_PASSWORD, Buffer.from("authenticated"), headerText);
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([container]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  it.each([
    ["未知版本", validHeader({ version: 3 })],
    ["未知 KDF", validHeader({ kdf: { ...validHeader().kdf, name: "scrypt" } })],
    ["未知 cipher", validHeader({ cipher: { ...validHeader().cipher, name: "AES-256-CBC" } })],
  ])("拒绝%s", async (_name, header) => {
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([rawContainer(header)]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  it.each([
    ["iterations", validHeader({ kdf: { ...validHeader().kdf, iterations: 1 } })],
    ["salt 长度", validHeader({ kdf: { ...validHeader().kdf, salt: Buffer.alloc(15).toString("base64url") } })],
    ["IV 长度", validHeader({ cipher: { ...validHeader().cipher, iv: Buffer.alloc(11).toString("base64url") } })],
    ["tagBytes", validHeader({ cipher: { ...validHeader().cipher, tagBytes: 12 } })],
  ])("拒绝非法%s参数", async (_name, header) => {
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([rawContainer(header)]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  it("拒绝超长公开头", async () => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(4097);
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([Buffer.concat([MAGIC, length])]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  it("拒绝截断公开头", async () => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(100);
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([Buffer.concat([MAGIC, length, Buffer.from("{}")])]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });

  it("拒绝缺失 auth tag", async () => {
    await expect(collect(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([rawContainer(validHeader(), Buffer.alloc(15))]))))
      .rejects.toBeInstanceOf(BackupContainerFormatError);
  });
});

describe("认证失败", () => {
  it("错误密码抛出统一认证错误", async () => {
    await expectAuthenticationFailure(decryptBackupStream("wrong password!", chunksOf([encryptedFixture])));
  });

  it("密文位翻转抛出统一认证错误", async () => {
    await expectAuthenticationFailure(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([flipCiphertextBit(encryptedFixture)])));
  });

  it.each(["salt", "iv"] as const)("公开头中的 %s 位翻转抛出统一认证错误", async (field) => {
    const tampered = flipHeaderFieldBit(encryptedFixture, field);
    expect(() => parseContainer(tampered)).not.toThrow();
    await expectAuthenticationFailure(decryptBackupStream(FIXTURE_PASSWORD, chunksOf([tampered])));
  });
});
