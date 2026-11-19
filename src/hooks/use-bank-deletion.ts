"use client";

import { useRecordDeletion } from "@/hooks/use-record-deletion";
import { BANK_KINDS, readBankEntry, type BankEntry } from "@/lib/bank";

export function useBankDeletion(onDeleted: () => void) {
  const deletion = useRecordDeletion({
    baseUrl: "/api/bank",
    confirmTitle: "删除题目",
    confirmMessage: (id, title) => `确定从题库删除题目 #${id}「${title}」？`,
    validateExisting: readBankEntry,
    recordLabel: "题目",
    listLabel: "题库列表",
  }, onDeleted);
  return { ...deletion, remove: (entry: BankEntry) => deletion.remove(entry.id,
    `${entry.question}；方向：${entry.direction || "未指定方向"}；题型：${BANK_KINDS.find(kind => kind.key === entry.kind)?.label ?? entry.kind}`) };
}
