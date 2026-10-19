import { describe, expect, it } from "vitest";
import {
  buildIcsCalendar,
  buildValarmBlock,
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
} from "../ics-calendar";

describe("RFC 5545 iCalendar (ICS) 生成器单元测试", () => {
  it("formatIcsDate 能够正确将 Date 输出为标准 UTC 时间字符串", () => {
    const d = new Date("2026-09-29T14:30:00.000Z");
    expect(formatIcsDate(d)).toBe("20260929T143000Z");
  });

  it("escapeIcsText 正确转义反斜杠、分号、逗号与换行符", () => {
    const raw = "第一点; 第二点, 请注意\\重点:\n换行内容";
    const escaped = escapeIcsText(raw);
    expect(escaped).toBe("第一点\\; 第二点\\, 请注意\\\\重点:\\n换行内容");
  });

  it("foldIcsLine 在超过 75 字节时进行标准行折叠并在续行行首插入空格", () => {
    // 构造超长字符串
    const longText = "DESCRIPTION:" + "这是一段非常长非常长的中文面试描述内容，用来测试iCalendar行折叠规范".repeat(4);
    const folded = foldIcsLine(longText);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    // 第一行 <= 75 字节
    expect(Buffer.from(lines[0]!, "utf8").length).toBeLessThanOrEqual(75);
    // 第二行首字符必为空格，且总长度 <= 75 字节
    expect(lines[1]!.startsWith(" ")).toBe(true);
    expect(Buffer.from(lines[1]!, "utf8").length).toBeLessThanOrEqual(75);
    // 去掉换行与续行空格后内容应与原文本相同
    const reconstructed = lines[0]! + lines.slice(1).map((l) => l.slice(1)).join("");
    expect(reconstructed).toBe(longText);
  });

  it("buildValarmBlock 能正确生成不同时长的 VALARM 触发器", () => {
    expect(buildValarmBlock(0, "测试")).toEqual([]);

    const alarm15 = buildValarmBlock(15, "技术一面").join("\r\n");
    expect(alarm15).toContain("BEGIN:VALARM");
    expect(alarm15).toContain("TRIGGER:-PT15M");
    expect(alarm15).toContain("ACTION:DISPLAY");
    expect(alarm15).toContain("END:VALARM");

    const alarm60 = buildValarmBlock(60, "HR面").join("\r\n");
    expect(alarm60).toContain("TRIGGER:-PT1H");

    const alarm1440 = buildValarmBlock(1440, "终面").join("\r\n");
    expect(alarm1440).toContain("TRIGGER:-P1D");
  });

  it("buildIcsCalendar 输出完整的 VCALENDAR 与 VEVENT 结构，严格使用 CRLF 换行", () => {
    const start = new Date("2026-09-30T10:00:00.000Z");
    const end = new Date("2026-09-30T11:00:00.000Z");
    const ics = buildIcsCalendar({
      calendarName: "我的求职面试",
      events: [
        {
          uid: "interview-123",
          title: "腾讯 · 前端研发架构师一面",
          description: "带上作品集，重点准备分布式与前端工程化",
          location: "腾讯会议 (ID: 123-456-789)",
          url: "https://meeting.tencent.com/dm/test",
          startTime: start,
          endTime: end,
          reminderMinutes: 30,
        },
      ],
      todos: [
        {
          uid: "todo-456",
          title: "复习 SSR 与 Node.js 事件循环机制",
          dueTime: new Date("2026-09-30T09:00:00.000Z"),
        },
      ],
    });

    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("X-WR-CALNAME:我的求职面试");
    expect(ics).toContain("UID:interview-123");
    expect(ics).toContain("SUMMARY:腾讯 · 前端研发架构师一面");
    expect(ics).toContain("LOCATION:腾讯会议 (ID: 123-456-789)");
    expect(ics).toContain("URL:https://meeting.tencent.com/dm/test");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("SUMMARY:[准备待办] 复习 SSR 与 Node.js 事件循环机制");

    // 验证所有换行符均严格为 \r\n，且无独立 \n
    const crlfCount = (ics.match(/\r\n/g) || []).length;
    const lfCount = (ics.match(/\n/g) || []).length;
    expect(crlfCount).toBe(lfCount);
  });
});
