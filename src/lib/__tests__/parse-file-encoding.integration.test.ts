import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";

const source = "  仅参与参数校验，未上线。\r\nArray<T>\tuser?.name ?? fallback\nalpha+audit@example.com & C:\\source\\项目\n𠮷 😀 e\u0301  ";
const encodings = ["utf-16le", "utf-16be"] as const;
function encode(text: string, encoding: typeof encodings[number]): Buffer {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  return encoding === "utf-16be" ? bytes.swap16() : bytes;
}

describe("text file encoding fidelity", () => {
  it.each(encodings.flatMap(encoding => ["txt", "md", "markdown"].map(ext => ({ encoding, ext }))))(
    "decodes a $encoding BOM in .$ext without changing literals or whitespace", async ({ encoding, ext }) => {
      await expect(extractContentFromFile(`source.${ext}`, encode(source, encoding))).resolves.toEqual({ text: source });
    },
  );

  it("retains UTF-8 with and without a BOM and existing GBK compatibility", async () => {
    for (const ext of ["txt", "md", "markdown"]) {
      for (const prefix of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf])]) {
        await expect(extractContentFromFile(`source.${ext}`, Buffer.concat([prefix, Buffer.from(source)]))).resolves.toEqual({ text: source });
      }
      const gbk = Buffer.concat([Buffer.from([0xbf, 0xcd, 0xb7, 0xfe]), Buffer.from("\r\nArray<T>\tuser?.name ?? fallback")]);
      await expect(extractContentFromFile(`source.${ext}`, gbk)).resolves.toEqual({ text: "客服\r\nArray<T>\tuser?.name ?? fallback" });
    }
  });

  it.each(encodings)("rejects damaged %s instead of falling back to another encoding", async encoding => {
    const valid = encode(source, encoding);
    const unpairedSurrogate = encode("\ud800", encoding);
    for (const bytes of [valid.subarray(0, valid.length - 1), unpairedSurrogate]) {
      await expect(extractContentFromFile("damaged.txt", bytes)).rejects.toThrow(FileFormatError);
      await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
    }
  });

  it("rejects invalid UTF-8 with an explicit BOM rather than interpreting it as GBK", async () => {
    await expect(extractContentFromFile("damaged.md", Buffer.from([0xef, 0xbb, 0xbf, 0xbf, 0xcd]))).rejects.toThrow(FileFormatError);
  });

  it.each([
    { name: "UTF-32LE", bytes: [0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00] },
    { name: "UTF-32BE", bytes: [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x41] },
  ])("rejects an unsupported $name BOM without treating it as UTF-16", async ({ bytes }) => {
    await expect(extractContentFromFile("source.txt", Buffer.from(bytes))).rejects.toThrow(FileFormatError);
  });

  it.each(encodings)("applies the decoded Unicode code point limit to %s", async encoding => {
    const text = "😀".repeat(200_000);
    await expect(extractContentFromFile("limit.txt", encode(text, encoding))).resolves.toEqual({ text });
    await expect(extractContentFromFile("over.md", encode(text + "x", encoding))).rejects.toThrow("200000");
  });
});
