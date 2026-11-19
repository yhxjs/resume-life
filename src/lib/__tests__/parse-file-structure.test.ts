import { EventEmitter } from "node:events";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sandbox from "../parse-sandbox";
import { extractContentFromFile } from "../parse-file";

afterEach(() => vi.restoreAllMocks());

const content = (text: string, y = 730) => ({str:text,transform:[12,0,0,12,30,y],width:100,height:12});
const begin = (id: string) => ({type:"beginMarkedContentProps",id});
const end = {type:"endMarkedContent"};
const ref = (id: string) => ({type:"content",id});
const paragraph = (id: string) => ({role:"P",children:[ref(id)]});

/** Run the production child source; only pdf.js I/O is substituted to exercise unreadable tags. */
function parserFixture(items: unknown[], getStructure: () => unknown) {
  const defaultText = vi.fn(() => { throw new Error("Text layer must survive tag failures"); });
  vi.spyOn(sandbox, "runInSandboxedProcess").mockImplementation((source, _module, _data, _limits, _timeout, read) => new Promise((resolve,reject) => {
    const stdin = new EventEmitter();
    const stdout = {write(value: string) {try {resolve(read(value));} catch(error) {reject(error);} }};
    const page = {
      getTextContent: async () => ({items}),
      getStructTree: async () => getStructure(),
      getOperatorList: async () => ({fnArray:[]}),
      cleanup: () => undefined,
    };
    class PDFParse {
      doc = {numPages:1,getPage:async () => page};
      load = async () => undefined;
      getText = defaultText;
      destroy = async () => undefined;
    }
    vm.runInNewContext(source,{Buffer,process:{argv:["","fixture"],stdin,stdout},require:() => ({PDFParse})});
    stdin.emit("end");
  }));
  return defaultText;
}

describe("PDF tag failure boundaries", () => {
  it.each(["read failure","invalid children","excessive nesting","cyclic tree"])("keeps the entire text layer on %s", async failure => {
    const items = [begin("a"),content("Array<T>"),end,begin("b"),content("not deployed",705),end];
    const defaultText = parserFixture(items,() => {
      if(failure === "read failure") throw new Error("synthetic structure read failure");
      if(failure === "invalid children") return {role:"Root",children:{invalid:true}};
      const tree: {role:string;children:unknown[]} = {role:"Root",children:[paragraph("a"),paragraph("b")]};
      if(failure === "cyclic tree") {tree.children.push(tree);return tree;}
      let nested: unknown = tree;
      for(let index=0;index<140;index++) nested={role:"Sect",children:[nested]};
      return nested;
    });
    expect(await extractContentFromFile("broken-tags.pdf",Buffer.from("fixture"))).toEqual({text:"Array<T>\nnot deployed"});
    expect(defaultText).not.toHaveBeenCalled();
  });

  it("ignores non-text structure nodes while retaining all marked visible text", async () => {
    parserFixture([begin("a"),content("actual text"),end],() => ({role:"Root",children:[{role:"Figure",children:[ref("image-only")]},paragraph("a")]}));
    expect(await extractContentFromFile("image-tag.pdf",Buffer.from("fixture"))).toEqual({text:"actual text"});
  });

  it("falls back on unmatched marked-content boundaries instead of adopting a reordered tree", async () => {
    parserFixture([end,begin("a"),content("First"),end,begin("b"),content("Second",705),end],() => ({role:"Root",children:[paragraph("b"),paragraph("a")]}));
    expect(await extractContentFromFile("unbalanced.pdf",Buffer.from("fixture"))).toEqual({text:"First\nSecond"});
  });

  it("retains the Unicode code-point limit when structure extraction succeeds", async () => {
    let text = "\u{1f600}".repeat(200_000);
    const item = content(text);
    parserFixture([begin("a"),item,end],() => ({role:"Root",children:[paragraph("a")]}));
    expect(await extractContentFromFile("limit.pdf",Buffer.from("fixture"))).toEqual({text});
    text += "x";
    item.str = text;
    await expect(extractContentFromFile("over.pdf",Buffer.from("fixture"))).rejects.toThrow("PDF 提取文本不得超过 200000 字符");
  });
});
