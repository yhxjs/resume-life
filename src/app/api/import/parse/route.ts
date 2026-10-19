import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { extractContentFromPath, ParseBusyError } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";
import { MODULE_KEYS, normalizeContent, type ModuleKey } from "@/lib/modules";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { RequestFormatError, RequestTooLargeError, readJsonBody } from "@/lib/request-limits";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import {
  isMultipartFormDataRequest,
  MultipartFormatError,
  parseMultipartUpload,
} from "@/lib/streaming-multipart";
import { errorMessage } from "@/lib/error-message";

/**
 * 归一化后由系统补齐、不代表用户内容的机器字段。
 * normalizeContent 会给 work/projects 的每条补上 descriptionStyle: "unordered"，
 * 这个真值字符串不是内容——不排除的话，模型只回一个空条目也会被当成解析成功，
 * 用户就拿不到「保留原文、手工整理」的恢复路径。
 */
const MACHINE_FIELDS = new Set(["id", "descriptionStyle", "fieldOrder"]);

function hasContent(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasContent);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, field]) => !MACHINE_FIELDS.has(key) && hasContent(field));
  }
  return false;
}

const SYSTEM_PROMPT = `你是简历解析器。把用户提供的简历原文解析为 JSON，结构：
{
  "title": "简历标题建议（不超过 20 字）",
  "basic": { "name": "", "gender": "", "age": "", "phone": "", "email": "", "location": "", "birthday": "", "links": "" },
  "education": [{ "school": "", "degree": "", "field": "", "start": "", "end": "", "description": "" }],
  "work": [{
    "company": "",
    "title": "",
    "start": "",
    "end": "",
    "subItems": [{ "label": "技术栈", "value": "" }],
    "description": "按完整事项拆分的多行工作内容与成果（可留空字符串，系统自动拼接）",
    "descriptionItems": ["完整事项1（包含该事项的动作、技术手段与产出）", "完整事项2"]
  }],
  "projects": [{
    "name": "",
    "role": "",
    "start": "",
    "end": "",
    "subItems": [{ "label": "技术栈", "value": "" }],
    "description": "按完整事项拆分的多行项目描述与成果（可留空字符串，系统自动拼接）",
    "descriptionItems": ["完整事项/核心贡献1（包含该事项的动作、技术方案与产出）", "完整事项/量化成果2"]
  }],
  "skills": { "items": ["", ""] },
  "summary": { "text": "" }
}
规则：
1. 只输出 JSON，不要输出任何其他文字；
2. 原文没有的信息留空字符串或空数组；
3. 时间保持原文写法；
4. 同一段落里包含多段经历时拆成数组多项；
5. 工作经历(work)与项目经历(projects)中若出现类似“技术栈：Spring Boot、Dubbo、MySQL...”或“主要技术：React, Node.js...”或所属部门、团队规模等属性，必须提取到 subItems 数组中作为自定义副项，例如 {"label": "技术栈", "value": "Spring Boot、Dubbo、MySQL..."}，不要混杂在正文描述中；
6. descriptionItems 拆分粒度准则（非常重要）：
   - 必须按【独立的业务事项、具体功能模块或工作任务】维度进行拆分，保持每个事项内部语意与方案上下文的完整性；
   - 严禁机械地按句号断句硬切！如果前后两句属于同一任务的背景、设计方案、具体实现手段或配套逻辑（例如前句阐述核心流程与方案，后句补充技术细节、防重机制或异步处理等实现保障），它们共同构成一个完整的工作要点，必须合并保留在同一条 descriptionItem 中；
   - 仅在原文有明确的分条符号（如数字标号 1./2.、项目符号 •/-、分段换行），或者属于完全不同的独立工作方向/成果时，才拆分为不同的条目；
   - description 字段可留空字符串 ""（系统会自动由 descriptionItems 拼接生成），避免重复输出正文。`;

async function handlePost(req: Request) {
  let text = "";
  let extractOnly = false;
  let fileOcr: { engine: "vision" | "local"; pageCount: number; sourceType?: "pdf" | "image" } | undefined;
  const isMultipart = isMultipartFormDataRequest(req);
  let upload: Awaited<ReturnType<typeof parseMultipartUpload>> | undefined;
  try {
    if (isMultipart) {
      upload = await parseMultipartUpload(req);
      extractOnly = upload.fields.extractOnly === "true";
      const file = upload.file;
      if (!file) {
        return NextResponse.json({ error: "未收到文件" }, { status: 400 });
      }
      const extracted = await extractContentFromPath(file.filename, file.path, { signal: req.signal });
      text = extracted.text;
      fileOcr = extracted.ocr;
    } else {
      const body = await readJsonBody<{ text?: unknown } | null>(req);
      text = typeof body?.text === "string" ? body.text : "";
    }
  } catch (err) {
    if (err instanceof ParseBusyError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof RequestTooLargeError) {
      return NextResponse.json({ error: "请求体或文件过大" }, { status: 413 });
    }
    if (err instanceof RequestFormatError || err instanceof MultipartFormatError) {
      return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
    }
    if (err instanceof FileFormatError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const requestId = logServerError("import.parse.request", err, {
      requestId: requestIdFrom(req),
      status: 500,
    });
    return NextResponse.json(
      { error: "简历文件处理失败，请稍后重试", requestId },
      { status: 500 }
    );
  } finally {
    upload?.dispose();
  }

  if (!text.trim()) {
    return NextResponse.json({ error: "没有提取到文本内容" }, { status: 400 });
  }
  // 先交回完整原文；模型预算只截取输入，不丢弃可供用户手工恢复的内容。
  if (extractOnly) return NextResponse.json({ extractedText: text, ocr: fileOcr });

  let raw: string;
  try {
    raw = await safeChat("parse", { feature: LLM_FEATURES.resumeImportParse }, SYSTEM_PROMPT, [
      {
        role: "user",
        parts: [
          { trust: "trusted", text: "以下是待解析的简历原文：\n\n" },
          { trust: "untrusted", tag: "resume_source", text: text.slice(0, 60000) },
        ],
      },
    ], { signal: req.signal, requireJson: true });
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : `${errorMessage(err)}`;
    return NextResponse.json({ error: message, extractedText: text, ocr: fileOcr }, { status: 502 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson<Record<string, unknown>>(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("应返回包含简历模块的 JSON 对象");
    }
  } catch (err) {
    return NextResponse.json(
      { error: `AI 解析结果异常：${errorMessage(err)}`, extractedText: text, ocr: fileOcr },
      { status: 502 }
    );
  }

  const modules: Record<string, unknown> = {};
  for (const key of MODULE_KEYS) {
    modules[key] = normalizeContent(key as ModuleKey, parsed[key]);
  }
  if (!hasContent(modules)) {
    return NextResponse.json(
      { error: "AI 未返回有效简历内容，请根据保留的原文手工整理或重新解析", extractedText: text, ocr: fileOcr },
      { status: 502 }
    );
  }
  const title =
    typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "导入的简历";
  return NextResponse.json({ title, modules, ocr: fileOcr });
}

export const POST = withRouteErrorHandling("POST /api/import/parse", handlePost);
