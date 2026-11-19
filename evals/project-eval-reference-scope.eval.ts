import { it } from "vitest";
import { createHash } from "node:crypto";
import { buildDrillEvaluation, PROJECT_EVAL_PROMPT, validateDrillEvaluation } from "@/lib/drill-answer-llm";
import { serializeProjectInterviewContext, type ProjectInterviewContextSource } from "@/lib/project-interview-context";
import { emptySummary } from "@/lib/summary";
import { LLM_FEATURES, safeChat } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { repeatedSourceMaterials } from "./project-evidence-fixture";

const sourceOrderRubric = "两种材料顺序的题目与原答相同，按同一证据标准独立评价；原答只说明职责和待核对范围，没有实际给出边界选择与验证步骤，不能用背景中的已完成校验替本题补分。原始自述及两份转贴不是独立核实，明确更正仍有效；不得因重复或位置恢复个人主导缓存与下降 50%，也不把诚实说明待核对判成造假。参考保留实际参数校验职责、同事负责缓存、未统计收益与未上线边界，缺失验证细节用待补充标记或条件式框架，不虚构已做的用例或测试。";

const pairSeeds: {
  pairId: string;
  project: ProjectInterviewContextSource;
  question: string;
  answer: string;
  rubric: string;
}[] = [
  {
    pairId: "source-order-forward",
    project: { projectName: "订单项目", archive: emptySummary(), materials: repeatedSourceMaterials },
    question: "你如何验证参数校验覆盖了关键边界？",
    answer: "我只做参数校验，具体校验范围和验证步骤需要核对记录。",
    rubric: sourceOrderRubric,
  },
  {
    pairId: "source-order-reverse",
    project: { projectName: "订单项目", archive: emptySummary(), materials: [...repeatedSourceMaterials].reverse() },
    question: "你如何验证参数校验覆盖了关键边界？",
    answer: "我只做参数校验，具体校验范围和验证步骤需要核对记录。",
    rubric: sourceOrderRubric,
  },
  {
    pairId: "unrelated-same-project-fact",
    project: {
      projectName: "订单后台平台",
      archive: { ...emptySummary(), responsibilities: "本人增加缓存版本校验；另更新导出字段说明文档。" },
      materials: [
        { title: "缓存记录", content: "本人为防止旧缓存回填，在回填时比较版本下界。本地并发测试覆盖新版本写入后旧请求恢复；改动尚未上线。" },
        { title: "模板文档", content: "本人更新 CSV 导出字段说明，供财务团队查阅；材料未说明本人参与导出功能实现。" },
      ],
    },
    question: "你如何处理旧缓存回填，实际验证与发布状态是什么？",
    answer: "我在回填时比较当前版本和缓存版本下界，只允许不低于下界的版本写入。本地并发测试覆盖新版本写入后旧请求恢复，改动尚未上线。",
    rubric: "reference 围绕本题的缓存职责与动作完整保留版本下界、本人工作、本地并发测试和未上线状态；同一平台的 CSV 字段说明属于独立且无关的工作，不带入 reference。不得把导出功能归给本人，也不把本地测试升级为生产验证。",
  },
  {
    pairId: "explicit-role-correction-unseen",
    project: {
      projectName: "会员权益接口调整",
      archive: { ...emptySummary(), responsibilities: "本人独立开发权益接口。", achievements: ["平均延迟下降 30%"] },
      materials: [{ title: "当前版本更正", content: "更正会员权益接口调整的当前版本：本人整理异常参数清单和校验规则，后端同事实现校验代码；本次规则清单已交付，接口尚未上线，也未统计线上收益。撤回旧档案中本人独立开发及平均延迟下降 30% 的说法。" }],
    },
    question: "你会怎样确认异常参数清单覆盖了关键场景？",
    answer: "我只整理异常输入清单，哪些边界在清单里需要核对原记录。",
    rubric: "评分只依据本次原答，不能用背景补写覆盖方法。reference 简短保留本人只整理异常参数清单/规则、校验代码由后端同事实现、清单已交付、接口未上线且未统计线上收益；明确撤回的独立开发与30%指标不能恢复。方法使用条件式或待补框架，不写成本人已执行测试，也不把团队同事的代码工作归给本人。",
  },
  {
    pairId: "explicit-role-correction-compact",
    project: {
      projectName: "支付回调重试模块",
      archive: { ...emptySummary(), responsibilities: "本人设计并实现重试队列，完成灰度。", achievements: ["重复回调下降 35%"] },
      materials: [{ title: "当前职责更正", content: "更正旧档案：本人整理超时与重复回调检查清单，重试队列代码由平台同事实现。清单经评审后已交付，队列尚未发布，也没有统计线上收益。撤回本人设计实现、已灰度及重复回调下降 35% 的说法。" }],
    },
    question: "你会怎样确认检查清单覆盖了主要重试场景？",
    answer: "我只整理了超时和重复回调清单，具体覆盖范围与验证记录要再查。",
    rubric: "评分只依据原答，不能用背景补写验证方法。reference 保留本人仅整理清单、队列代码由平台同事实现、清单评审后已交付、队列未发布且线上收益未统计；不恢复已撤回的设计实现、灰度及35%指标。检查方法用条件式或待补项表述。",
  },
  {
    pairId: "unrelated-work-unseen",
    project: {
      projectName: "会员回调与运营报表平台",
      archive: emptySummary(),
      materials: [{ title: "项目访谈", content: "本人调整会员回调的幂等策略，本地回归用例已执行，改动尚未发布。另本人独立更新运营报表 CSV 字段说明，供财务团队查阅；这项文档工作与回调策略无关。" }],
    },
    question: "你如何避免会员回调重复通知造成重复入账，实际验证与发布状态是什么？",
    answer: "回调处理按业务单号做幂等校验，重复通知命中已有处理记录后不再重复入账。本地回归用例已执行，改动尚未发布。",
    rubric: "reference 聚焦回调幂等处理、已知验证和未发布状态；运营报表 CSV 字段说明是同项目独立事项，不带入 reference。不得把本地回归测试升级为线上验证。评分基于本次回答，不能因背景里的文档工作补分或扣分。",
  },
  {
    pairId: "unrelated-work-compact",
    project: {
      projectName: "订单导出模块",
      archive: emptySummary(),
      materials: [{ title: "版本记录", content: "本人修复订单导出跨页时金额重复的问题，本地回归确认两页金额一致，修复尚未发布。另本人整理采购 CSV 字段指南供审计查阅；该文档工作与导出修复无关。" }],
    },
    question: "你如何确认跨页导出没有重复计算金额，当前发布状态是什么？",
    answer: "我修复了跨页金额重复，本地回归确认两页金额一致，目前还没发布。",
    rubric: "reference 保留跨页金额修复、本地回归范围和未发布状态；采购 CSV 字段指南是同项目独立事项，不带入。不得把本地回归写成生产验证。评分只依据本次原答。",
  },
  {
    pairId: "explicit-exclusive-duty-new",
    project: {
      projectName: "订单字段校验",
      archive: { ...emptySummary(), responsibilities: "本人独立设计字段校验和错误定位。", achievements: ["字段漏填率下降 40%"] },
      materials: [{ title: "职责更正", content: "更正旧档案：本人只整理必填字段检查清单；字段校验与错误定位代码由后端同事实现。清单已交付，校验功能尚未上线，也未统计业务收益。撤回本人独立设计及字段漏填率下降 40% 的说法。" }],
    },
    question: "你会怎么确认清单覆盖了关键必填字段？",
    answer: "我只整理必填字段清单，具体覆盖哪些字段和验证记录要再核对。",
    rubric: "评分只依据本次原答，不能用背景补写覆盖方法。reference 明确保留本人只整理清单、字段校验与错误定位由后端同事实现、清单已交付、功能未上线且未统计业务收益；不得弱化“只整理”为泛指清单工作，也不能恢复已撤回的独立设计或40%指标。方法使用条件式或待补项表达。",
  },
  {
    pairId: "unrelated-work-new-control",
    project: {
      projectName: "订单导出与对账平台",
      archive: emptySummary(),
      materials: [{ title: "交付记录", content: "本人只负责导出文件名参数校验。本地边界用例已执行，校验功能尚未发布。另本人整理对账 CSV 字段说明供财务查阅；这项文档工作与参数校验无关。" }],
    },
    question: "你在导出文件名参数校验中负责什么，实际验证和发布状态是什么？",
    answer: "我只负责文件名参数校验，本地边界用例已执行，功能还没发布。",
    rubric: "reference 保留本人只负责参数校验、本地边界用例已执行和功能未发布；对账 CSV 字段说明是同项目独立事项，不带入。不得将本地用例写成生产验证。评分只依据本次原答。",
  },
];

