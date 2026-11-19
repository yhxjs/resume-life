"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { drillDeletionTitle, validateExistingDrill, type DrillItem } from "@/lib/drill-history";

export function useDrillDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/drills",
    confirmTitle: "删除练习",
    confirmMessage: (id, title) => `确定删除练习 #${id}「${title}」？该练习的全部题目、原始作答、批改及直接关联的复习记录将一并删除；已收藏到错题本的快照及其复习记录仍保留。`,
    validateExisting: validateExistingDrill,
    recordLabel: "练习",
    listLabel: "练习列表",
  }, onDeleted);
  return { ...deletion, remove: (drill: DrillItem) => deletion.remove(drill.id, drillDeletionTitle(drill)) };
}
