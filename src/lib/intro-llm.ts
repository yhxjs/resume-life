import type { IntroKind } from "@/lib/intro";
import { checkModelField } from "@/lib/llm-input-budget";
import type { PromptPart } from "@/lib/safe-llm";

/** 生成自我介绍的 LLM 提示词与消息拼装（服务端专用；route.ts 只允许导出 HTTP 处理器） */

export const INTRO_SYSTEM_PROMPT = `你是资深面试教练。请基于候选人的简历与目标岗位要求（JD），生成自我介绍并逐句点评。
输出 JSON：
{
  "versions": [
    { "kind": "30s", "sentences": [{ "text": "一句完整的话", "comment": "这句的点评" }] },
    { "kind": "2min", "sentences": [{ "text": "一句完整的话", "comment": "这句的点评" }] }
  ]
}
两版要求：
- 30s（30 秒版）：4-6 句、共 100-160 字。一句定位（身份+年限+方向），一两句与 JD 最强的匹配亮点，一句动机或期待收尾。
- 2min（2 分钟版）：10-16 句、共 450-600 字。在 30 秒版骨架上展开：补充 1-2 个与 JD 最相关的项目/经历证据（背景-做法-量化结果）与技能匹配，结尾表达对岗位与团队的动机。
写作规则：
- 只使用简历中真实存在的信息，严禁编造经历、技能或数字；简历信息不足时宁可少写
- 语言口语化、可直接朗读；每条 text 是完整的一句话并以标点结尾，不带序号，也不要把多个句子塞进同一条
- 覆盖 JD 中的关键要求（技术栈、业务方向），但简历没有对应经历的关键词不要硬凑
点评规则：
- 每条 comment 只评这一句：说明它的作用（开场定位/匹配 JD/量化证据/动机收尾等）与亮点或风险（空泛、夸大、与 JD 无关、可再量化等），20-40 字，不得为空
只输出 JSON。`;

/** 生成消息：kinds 含两版时一次生成两版，重新生成单版时只要求该版 */
export function buildGenerateUserMessage(args: {
  jd: string;
  resumeContext: string;
  kinds: IntroKind[];
}): PromptPart[] {
  checkModelField(args.jd, "岗位要求（JD）");
  const scope =
    args.kinds.length === 2
      ? "请生成 30 秒版与 2 分钟版自我介绍并逐句点评。"
      : `请只生成「${args.kinds[0] === "30s" ? "30 秒版" : "2 分钟版"}」（versions 数组只含这一版）并逐句点评。`;
  return [
    { trust: "untrusted", tag: "job_description", text: args.jd },
    { trust: "trusted", text: "\n\n" },
    { trust: "untrusted", tag: "candidate_resume", text: args.resumeContext },
    { trust: "trusted", text: `\n\n${scope}` },
  ];
}

export const INTRO_COMMENT_SYSTEM_PROMPT = `你是资深面试教练。下面是一份自我介绍按句拆分后的文本，请对每一句给出点评。
输入：JSON 数组 [{"i": 句子序号(从1开始), "text": "句子"}]
输出 JSON：{"comments": ["第1句的点评", "第2句的点评", ...]}
要求：comments 与输入句子按顺序一一对应、条数相同；每条点评只评这一句——说明它的作用（开场定位/匹配 JD/量化证据/动机收尾等）、亮点或风险（空泛、夸大、与 JD 无关、口语化等），并给一句可执行的改进方向；每条 20-50 字；只输出 JSON。`;

export function buildCommentUserMessage(args: {
  jd: string;
  sentences: { text: string }[];
}): PromptPart[] {
  checkModelField(args.jd, "岗位要求（JD）");
  const items = JSON.stringify(
    args.sentences.map((s, i) => ({ i: i + 1, text: s.text }))
  );
  return [
    { trust: "untrusted", tag: "job_description", text: args.jd },
    { trust: "trusted", text: "\n\n" },
    { trust: "untrusted", tag: "intro_sentences", text: items },
    { trust: "trusted", text: "\n\n请逐句点评。" },
  ];
}
