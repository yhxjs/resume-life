import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const limitMock = vi.hoisted(() => ({
  assertEncryptedBackupBytes: vi.fn<(value: number) => void>(),
}));

vi.mock("@/lib/backup-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backup-limits")>();
  return {
    ...actual,
    assertEncryptedBackupBytes: limitMock.assertEncryptedBackupBytes,
  };
});

import { createEncryptedBackupStream } from "@/lib/backup-container";
import { BackupLimitError, MAX_ENCRYPTED_BACKUP_BYTES } from "@/lib/backup-limits";

const PASSWORD = "correct horse battery staple";

function finitePlaintext(
  value: Buffer,
  onReturn: () => void = () => undefined,
): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        async next() {
          if (emitted) return { done: true as const, value: undefined };
          emitted = true;
          return { done: false as const, value };
        },
        async return() {
          onReturn();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

beforeEach(() => {
  limitMock.assertEncryptedBackupBytes.mockReset();
});

describe("加密导出容器上限", () => {
  it("完整消费时最后累计值等于实际容器长度", async () => {
    const observedTotals: number[] = [];
    limitMock.assertEncryptedBackupBytes.mockImplementation((value) => {
      observedTotals.push(value);
    });

    const chunks: Buffer[] = [];
    for await (const chunk of createEncryptedBackupStream(
      PASSWORD,
      finitePlaintext(Buffer.from("complete encrypted output boundary", "utf8")),
    )) {
      chunks.push(Buffer.from(chunk));
    }
    const expectedTotals: number[] = [];
    let total = 0;
    for (const chunk of chunks) {
      total += chunk.byteLength;
      expectedTotals.push(total);
    }
    const encrypted = Buffer.concat(chunks);

    expect(observedTotals.length).toBeGreaterThanOrEqual(3);
    expect(observedTotals).toEqual(expectedTotals);
    expect(observedTotals.at(-1)).toBe(encrypted.byteLength);
  });

  it("prefix 首次检查超限时不输出 prefix 并关闭明文源", async () => {
    const observedTotals: number[] = [];
    limitMock.assertEncryptedBackupBytes.mockImplementation((value) => {
      observedTotals.push(value);
      throw new BackupLimitError(
        "加密容器字节数",
        MAX_ENCRYPTED_BACKUP_BYTES + 1,
        MAX_ENCRYPTED_BACKUP_BYTES,
      );
    });
    let returnCalls = 0;
    const iterator = createEncryptedBackupStream(
      PASSWORD,
      finitePlaintext(Buffer.from("unread prefix plaintext", "utf8"), () => { returnCalls += 1; }),
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toBeInstanceOf(BackupLimitError);
    expect(observedTotals).toHaveLength(1);
    expect(observedTotals[0]).toBeGreaterThan(0);
    expect(returnCalls).toBe(1);
  });

  it("ciphertext 检查点超限时不输出该块并关闭明文源", async () => {
    const observedTotals: number[] = [];
    limitMock.assertEncryptedBackupBytes.mockImplementation((value) => {
      observedTotals.push(value);
      if (observedTotals.length === 2) {
        throw new BackupLimitError(
          "加密容器字节数",
          MAX_ENCRYPTED_BACKUP_BYTES + 1,
          MAX_ENCRYPTED_BACKUP_BYTES,
        );
      }
    });
    let returnCalls = 0;
    const iterator = createEncryptedBackupStream(
      PASSWORD,
      finitePlaintext(Buffer.from("ciphertext limit checkpoint", "utf8"), () => { returnCalls += 1; }),
    )[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.next()).rejects.toBeInstanceOf(BackupLimitError);
    expect(observedTotals).toHaveLength(2);
    expect(returnCalls).toBe(1);
  });

  it("auth tag 检查点超限时不输出 tag", async () => {
    const observedTotals: number[] = [];
    limitMock.assertEncryptedBackupBytes.mockImplementation((value) => {
      observedTotals.push(value);
      if (observedTotals.length === 3) {
        throw new BackupLimitError(
          "加密容器字节数",
          MAX_ENCRYPTED_BACKUP_BYTES + 1,
          MAX_ENCRYPTED_BACKUP_BYTES,
        );
      }
    });
    const iterator = createEncryptedBackupStream(
      PASSWORD,
      finitePlaintext(Buffer.from("tag limit checkpoint", "utf8")),
    )[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.next()).rejects.toBeInstanceOf(BackupLimitError);
    expect(observedTotals).toHaveLength(3);
  });

  it("累计输出超限时在 yield 前拒绝并关闭明文源", async () => {
    const observedTotals: number[] = [];
    limitMock.assertEncryptedBackupBytes.mockImplementation((value) => {
      observedTotals.push(value);
      if (observedTotals.length === 2) {
        throw new BackupLimitError(
          "加密容器字节数",
          MAX_ENCRYPTED_BACKUP_BYTES + 1,
          MAX_ENCRYPTED_BACKUP_BYTES,
        );
      }
    });
    let returnCalls = 0;
    const plaintext: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false as const, value: Buffer.from("one encrypted output block") };
          },
          async return() {
            returnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const iterator = createEncryptedBackupStream(PASSWORD, plaintext)[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.next()).rejects.toBeInstanceOf(BackupLimitError);
    expect(observedTotals).toHaveLength(2);
    expect(observedTotals[1]!).toBeGreaterThan(observedTotals[0]!);
    expect(returnCalls).toBe(1);
  });
});
