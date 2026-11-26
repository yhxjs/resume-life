import { expect, it } from "vitest";
import { threeWayMerge, type Json } from "./mcp-rebase-merge";

it("merges disjoint fields and distinguishes missing from null without mutating inputs", () => {
  const b = { a: 1, b: 2, nullable: null }, p = { a: 3, b: 2 }, c = { a: 1, b: 4, nullable: null };
  expect(threeWayMerge(b, p, c)).toMatchObject({ value: { a: 3, b: 4 }, conflicts: [], unresolved: 0 });
  expect(b).toEqual({ a: 1, b: 2, nullable: null });
});
it("compares ID arrays by identity and preserves concurrent additions and nested subitem edits", () => {
  const b = [{ id: "a", x: 1, subItems: [{ id: "s", value: "base", label: "base" }] }];
  const p: Json = [{ id: "a", x: 2, subItems: [{ id: "s", value: "mine", label: "base" }] }, { id: "b", x: 1 }];
  const c: Json = [{ id: "c", x: 1 }, { id: "a", x: 1, subItems: [{ id: "s", value: "base", label: "web" }] }];
  expect(threeWayMerge(b, p, c)).toMatchObject({ unresolved: 0, value: [{ id: "c" }, { id: "a", x: 2, subItems: [{ id: "s", value: "mine", label: "web" }] }, { id: "b" }] });
});
it("reports delete/edit including a missing current value and resolves by stable ID", () => {
  const b = [{ id: "a", x: 1 }], p = [{ id: "a", x: 2 }], c: never[] = [];
  const r = threeWayMerge(b, p, c);
  expect(r.conflicts[0]).toMatchObject({ path: ["@id:a"], reason: "delete-edit", current: { present: false } });
  expect(threeWayMerge(b, p, c, [{ path: ["@id:a"], take: "proposed" }]).value).toEqual(p);
});
it("requires explicit choices for conflicting reorder, primitive arrays, module types and metadata", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  expect(threeWayMerge([a, b, c], [b, a, c], [a, c, b]).conflicts[0]!.reason).toBe("array-order");
  expect(threeWayMerge(["a"], ["a", "b"], ["c"]).unresolved).toBe(1);
  expect(threeWayMerge({ type: "basic", content: {} }, { type: "skills", content: [] }, { type: "basic", content: { name: "web" } }).conflicts[0]!.reason).toBe("module-type");
  expect(threeWayMerge({ meta: 0 }, { meta: 1 }, { meta: 2 }).unresolved).toBe(1);
});
it("rejects duplicate IDs even on fast paths, unknown choices and duplicate choices", () => {
  expect(() => threeWayMerge([], [{ id: "a" }, { id: "a" }], [])).toThrow(/ID/);
  expect(() => threeWayMerge({}, {}, {}, [{ path: ["x"], take: "base" }])).toThrow(/路径/);
  expect(() => threeWayMerge(0, 1, 2, [{ path: [], take: "base" }, { path: [], take: "current" }])).toThrow(/重复/);
});
it("handles prototype-like keys as inert own fields", () => {
  const b = JSON.parse('{"__proto__":{"name":"base"},"constructor":1}');
  const p = JSON.parse('{"__proto__":{"name":"mine"},"constructor":1}');
  const c = JSON.parse('{"__proto__":{"name":"base"},"constructor":2}');
  expect(JSON.stringify(threeWayMerge(b, p, c).value)).toBe('{"__proto__":{"name":"mine"},"constructor":2}');
  expect(({} as Record<string, unknown>).name).toBeUndefined();
});

it("reports conflicting placement of the same concurrently inserted stable ID", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  const result = threeWayMerge([a, c], [a, b, c], [b, a, c]);
  expect(result.conflicts).toMatchObject([{ path: ["$order"], reason: "array-order" }]);
  expect(threeWayMerge([a, c], [a, b, c], [b, a, c], [{ path: ["$order"], take: "proposed" }]).value).toEqual([a, b, c]);
});
