import { getDb, inTransaction, now } from "./db";
import type { JargonDecoderResult } from "./jargon-decoder";

export function createJargonDecoding(sourceText: string, result: JargonDecoderResult) {
  return inTransaction(() => Number(getDb().prepare("INSERT INTO jargon_decodings(source_text,result,created_at) VALUES(?,?,?)")
    .run(sourceText, JSON.stringify(result), now()).lastInsertRowid));
}
