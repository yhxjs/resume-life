"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { resumeDeletionTitle, validateExistingResume, type ResumeListItem } from "@/lib/resume-history";

export function useResumeDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/resumes", confirmTitle: "删除简历",
    confirmMessage: (id, title) => `确定删除简历 #${id}「${title}」？草稿及全部模块、已发布版本、诊断、自我介绍及两版内容、单场与进阶面试及作答会一并删除，无法恢复。投递与已提交快照、独立收藏错题及复习历史、已生成追练和简历排雷记录继续保留，关联到被删记录的引用会解除。`,
    validateExisting: validateExistingResume, recordLabel: "简历", listLabel: "简历目录",
  }, onDeleted);
  return { ...deletion, remove: (item: ResumeListItem) => deletion.remove(item.id, resumeDeletionTitle(item)) };
}
