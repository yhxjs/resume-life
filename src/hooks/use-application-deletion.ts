"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { applicationDeletionTitle, validateExistingApplication } from "@/lib/application-deletion";
import type { Application } from "@/lib/applications-types";

export function useApplicationDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/applications", confirmTitle: "确认删除投递记录？", confirmText: "确认删除",
    confirmMessage: (id, title) => `确定删除投递 #${id}「${title}」？投递快照、阶段履历、全部真实面试轮次及逐题记录、复盘及导出关联、准备待办与资料关联会一并删除，无法恢复。简历及发布版、独立模拟面试、自我介绍、诊断、JD 画像、收藏错题、复习历史与已生成追练继续保留。`,
    validateExisting: validateExistingApplication, recordLabel: "投递", listLabel: "求职看板与统计",
  }, onDeleted);
  return { ...deletion, remove: (app: Application) => deletion.remove(app.id, applicationDeletionTitle(app)) };
}
