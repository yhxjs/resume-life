import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";
import { generateResumePdf } from "@/lib/pdf-render";

type TextRun = { text: string; x: number; y: number; bold?: boolean };

/** Real PDF text operators with a font change at each odd run. */
function makePdf(runs: TextRun[]): Buffer {
  const commands = runs.map(({text, x, y, bold}) =>
    `BT /${bold ? "F2" : "F1"} 12 Tf ${x} ${y} Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

function styledLine(parts: readonly string[], y = 730): TextRun[] {
  let x = 30;
  return parts.map((text, index) => {
    const run = {text, x, y, bold: index % 2 === 1};
    x += text.length * 7.2; // Courier has a 600/1000 em advance at 12 pt.
    return run;
  });
}

describe("selectable PDF text fidelity", () => {
  it.each([
    {name:"generic type", parts:["Array<", "T", ">"]},
    {name:"optional chaining and nullish coalescing", parts:["user", "?.", "name ?? fallback"]},
    {name:"email", parts:["alpha", "+audit", "@example.com"]},
    {name:"URL and query", parts:["https://example.com/", "path", "?q=1&x=2"]},
    {name:"percentage", parts:["50", "%", " confirmed"]},
    {name:"explicit word spaces", parts:["not ", "deployed", "; assisted tests"]},
  ])("retains $name across font changes", async ({parts}) => {
    const result = await extractContentFromFile("styled.pdf", makePdf(styledLine(parts)));
    expect(result).toEqual({text:parts.join("")});
  });

  it("retains visible word separation with separately positioned runs", async () => {
    const result = await extractContentFromFile("words.pdf", makePdf([
      {text:"not", x:30, y:730},
      {text:"deployed", x:58.8, y:730, bold:true},
    ]));
    expect(result).toEqual({text:"not deployed"});
  });

  it("keeps right-aligned dates separated and each following description on its own line", async () => {
    // Deliberately emit the right cell first, as PDF paint order need not be reading order.
    const result = await extractContentFromFile("dates.pdf", makePdf([
      {text:"2022 - 2023",x:420,y:730}, {text:"Project A",x:30,y:730},
      ...styledLine(["Assisted ","tests","; not deployed"],705),
      {text:"2024 - 2025",x:420,y:680}, {text:"Project B",x:30,y:680},
      ...styledLine(["Led ","rollout","; 20% faster"],655),
    ]));
    expect(result).toEqual({text:"Project A 2022 - 2023\nAssisted tests; not deployed\nProject B 2024 - 2025\nLed rollout; 20% faster"});
  });

  it("keeps adjacent Chinese and technical literals through browser PDF generation and re-import", async () => {
    const pdf = await generateResumePdf(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      body {font:16px Arial,'Microsoft YaHei',sans-serif} p {margin:0 0 12px}
      </style><body><p>仅参与<strong>参数</strong>校验，未上线。</p>
      <p>Array&lt;<strong>T</strong>&gt; 与 user<em>?.</em>name ?? fallback</p>
      <p>alpha<strong>+audit</strong>@example.com</p>
      <p>https://example.com/<strong>path</strong>?q=1&amp;x=2</p>
      <p>团队完成 <strong>50%</strong>，个人仅测试。</p></body></html>`);
    const result = await extractContentFromFile("browser.pdf", pdf);
    expect(result).toEqual({text:[
      "仅参与参数校验，未上线。",
      "Array<T> 与 user?.name ?? fallback",
      "alpha+audit@example.com",
      "https://example.com/path?q=1&x=2",
      "团队完成 50%，个人仅测试。",
    ].join("\n")});
  }, 30_000);
});
