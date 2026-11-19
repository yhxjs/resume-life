"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { notebookDeletionTitle, validateExistingNotebookEntry, type NotebookDeletionTarget } from "@/lib/notebook-records";

export function useNotebookDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/notebook",
    confirmTitle: "移出错题本",
    confirmText: "移出",
    confirmMessage: (id, title) => `确定将错题 #${id}「${title}」移出错题本？收藏快照、对应复习卡、复习历史及求职准备关联将一并删除。不会删除来源记录；来源记录可能已被删除，这份快照可能是唯一副本。`,
    validateExisting: validateExistingNotebookEntry,
    recordLabel: "错题",
    listLabel: "错题列表及分类统计",
  }, onDeleted);
  return { ...deletion, remove: (entry: NotebookDeletionTarget) => deletion.remove(entry.id, notebookDeletionTitle(entry)) };
}
