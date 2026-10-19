import { afterAll, describe, expect, it } from "vitest";
import { fromLocalDateTime, toLocalDateTime } from "@/lib/application-datetime";

const originalTZ = process.env.TZ;
afterAll(() => { process.env.TZ = originalTZ; });

describe.each([
  ["Asia/Shanghai", "2026-09-16T02:00:37.123Z", "2026-09-16T10:00"],
  ["UTC", "2026-09-16T02:00:37.123Z", "2026-09-16T02:00"],
  ["America/New_York", "2026-07-16T14:00:37.123Z", "2026-07-16T10:00"],
  ["America/New_York", "2026-11-01T06:30:37.123Z", "2026-11-01T01:30"],
])("datetime-local in %s", (timezone, original, display) => {
  it("shows local clock time and preserves untouched seconds and DST occurrence", () => {
    process.env.TZ = timezone;
    expect(toLocalDateTime(original)).toBe(display);
    expect(fromLocalDateTime(display, original)).toBe(original);
  });
});

it("converts an edited local value to UTC and permits clearing the schedule", () => {
  process.env.TZ = "Asia/Shanghai";
  expect(fromLocalDateTime("2026-09-16T11:15", "2026-09-16T02:00:00.000Z"))
    .toBe("2026-09-16T03:15:00.000Z");
  expect(toLocalDateTime("")).toBe("");
  expect(fromLocalDateTime("", "2026-09-16T02:00:00.000Z")).toBe("");
});

it("rejects invalid dates and nonexistent local times in a DST gap", () => {
  process.env.TZ = "America/New_York";
  for (const value of ["invalid", "2026-02-30T12:00", "2026-03-08T02:30"]) {
    expect(() => fromLocalDateTime(value)).toThrow("面试时间");
  }
});
