import { expect, it, vi } from "vitest";

import { collectByCharacterBudget } from "../budgeted-query";

type Row = { id: number; text: string };

const cursorOf = (row: Row) => row.id;
const format = (row: Row) => row.text;

it("does not load rows when the character budget is zero", async () => {
  const loadAfter = vi.fn((): Row[] => [{ id: 1, text: "unused" }]);

  await expect(collectByCharacterBudget({ maxChars: 0, batchSize: 5, loadAfter, cursorOf, format }))
    .resolves.toEqual([]);
  expect(loadAfter).not.toHaveBeenCalled();
});

it("loads asynchronous batches by cursor until the budget is exactly exhausted", async () => {
  const loadAfter = vi.fn(async (cursor: number): Promise<Row[]> => {
    if (cursor === 0) return [{ id: 2, text: "ab" }, { id: 5, text: "c" }];
    if (cursor === 5) return [{ id: 9, text: "de" }];
    return [];
  });

  await expect(collectByCharacterBudget({ maxChars: 5, batchSize: 2, loadAfter, cursorOf, format }))
    .resolves.toEqual(["ab", "c", "de"]);
  expect(loadAfter.mock.calls).toEqual([[0, 2], [5, 2]]);
});

it("advances through empty formatted rows until the loader returns an empty batch", async () => {
  const loadAfter = vi.fn((cursor: number): Row[] => {
    if (cursor === 0) return [{ id: 2, text: "" }];
    if (cursor === 2) return [{ id: 5, text: "" }];
    return [];
  });

  await expect(collectByCharacterBudget({ maxChars: 1, batchSize: 1, loadAfter, cursorOf, format }))
    .resolves.toEqual(["", ""]);
  expect(loadAfter.mock.calls).toEqual([[0, 1], [2, 1], [5, 1]]);
});

it("adds only the prefix that fits in the remaining budget and then stops", async () => {
  const loadAfter = vi.fn((): Row[] => [
    { id: 1, text: "abc" },
    { id: 2, text: "defgh" },
  ]);

  await expect(collectByCharacterBudget({ maxChars: 5, batchSize: 3, loadAfter, cursorOf, format }))
    .resolves.toEqual(["abc", "de"]);
  expect(loadAfter.mock.calls).toEqual([[0, 3]]);
});

it("truncates an oversized first row and does not load another batch", async () => {
  const loadAfter = vi.fn((): Row[] => [{ id: 1, text: "abcdef" }]);

  await expect(collectByCharacterBudget({ maxChars: 3, batchSize: 2, loadAfter, cursorOf, format }))
    .resolves.toEqual(["abc"]);
  expect(loadAfter.mock.calls).toEqual([[0, 2]]);
});

it("stops formatting and loading when a row exactly exhausts the budget", async () => {
  const rows: Row[] = [
    { id: 1, text: "ab" },
    { id: 2, text: "cd" },
    { id: 3, text: "unused" },
  ];
  const loadAfter = vi.fn((): Row[] => rows);
  const formatRow = vi.fn(format);

  await expect(collectByCharacterBudget({ maxChars: 4, batchSize: 3, loadAfter, cursorOf, format: formatRow }))
    .resolves.toEqual(["ab", "cd"]);
  expect(formatRow.mock.calls).toEqual([[rows[0]], [rows[1]]]);
  expect(loadAfter.mock.calls).toEqual([[0, 3]]);
});

it("stops immediately when a batch is empty", async () => {
  const loadAfter = vi.fn((): Row[] => []);

  await expect(collectByCharacterBudget({ maxChars: 10, batchSize: 4, loadAfter, cursorOf, format }))
    .resolves.toEqual([]);
  expect(loadAfter.mock.calls).toEqual([[0, 4]]);
});

it("rejects when a row cursor does not advance strictly", async () => {
  const loadAfter = vi.fn((): Row[] => [
    { id: 1, text: "a" },
    { id: 1, text: "b" },
  ]);

  await expect(collectByCharacterBudget({ maxChars: 10, batchSize: 2, loadAfter, cursorOf, format }))
    .rejects.toThrow(/cursor must advance strictly/i);
  expect(loadAfter.mock.calls).toEqual([[0, 2]]);
});

it("rejects a NaN row cursor as not strictly advancing", async () => {
  const loadAfter = vi.fn((): Row[] => [{ id: Number.NaN, text: "a" }]);

  await expect(collectByCharacterBudget({ maxChars: 2, batchSize: 1, loadAfter, cursorOf, format }))
    .rejects.toThrow(/cursor must advance strictly/i);
  expect(loadAfter.mock.calls).toEqual([[0, 1]]);
});
