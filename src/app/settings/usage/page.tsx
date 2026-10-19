import { PageHeader } from "@/components/common/ui-bits";
import { LlmUsagePanel } from "@/components/settings/llm-usage-panel";

export default function LlmUsagePage() {
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="用量统计"
        desc="AI 调用的 token 计量、来源追踪与缓存命中率。时间范围与来源筛选同时作用于看板与下方日志。"
      />
      <LlmUsagePanel />
    </div>
  );
}
