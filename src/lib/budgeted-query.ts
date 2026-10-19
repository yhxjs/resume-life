export async function collectByCharacterBudget<Row>(options: {
  maxChars: number;
  batchSize: number;
  loadAfter(cursor: number, limit: number): Row[] | Promise<Row[]>;
  cursorOf(row: Row): number;
  format(row: Row): string;
}): Promise<string[]> {
  const result: string[] = [];
  let cursor = 0;
  let usedChars = 0;

  while (usedChars < options.maxChars) {
    const rows = await options.loadAfter(cursor, options.batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      const nextCursor = options.cursorOf(row);
      if (!(nextCursor > cursor)) throw new Error("Cursor must advance strictly");
      cursor = nextCursor;

      const formatted = options.format(row);
      const remaining = options.maxChars - usedChars;
      if (formatted.length > remaining) {
        result.push(formatted.slice(0, remaining));
        return result;
      }

      result.push(formatted);
      usedChars += formatted.length;
      if (usedChars === options.maxChars) return result;
    }
  }

  return result;
}
