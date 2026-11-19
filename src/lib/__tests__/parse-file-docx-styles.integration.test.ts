import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractContentFromFile } from "@/lib/parse-file";
import fixtures from "./fixtures/docx-style-visibility.json";

const { safeChat } = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", () => ({ safeChat, LLM_FEATURES: { resumeImportParse: "resumeImportParse" } }));

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relation = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
const p = (text: string, style = "", properties = "") => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}</w:pPr><w:r><w:rPr>${properties}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const style = (id: string, properties = "", base = "", type = "paragraph") => `<w:style w:type="${type}" w:styleId="${id}">${base ? `<w:basedOn w:val="${base}"/>` : ""}<w:rPr>${properties}</w:rPr></w:style>`;

async function archive(parts: Record<string, string | undefined>) {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(parts)) if (xml !== undefined) zip.file(name, Buffer.from(xml));
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function parts(body: string, styles: string, footnote = "") {
  return {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="${pkg}"><Relationship Id="main" Type="${relation}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="${pkg}"><Relationship Id="styles" Type="${relation}/styles" Target="styles.xml"/></Relationships>`,
    "word/document.xml": `<w:document xmlns:w="${word}"><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": `<w:styles xmlns:w="${word}">${styles}</w:styles>`,
    ...(footnote ? { "word/footnotes.xml": `<w:footnotes xmlns:w="${word}"><w:footnote w:id="1">${footnote}</w:footnote></w:footnotes>` } : {}),
  };
}

function upload(file: Buffer, extractOnly: boolean) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file)], "styles.docx"));
  if (extractOnly) form.append("extractOnly", "true");
  return new Request("http://localhost/api/import/parse", { method: "POST", headers: { cookie: `resume_life_session=${token}` }, body: form });
}

let directory: string;
let token: string;
let database: import("node:sqlite").DatabaseSync;

describe("DOCX hidden style content", () => {
  beforeEach(async () => {
    vi.resetModules();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-docx-styles-"));
    vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
    database = (await import("@/lib/db")).getDb();
    token = (await import("@/lib/auth")).createSession().token;
    safeChat.mockReset();
    safeChat.mockRejectedValue(new Error("Unexpected model call"));
  });

  afterEach(() => {
    database?.close();
    vi.unstubAllEnvs();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-docx-styles-")) {
      throw new Error("Unsafe test cleanup path");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  // Expected membership comes from independent Word pages, including true/false toggle pairs.
  it.each(fixtures.cases)("matches Word-visible source text: $name", async fixture => {
    const file = await archive(fixture.parts);
    const { text } = await extractContentFromFile("word-observation.docx", file);
    for (const value of fixture.visible) expect.soft(text).toContain(value);
    for (const value of fixture.hidden) expect.soft(text).not.toContain(value);
    const response = await (await import("@/app/api/import/parse/route")).POST(upload(file, true));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ extractedText: text, sourceReceipt: {
      version: 1, id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(Number),
    } });
    expect(safeChat).not.toHaveBeenCalled();
  });

  it.each(["paragraph", "character", "document-default", "normal-default"])("rejects an all-hidden %s document in both import modes", async mode => {
    const hidden = "<w:vanish/>";
    const styles = mode === "document-default" ? `<w:docDefaults><w:rPrDefault><w:rPr>${hidden}</w:rPr></w:rPrDefault></w:docDefaults>`
      : mode === "normal-default" ? `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr>${hidden}</w:rPr></w:style>`
      : style("Hidden", hidden, "", mode);
    const body = p("旧成果：主导上线，收益 50%", mode === "paragraph" ? "Hidden" : "", mode === "character" ? '<w:rStyle w:val="Hidden"/>' : "");
    const file = await archive(parts(body, styles));
    await expect(extractContentFromFile("hidden.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "" });
    for (const extractOnly of [true, false]) {
      const response = await (await import("@/app/api/import/parse/route")).POST(upload(file, extractOnly));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "没有提取到文本内容" });
    }
    expect(safeChat).not.toHaveBeenCalled();
  });

  it("preserves direct paragraph-mark formatting as visible body text", async () => {
    const body = '<w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr><w:r><w:t>Visible paragraph body</w:t></w:r></w:p>';
    await expect(extractContentFromFile("mark.docx", await archive(parts(body, "")))).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Visible paragraph body\n\n" });
  });

  it("passes only visible source text to the model boundary and retains it on a model error", async () => {
    const body = '<w:p><w:r><w:rPr><w:rStyle w:val="Secret"/></w:rPr><w:t>主导上线，收益50%</w:t></w:r><w:r><w:t>仅测试，未上线。</w:t></w:r></w:p>';
    const file = await archive(parts(body, style("Secret", "<w:vanish/>", "", "character")));
    const response = await (await import("@/app/api/import/parse/route")).POST(upload(file, false));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ extractedText: "仅测试，未上线。\n\n" });
    expect(safeChat).toHaveBeenCalledOnce();
    const messages = safeChat.mock.calls[0]?.[3] as { role: string; parts: { trust: string; tag?: string; text: string }[] }[];
    expect(messages.flatMap(message => message.parts).some(part => part.trust === "untrusted" && part.tag === "resume_source"
      && part.text.includes("仅测试，未上线。") && !part.text.includes("主导上线，收益50%"))).toBe(true);
  });

  it("uses the related styles part and Strict Word namespaces", async () => {
    const fileParts: Record<string, string | undefined> = parts(p("hidden", "Secret") + p("visible", "Secret", '<w:vanish w:val="off"/>'), style("Secret", "<w:vanish/>"));
    fileParts["word/style-data/custom.xml"] = fileParts["word/styles.xml"];
    delete fileParts["word/styles.xml"];
    fileParts["word/_rels/document.xml.rels"] = fileParts["word/_rels/document.xml.rels"]!.replace('Target="styles.xml"', 'Target="style-data/custom.xml"');
    for (const [name, value] of Object.entries(fileParts)) fileParts[name] = value?.replaceAll(word, "http://purl.oclc.org/ooxml/wordprocessingml/main");
    const { text } = await extractContentFromFile("strict.docx", await archive(fileParts));
    expect(text.trim()).toBe("visible");
  });

  it("keeps generated table labels when visible text overrides hidden document defaults", async () => {
    const body = `<w:tbl><w:tr><w:tc>${p("Visible qualification", "", '<w:vanish w:val="0"/>')}</w:tc></w:tr></w:tbl>`;
    const defaults = "<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>";
    const { text } = await extractContentFromFile("table.docx", await archive(parts(body, defaults)));
    expect(text).toContain("[第 1 行，第 1 列]\n\nVisible qualification\n\n[表格结束]");
  });

  it.each(["cycle", "malformed"])("rejects an active %s style but ignores it in an unreferenced footnote", async mode => {
    const styles = mode === "cycle" ? style("A", "", "B") + style("B", "", "A") + style("Unused", "<w:vanish/>")
      : '<w:style w:type="paragraph" w:styleId="A"><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr></w:style>';
    await expect(extractContentFromFile("invalid.docx", await archive(parts(p("uncertain", "A"), styles)))).rejects.toThrow();
    await expect(extractContentFromFile("unused.docx", await archive(parts(p("visible"), styles, p("unused", "A"))))).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "visible\n\n" });
    const { text } = await extractContentFromFile("override.docx", await archive(parts(p("visible", "A", '<w:vanish w:val="false"/>'), styles)));
    expect(text.trim()).toBe("visible");
  });

  it("resolves a long shared style chain without recursive overflow", async () => {
    const chain = style("S0", "<w:vanish/>") + Array.from({ length: 1500 }, (_, index) => style(`S${index + 1}`, "", `S${index}`)).join("");
    const body = p("Visible control") + Array.from({ length: 300 }, () => p("Hidden old achievement", "S1500")).join("");
    const { text } = await extractContentFromFile("chain.docx", await archive(parts(body, chain)));
    expect(text.trim()).toBe("Visible control");
  });
});
