import { describe, expect, it } from "vitest";
import { parseCanonicalPositiveId, parseCanonicalStoredId } from "../id-parsing";

describe("parseCanonicalPositiveId", () => {
  it("accepts canonical positive safe decimal IDs", () => {
    expect(parseCanonicalPositiveId("1")).toBe(1);
    expect(parseCanonicalPositiveId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["", "0", "-1", "+1", "01", "1e0", "0x1", " 1", "1 ", "1\n", "1\r\n", "1\t", "１", "١", "1.0", "9007199254740992", null, 1])(
    "rejects %j without aliasing a real record",
    value => expect(Number.isNaN(parseCanonicalPositiveId(value))).toBe(true),
  );
});

describe("历史记录的规范编号", () => {
  it.each([0, -1, Number.MIN_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER])("保留 %i 的身份", id => {
    expect(parseCanonicalStoredId(String(id))).toBe(id);
  });
  it.each(["-0", "-01", "01", "+1", "-1.0", "-1e0", "-1\n", "-9007199254740992", "", null])("拒绝别名或越界值 %j", value => {
    expect(parseCanonicalStoredId(value)).toBeNaN();
  });
});
