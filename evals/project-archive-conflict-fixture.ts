import { emptySummary } from "@/lib/summary";

/** Shared source for unresolved archive conflicts in summary and answer-reference evaluations. */
export const unclarifiedProjectArchiveConflict = {
  projectName: "订单服务",
  archive: {
    ...emptySummary(),
    responsibilities: "本人独立实现缓存模块。",
    achievements: ["P95下降40%。"],
  },
  materials: [
    { title: "当前访谈", content: "缓存模块由后端同事实现。当前访谈没有说明P95是否有测量记录，需核对。" },
    { title: "交付记录", content: "本人补充并交付运行手册。" },
  ],
};
