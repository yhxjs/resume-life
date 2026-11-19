"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { projectDeletionTitle, validateExistingProject, type ProjectListItem } from "@/lib/project-history";

export function useProjectDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/projects", confirmTitle: "删除项目",
    confirmMessage: (id, title) => `确定删除项目 #${id}「${title}」？全部材料、总结及总结历史、项目练习及作答、直接关联练习题的复习卡片与复习历史会一并删除，无法恢复。独立收藏的错题快照及其复习历史、已摘取到简历的内容继续保留。`,
    validateExisting: validateExistingProject, recordLabel: "项目", listLabel: "项目目录",
  }, onDeleted);
  return { ...deletion, remove: (item: ProjectListItem) => deletion.remove(item.id, projectDeletionTitle(item)) };
}