const cases = pairSeeds.map(seed => ({ ...seed, variant: "production" as const, id: `${seed.pairId}-production` }));
const evaluate = createEvaluationSuite("project-eval-reference-scope", cases.length, 1800);

for (const sample of cases) {
  it(sample.id, async () => {
    const context = serializeProjectInterviewContext(sample.project);
    const evaluation = buildDrillEvaluation({
      isBankDrill: false,
      direction: "",
      jd: "",
      projectContext: context,
      question: sample.question,
      answer: sample.answer,
    });
    const systemPrompt = PROJECT_EVAL_PROMPT;
    const input = {
      pairId: sample.pairId,
      variant: sample.variant,
      systemPromptSha256: createHash("sha256").update(systemPrompt).digest("hex"),
      project: sample.project,
      context,
      question: sample.question,
      answer: sample.answer,
    };
    await evaluate({
      id: sample.id,
      input,
      system: systemPrompt,
      messages: evaluation.messages,
      rubric: [
        "评分只根据本次题目与回答；背景用于理解语境，不能替回答补分。回答参考与改写不得包装为候选人已展示的经历。",
        sample.rubric,
      ],
      call: opts => safeChat("evaluate", { feature: LLM_FEATURES.drillGrade }, systemPrompt, evaluation.messages, opts),
      validate: validateDrillEvaluation,
    });
  });
}
