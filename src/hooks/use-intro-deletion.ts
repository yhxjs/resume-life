"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { introDeletionTitle, validateExistingIntro, type IntroListItem } from "@/lib/intro-history";

export function useIntroDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/intros",
    confirmTitle: "删除自我介绍",
    confirmMessage: (id, title) => `确定删除自我介绍 #${id}「${title}」？该记录的两版介绍与逐句点评将一并删除。`,
    validateExisting: validateExistingIntro,
    recordLabel: "自我介绍",
    listLabel: "自我介绍历史",
  }, onDeleted);
  return { ...deletion, remove: (item: IntroListItem) => deletion.remove(item.id, introDeletionTitle(item)) };
}
