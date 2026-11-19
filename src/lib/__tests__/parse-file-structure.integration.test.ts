import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";
import { generateResumePdf, renderResumeToHtml } from "@/lib/pdf-render";
import type { ResumeWithModules } from "@/lib/resumes";

type TextRun = { text: string; x: number; y: number; tagged?: boolean };
type Structure = { role: string; children: (Structure | number)[] };

/** Genuine marked PDF content and a structure tree whose order is independent of painting. */
function makeTaggedPdf(runs: TextRun[], structure: Structure | null): Buffer {
  const objects: string[] = [];
  const append = (value = "") => { objects.push(value); return objects.length; };
  const catalog = append();
  const pages = append();
  const page = append();
  const font = append("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const root = append();
  const parents: number[] = [];
  function element(node: Structure, parent: number): number {
    const id = append();
    const children = node.children.map(child => {
      if (typeof child !== "number") return `${element(child, id)} 0 R`;
      parents[child] = id;
      return String(child);
    });
    objects[id - 1] = `<< /Type /StructElem /S /${node.role} /P ${parent} 0 R /Pg ${page} 0 R /K [${children.join(" ")}] >>`;
    return id;
  }
  const tree = structure ? element(structure, root) : null;
  const parentTree = append(`<< /Nums [0 [${runs.map((_,index) => parents[index] ? `${parents[index]} 0 R` : "null").join(" ")}]] >>`);
  const content = runs.map((run, index) => {
    const text = `BT /F1 12 Tf ${run.x} ${run.y} Td (${run.text.replace(/[\\()]/g, "\\$&")}) Tj ET`;
    return run.tagged === false ? text : `/P << /MCID ${index} >> BDC ${text} EMC`;
  }).join("\n");
  const stream = append(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R${tree ? ` /MarkInfo << /Marked true >> /StructTreeRoot ${root} 0 R` : ""} >>`;
  objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  objects[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 600 800] /StructParents 0 /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`;
  objects[root - 1] = `<< /Type /StructTreeRoot /K ${tree ? `${tree} 0 R` : "[]"} /ParentTree ${parentTree} 0 R >>`;
  let result = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(offset => `${String(offset).padStart(10,"0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

const p = (...children: (Structure | number)[]): Structure => ({role:"P",children});
const section = (...children: Structure[]): Structure => ({role:"Sect",children});
const left = ["PROJECT A", "Role: assisted tests", "Result: not deployed"];
const right = ["PROJECT B", "Role: led rollout", "Result: 20% faster"];
const columns: TextRun[] = [
  ...left.map((text, i) => ({text,x:30,y:730-i*25})),
  ...right.map((text, i) => ({text,x:330,y:730-i*25})),
];
const columnTree = section(section(p(0),p(1),p(2)), section(p(3),p(4),p(5)));
const geometricColumns = left.map((text,index) => `${text} ${right[index]}`).join("\n");

describe("PDF structure reading order", () => {
  it("reads each tagged column completely without mixing responsibility or results", async () => {
    expect(await extractContentFromFile("columns.pdf",makeTaggedPdf(columns,columnTree)))
      .toEqual({text:[...left,...right].join("\n")});
  });

  it("follows explicitly tagged right-first order even when paint order starts on the left", async () => {
    const tree = section(section(p(3),p(4),p(5)),section(p(0),p(1),p(2)));
    expect(await extractContentFromFile("explicit-order.pdf",makeTaggedPdf(columns,tree)))
      .toEqual({text:[...right,...left].join("\n")});
  });

  it("keeps inline Span references together inside their paragraph", async () => {
    const runs = [
      {text:"Array<",x:30,y:730}, {text:"T",x:73.2,y:730}, {text:">",x:80.4,y:730},
      {text:"user",x:30,y:705}, {text:"?.",x:58.8,y:705}, {text:"name",x:73.2,y:705},
    ];
    const span = (index: number): Structure => ({role:"Span",children:[index]});
    expect(await extractContentFromFile("inline.pdf",makeTaggedPdf(runs,section(p(span(0),span(1),span(2)),p(span(3),span(4),span(5))))))
      .toEqual({text:"Array<T>\nuser?.name"});
  });

  it("separates same-height paragraphs and keeps wrapped lines inside the first paragraph", async () => {
    const runs = [{text:"First paragraph",x:30,y:730},{text:"still first",x:30,y:705},{text:"Second paragraph",x:330,y:730}];
    expect(await extractContentFromFile("paragraphs.pdf",makeTaggedPdf(runs,section(p(0,1),p(2)))))
      .toEqual({text:"First paragraph\nstill first\nSecond paragraph"});
  });

  it("keeps table values next to the correct row header", async () => {
    const runs = [{text:"TypeScript",x:30,y:730},{text:"Unit tests",x:330,y:730},{text:"Node.js",x:30,y:705},{text:"Local tooling",x:330,y:705}];
    const row = (a: number,b: number): Structure => ({role:"TR",children:[{role:"TH",children:[p(a)]},{role:"TD",children:[p(b)]}]});
    const tree: Structure = {role:"Table",children:[row(0,1),row(2,3)]};
    expect(await extractContentFromFile("table.pdf",makeTaggedPdf(runs,tree)))
      .toEqual({text:"TypeScript\tUnit tests\nNode.js\tLocal tooling"});
  });

  it.each([
    {name:"missing tree",tree:null},
    {name:"unreferenced visible text",tree:section(p(0),p(1),p(3),p(4),p(5))},
    {name:"duplicate content reference",tree:section(p(0,0),p(1),p(2),p(3),p(4),p(5))},
  ])("preserves all text with geometry fallback for $name", async ({tree}) => {
    expect(await extractContentFromFile("fallback.pdf",makeTaggedPdf(columns,tree)))
      .toEqual({text:geometricColumns});
  });

  it("does not discard visible unmarked content when the rest of the page is tagged", async () => {
    const runs = [...columns,{text:"UNMARKED: not verified",x:30,y:630,tagged:false}];
    expect(await extractContentFromFile("partly-tagged.pdf",makeTaggedPdf(runs,columnTree)))
      .toEqual({text:`${geometricColumns}\nUNMARKED: not verified`});
  });

  it("retains a valid single-column heading and right-aligned date in one tagged paragraph", async () => {
    const runs = [{text:"PROJECT A",x:30,y:730},{text:"2023 - 2024",x:420,y:730},{text:"Assisted tests; not deployed",x:30,y:705}];
    expect(await extractContentFromFile("dates.pdf",makeTaggedPdf(runs,section(p(0,1),p(2)))))
      .toEqual({text:"PROJECT A 2023 - 2024\nAssisted tests; not deployed"});
  });

  it("preserves paragraph order in a browser-exported two-column PDF", async () => {
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>body{font:16px Arial}p{margin:0 0 12px}</style><body>
      <h1>Synthetic Candidate</h1><div style="display:grid;grid-template-columns:1fr 1fr;gap:60px">
      <section>${left.map(text=>`<p>${text}</p>`).join("")}</section>
      <section>${right.map(text=>`<p>${text}</p>`).join("")}</section></div></body></html>`;
    expect(await extractContentFromFile("exported.pdf",await generateResumePdf(html)))
      .toEqual({text:["Synthetic Candidate",...left,...right].join("\n")});
  },30_000);

  it.each(["left","right"] as const)("keeps the actual resume template's %s sidebar separate from project responsibilities", async asidePosition => {
    const data: ResumeWithModules = {
      resume:{id:1,title:"SYNTHETIC RESUME",template:"twocol",style_overrides:{asidePosition,asideModules:["summary"]},created_at:"",updated_at:""},
      modules:[
        {key:"basic",type:"basic",label:"Contact",sort:0,content:{name:"SYNTHETIC CANDIDATE"}},
        {key:"projects",type:"projects",label:"PROJECTS",sort:1,content:[{name:"MAIN PROJECT",role:"Assisted tests",description:"MAIN RESULT: not deployed."}]},
        {key:"summary",type:"summary",label:"ASIDE SUMMARY",sort:2,content:{text:"ASIDE FACT: team handled rollout."}},
      ],warnings:[],corruptedKeys:[],
    };
    const result = await extractContentFromFile("resume.pdf",await generateResumePdf(renderResumeToHtml(data,[])));
    const tokens = asidePosition === "left"
      ? ["ASIDE SUMMARY","ASIDE FACT: team handled rollout.","PROJECTS","MAIN PROJECT","MAIN RESULT: not deployed."]
      : ["PROJECTS","MAIN PROJECT","MAIN RESULT: not deployed.","ASIDE SUMMARY","ASIDE FACT: team handled rollout."];
    let previous = -1;
    for(const token of tokens) {
      expect(result.text.split(token)).toHaveLength(2);
      expect(result.text.indexOf(token)).toBeGreaterThan(previous);
      previous = result.text.indexOf(token);
    }
    expect(result.ocr).toBeUndefined();
  },30_000);

  it("preserves page order around separate tagged column groups", async () => {
    const pages = [1,2].map(page => `<section style="${page===1 ? "break-after:page" : ""}"><h1>PAGE ${page}</h1>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:60px">
      <section><p>LEFT ${page}</p><p>Left detail ${page}</p></section>
      <section><p>RIGHT ${page}</p><p>Right detail ${page}</p></section></div></section>`).join("");
    const pdf = await generateResumePdf(`<!doctype html><html lang="en"><meta charset="utf-8"><style>body{font:16px Arial}</style><body>${pages}</body></html>`);
    const expected = [1,2].map(page => [`PAGE ${page}`,`LEFT ${page}`,`Left detail ${page}`,`RIGHT ${page}`,`Right detail ${page}`].join("\n")).join("\n\n");
    expect(await extractContentFromFile("pages.pdf",pdf)).toEqual({text:expected});
  },30_000);
});
