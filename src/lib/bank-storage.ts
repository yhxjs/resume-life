import { getDb, inTransaction, now } from "@/lib/db";
import type { BankEntry } from "@/lib/bank";

/** 持久层与客户端共用的 bank 协议分离，防止把 SQLite 带进浏览器。 */
export function loadBankEntry(id: number): BankEntry | undefined {
  return getDb().prepare("SELECT id, direction, kind, question, created_at FROM bank_entries WHERE id = ?").get(id) as BankEntry | undefined;
}

/** Callers validate the import and choose any duplicate policy before this shared atomic insert. */
export function insertBankQuestions(direction: string, kind: string, questions: string[]): number[] {
  return inTransaction(() => {
    const insert = getDb().prepare("INSERT INTO bank_entries(direction,kind,question,created_at) VALUES(?,?,?,?)");
    const timestamp = now();
    return questions.map(question => Number(insert.run(direction, kind, question, timestamp).lastInsertRowid));
  });
}
