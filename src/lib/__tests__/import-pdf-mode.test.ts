import {afterEach,describe,expect,it,vi} from "vitest";
import {POST} from "@/app/api/import/parse/route";
const mocks=vi.hoisted(()=>({extract:vi.fn(),dispose:vi.fn(),chat:vi.fn(),fields:{} as Record<string,string>}));
vi.mock("@/lib/parse-file",()=>({extractContentFromPath:mocks.extract,ParseBusyError:class extends Error {}}));
vi.mock("@/lib/streaming-multipart",async original=>({
  ...await original<typeof import("@/lib/streaming-multipart")>(),
  parseMultipartUpload:async()=>({fields:mocks.fields,file:{filename:"source.pdf",path:"synthetic-file"},dispose:mocks.dispose}),
}));
vi.mock("@/lib/safe-llm",()=>({safeChat:mocks.chat,LLM_FEATURES:{resumeImportParse:"fixture"}}));
afterEach(()=>{vi.clearAllMocks();mocks.fields={};});
const request=()=>new Request("http://localhost/api/import/parse",{method:"POST",headers:{"content-type":"multipart/form-data; boundary=fixture"}});
describe("explicit PDF image mode API",()=>{
  it("forwards image selection and cancellation while returning OCR metadata without structure generation",async()=>{
    mocks.fields={pdfMode:"image",extractOnly:"true"};
    mocks.extract.mockResolvedValue({text:"full image source",ocr:{engine:"local",pageCount:2,sourceType:"pdf"}});
    const req=request();
    const response=await POST(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({extractedText:"full image source",ocr:{engine:"local",pageCount:2,sourceType:"pdf"}});
    expect(mocks.extract).toHaveBeenCalledWith("source.pdf","synthetic-file",{signal:req.signal,pdfMode:"image"});
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.chat).not.toHaveBeenCalled();
  });
  it.each(["force","true","", "IMAGE"])("rejects invalid mode %s before extraction and disposes the upload",async pdfMode=>{
    mocks.fields={pdfMode,extractOnly:"true"};
    const response=await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error:"PDF 读取方式无效"});
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("rejects image selection without an uploaded file",async()=>{
    const response=await POST(new Request("http://localhost/api/import/parse",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"source",pdfMode:"image"})}));
    expect(response.status).toBe(400);
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
  });
});
