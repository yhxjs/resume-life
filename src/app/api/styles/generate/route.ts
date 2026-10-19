import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { DEFAULT_STYLE, isCompleteGeneratedStyle, normalizeStyle, type ResumeStyle } from "@/lib/templates";
import { errorMessage } from "@/lib/error-message";

const SYSTEM_PROMPT = `你是专业的简历排版设计师。请根据用户的风格描述，输出一套完整的简历样式参数 JSON。
必须返回以下全部基础字段，不能省略、不能使用 null、不能添加解释文字：
layout、asideWidth、pageMargin、headerStyle、headerBg、font、baseSize、lineHeight、accent、ink、text、muted、titleAlign、nameSize、nameWeight、nameTracking、titleRule、titleRuleThickness、contactSize、sectionSize、sectionWeight、sectionColor、sectionTracking、sectionDeco、sectionDecoColor、sectionGapBefore、sectionGapAfter、entryTitleSize、entryTitleWeight、entrySubAccent、entryGap、descItemGap、skillStyle。
可根据描述选填结构布局增强字段：
- asidePosition：侧栏位置（left 或 right）
- asideBg：侧栏底色（6位 Hex 如 #f8fafc）
- asideBorder：侧栏分隔线（auto、none、left、right、both）
- headerLayout：头像位置（right-avatar 靠右、left-avatar 靠左、center-avatar 居中）
- contactLayout：联系方式排版（inline 流式、grid2 双列网格）
- skillCols：技能展示列数（1、2 或 3）
- entryCols：经历条目展示列数（1 或 2）

字段约束：
- layout 只能是 single 或 twocol；headerStyle 只能是 default、banner 或 card；font 只能是 serif 或 sans。
- titleAlign 只能是 center 或 left；titleRule 只能是 none、accent 或 dark；sectionDeco 只能是 none、underline、leftbar 或 band；skillStyle 只能是 pill、line 或 list。
- headerBg、accent、ink、text、muted、sectionColor、sectionDecoColor 必须是 6 位 hex 颜色（#RRGGBB）。
- asideWidth 取 30-100，pageMargin 取 6-25，baseSize 取 9-14，lineHeight 取 1.2-2。
- nameSize 取 16-40，nameWeight、sectionWeight、entryTitleWeight 取 400-900 的整百，nameTracking 取 0-8。
- titleRuleThickness 取 1-6，contactSize 取 9-14，sectionSize 取 10-18，sectionTracking 取 0-8。
- sectionGapBefore 取 4-28，sectionGapAfter 取 2-16，entryTitleSize 取 11-16，entryGap 取 4-20，descItemGap 取 0-16。
- entrySubAccent 必须是布尔值。

请根据描述自主选择所有参数，确保排版、字体、颜色、间距和装饰协调。不要机械复制字段说明中的值，也不要使用固定默认模板；颜色应适合白纸打印并保持清晰可读。金融/法律可偏 serif + underline + 居中，互联网可偏 sans + leftbar + pill，但最终以用户描述为准。只输出 JSON。`;

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "请先描述你想要的模板风格" }, { status: 400 });
  if (prompt.length > 500) {
    return NextResponse.json({ error: "风格描述不能超过 500 字" }, { status: 400 });
  }

  let raw: string;
  try {
    raw = await safeChat(
      "question",
      { feature: LLM_FEATURES.styleGenerate },
      SYSTEM_PROMPT,
      [
        {
          role: "user",
          parts: [
            { trust: "trusted", text: "【风格描述】\n" },
            { trust: "untrusted", tag: "style_description", text: prompt },
            { trust: "trusted", text: "\n\n请输出样式 JSON。" },
          ],
        },
      ],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let style: ResumeStyle;
  try {
    const candidate = extractJson<unknown>(raw);
    if (!isCompleteGeneratedStyle(candidate)) {
      throw new Error("结构校验未通过：必须返回完整且合法的样式参数");
    }
    const parsed = normalizeStyle(candidate);
    if (!parsed) throw new Error("结构校验未通过");
    const unchanged = (Object.keys(DEFAULT_STYLE) as (keyof ResumeStyle)[])
      .every((key) => parsed[key] === DEFAULT_STYLE[key]);
    if (unchanged) throw new Error("没有生成有效的个性化样式");
    style = parsed;
  } catch (err) {
    return NextResponse.json(
      { error: `AI 生成的样式参数异常：${errorMessage(err)}，请重试` },
      { status: 502 }
    );
  }
  return NextResponse.json({ style });
}

export const POST = withRouteErrorHandling("POST /api/styles/generate", handlePost);
