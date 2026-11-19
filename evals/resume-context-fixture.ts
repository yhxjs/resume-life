import type { ModuleData, SummaryContent } from "@/lib/modules";
import { assertResumeModelModules } from "@/lib/resume-model-material";
import { formatResumeContext } from "@/lib/resumes";

/** 合成职业模块与实际模型文本一并保留；序列化及基本身份过滤沿用生产读取。 */
export function resumeContextFixture(text: string): { modules: ModuleData[]; text: string } {
  const modules: ModuleData[] = [{ key: "summary", type: "summary", label: "自我评价", sort: 0,
    content: { text, descriptionItems: [], descriptionStyle: "unordered" } satisfies SummaryContent,
  }];
  assertResumeModelModules(modules);
  return { modules, text: formatResumeContext(modules) };
}
