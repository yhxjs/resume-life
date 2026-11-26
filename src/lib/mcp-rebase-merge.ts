/** Pure three-way JSON merge. Missing is distinct from null; arrays without stable IDs are atomic. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type MergeValue = { present: false } | { present: true; value: Json };
export type MergeChoice = { path: string[]; take: "base" | "proposed" | "current" };
export type MergeConflict = { path: string[]; reason: string; base: MergeValue; proposed: MergeValue; current: MergeValue; resolution: MergeChoice["take"] | null };
const missing = Symbol("missing");
type Value = Json | typeof missing;
const object = (v: Value | undefined): v is { [key: string]: Json } => v !== missing && v !== null && typeof v === "object" && !Array.isArray(v);
export function sameJson(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
  return false;
}
const shown = (v: Value): MergeValue => v === missing ? { present: false } : { present: true, value: v };

export function threeWayMerge(base: Json, proposed: Json, current: Json, choices: MergeChoice[] = [], atomicPaths: string[][] = []) {
  function validate(value: Json) {
    if (Array.isArray(value)) {
      for (const key of ["id", "key"]) if (value.length && value.every(v => object(v) && typeof v[key] === "string")) {
        const ids = value.map(v => (v as Record<string, Json>)[key]);
        if (new Set(ids).size !== ids.length) throw new Error("数组稳定 ID 重复，不能合并");
      }
      value.forEach(validate);
    } else if (object(value)) Object.values(value).forEach(validate);
  }
  [base, proposed, current].forEach(validate);
  const conflicts: MergeConflict[] = [], consumed = new Set<string>();
  const selections = new Map(choices.map(c => [JSON.stringify(c.path), c.take]));
  if (selections.size !== choices.length) throw new Error("同一冲突路径不能重复选择");
  const atomic = new Set(atomicPaths.map(p => JSON.stringify(p)));
  function conflict(b: Value, p: Value, c: Value, path: string[], reason: string): Value {
    const key = JSON.stringify(path), take = selections.get(key) ?? null;
    if (take) consumed.add(key);
    conflicts.push({ path, reason, base: shown(b), proposed: shown(p), current: shown(c), resolution: take });
    return take === "base" ? b : take === "proposed" ? p : c;
  }
  function merge(b: Value, p: Value, c: Value, path: string[]): Value {
    if (sameJson(p, b) || sameJson(p, c)) return c;
    if (sameJson(c, b)) return p;
    if (atomic.has(JSON.stringify(path))) return conflict(b, p, c, path, "coupled-fields");
    if (object(b) && object(p) && object(c)) {
      // A discriminant change and an edit of the old structure must never produce a hybrid module.
      if (Object.hasOwn(b, "type") && (!sameJson(b.type, p.type) || !sameJson(b.type, c.type))) return conflict(b, p, c, path, "module-type");
      const out: Record<string, Json> = Object.create(null);
      for (const k of new Set([...Object.keys(b), ...Object.keys(p), ...Object.keys(c)])) {
        const v = merge(Object.hasOwn(b, k) ? b[k]! : missing, Object.hasOwn(p, k) ? p[k]! : missing, Object.hasOwn(c, k) ? c[k]! : missing, [...path, k]);
        if (v !== missing) out[k] = v;
      }
      return out;
    }
    if (Array.isArray(b) && Array.isArray(p) && Array.isArray(c)) {
      const all = [...b, ...p, ...c];
      const key = ["id", "key"].find(k => all.length > 0 && all.every(v => object(v) && typeof v[k] === "string"));
      if (key) {
        const ids = (v: Json[]) => v.map(row => (row as Record<string, Json>)[key] as string);
        const [bi, pi, ci] = [ids(b), ids(p), ids(c)];
        if ([bi, pi, ci].some(a => new Set(a).size !== a.length)) throw new Error("数组稳定 ID 重复，不能合并");
        const maps = [b, p, c].map(a => new Map(a.map(row => [(row as Record<string, Json>)[key] as string, row])));
        const out = new Map<string, Json>();
        for (const id of new Set([...bi, ...pi, ...ci])) {
          const v = merge(maps[0]!.get(id) ?? missing, maps[1]!.get(id) ?? missing, maps[2]!.get(id) ?? missing, [...path, `@${key}:${id}`]);
          if (v !== missing) out.set(id, v);
        }
        // Membership is handled above. Compare relative order of surviving original IDs separately.
        const common = bi.filter(id => pi.includes(id) && ci.includes(id) && out.has(id));
        const relative = (a: string[]) => a.filter(id => common.includes(id));
        let preferred = sameJson(relative(pi), common) ? ci : pi;
        const shared = pi.filter(id => ci.includes(id) && out.has(id));
        const sharedInCurrent = ci.filter(id => shared.includes(id));
        // The same new ID inserted at different anchors is also a real order conflict.
        const concurrentPlacement = shared.some(id => !bi.includes(id)) && !sameJson(shared, sharedInCurrent);
        if (concurrentPlacement || (!sameJson(relative(pi), common) && !sameJson(relative(ci), common) && !sameJson(relative(pi), relative(ci)))) {
          preferred = conflict(bi, pi, ci, [...path, "$order"], "array-order") as string[];
        }
        const order = preferred.filter(id => out.has(id));
        // Insert additions beside their nearest predecessor/successor, never drop unchosen IDs.
        for (const sequence of [ci, pi, bi]) for (let i = 0; i < sequence.length; i++) {
          const id = sequence[i]!;
          if (!out.has(id) || order.includes(id)) continue;
          const before = sequence.slice(0, i).reverse().find(v => order.includes(v));
          const after = sequence.slice(i + 1).find(v => order.includes(v));
          order.splice(before ? order.indexOf(before) + 1 : after ? order.indexOf(after) : order.length, 0, id);
        }
        return order.map(id => out.get(id)!);
      }
    }
    return conflict(b, p, c, path, b === missing ? "concurrent-add" : p === missing || c === missing ? "delete-edit" : "same-field");
  }
  const value = merge(base, proposed, current, []) as Json;
  if (consumed.size !== choices.length) throw new Error("冲突已变化或选择路径不存在，请重新比较");
  return { value, conflicts, unresolved: conflicts.filter(c => c.resolution === null).length };
}
