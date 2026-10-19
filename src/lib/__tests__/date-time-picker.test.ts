import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDateTimeString,
  pad,
  parseDateTime,
} from "@/components/common/date-time-picker";
import { formatFriendlyDateTime, fromLocalDateTime, toLocalDateTime } from "@/lib/application-datetime";

describe("DateTimePicker utilities", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["2026-10-11T23:45", "2026-10-12T00:00"],
    ["2026-10-31T23:30", "2026-11-01T00:00"],
    ["2026-12-31T23:59", "2027-01-01T00:00"],
    ["2026-10-11T14:15", "2026-10-11T14:30"],
    ["2026-10-11T14:45", "2026-10-11T15:00"],
  ])("空值默认时间从 %s 推进到 %s", (current, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(current));
    const parsed = parseDateTime("");
    expect(buildDateTimeString(parsed, parsed.hour, parsed.minute)).toBe(expected);
  });

  it("pad: 前置补齐两位数字", () => {
    expect(pad(0)).toBe("00");
    expect(pad(5)).toBe("05");
    expect(pad(12)).toBe("12");
  });

  it("parseDateTime: 正确解析 YYYY-MM-DDTHH:mm 本地格式", () => {
    const parsed = parseDateTime("2026-09-24T14:30");
    expect(parsed.year).toBe(2026);
    expect(parsed.month).toBe(8); // 0-based: 8 代表 9 月
    expect(parsed.day).toBe(24);
    expect(parsed.hour).toBe("14");
    expect(parsed.minute).toBe("30");
  });

  it("parseDateTime: 解析带 Z 的 ISO UTC 字符串时，自动转为本地时区时间", () => {
    // 假设一个 UTC 时间点
    const isoUtc = "2026-09-24T06:30:00.000Z";
    const d = new Date(isoUtc);
    const parsed = parseDateTime(isoUtc);

    // 解析出的小时和日期必须与本地时区一致，而非原始 UTC 的 06
    expect(parsed.hour).toBe(pad(d.getHours()));
    expect(parsed.minute).toBe(pad(d.getMinutes()));
    expect(parsed.day).toBe(d.getDate());
    expect(parsed.month).toBe(d.getMonth());
    expect(parsed.year).toBe(d.getFullYear());
  });

  it("parseDateTime: 处理空值或非法字符串时回退到默认当前时刻", () => {
    const emptyParsed = parseDateTime("");
    expect(emptyParsed.year).toBeGreaterThanOrEqual(2026);
    expect(Number(emptyParsed.hour)).toBeGreaterThanOrEqual(0);
    expect(Number(emptyParsed.hour)).toBeLessThanOrEqual(23);
    expect(["00", "30"]).toContain(emptyParsed.minute);
  });

  it("buildDateTimeString: 正确组合年月日与时分，满足 ISO local 规范", () => {
    const dt = buildDateTimeString({ year: 2026, month: 8, day: 25 }, "10", "15");
    expect(dt).toBe("2026-09-25T10:15");
  });

  it("buildDateTimeString 与 fromLocalDateTime/toLocalDateTime 互转相容", () => {
    const dt = buildDateTimeString({ year: 2026, month: 11, day: 31 }, "23", "55");
    expect(dt).toBe("2026-12-31T23:55");

    const iso = fromLocalDateTime(dt);
    expect(iso).toBeTruthy();
    expect(toLocalDateTime(iso)).toBe(dt);
  });

  it("formatFriendlyDateTime: 输出本地友好格式且不带 T 或 Z", () => {
    const isoUtc = "2026-09-24T06:30:00.000Z";
    const localFriendly = formatFriendlyDateTime(isoUtc);
    const d = new Date(isoUtc);
    expect(localFriendly).toBe(`${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    expect(localFriendly).not.toContain("T");
    expect(localFriendly).not.toContain("Z");
  });
});
