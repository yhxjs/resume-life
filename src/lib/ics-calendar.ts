/**
 * RFC 5545 iCalendar (.ics) 日历格式生成器
 * 纯函数实现，无外部第三方依赖，严格遵守 CRLF 换行、75 字节 Line Folding 与特殊字符转义规范。
 */

export interface IcsEventOptions {
  uid: string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  startTime: Date;
  endTime?: Date; // 缺省默认为 startTime + 60 分钟
  reminderMinutes?: number; // 提前提醒分钟数，<= 0 不生成 VALARM 提醒
  status?: "CONFIRMED" | "CANCELLED" | "TENTATIVE";
}

export interface IcsTodoOptions {
  uid: string;
  title: string;
  description?: string;
  dueTime: Date;
  completed?: boolean;
}

/**
 * 将 Date 格式化为 iCalendar 标准 UTC 时间串：YYYYMMDDTHHMMSSZ
 */
export function formatIcsDate(date: Date): string {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * 根据 RFC 5545 对文本内容进行转义：
 * 反斜杠 \ -> \\
 * 分号 ; -> \;
 * 逗号 , -> \,
 * 换行符 -> \n
 */
export function escapeIcsText(text: string): string {
  if (!text) return "";
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 75 字节折行算法 (Line Folding)
 * 单行超过 75 字节时，在 75 字节处断行，并在续行前置一个空格（空格占用 1 字节，续行最长 74 字节）。
 * 必须防止断在多字节 UTF-8 字符的内部。
 */
export function foldIcsLine(line: string): string {
  const maxBytes = 75;
  const buffer = Buffer.from(line, "utf8");
  if (buffer.length <= maxBytes) return line;

  const resultLines: string[] = [];
  let offset = 0;
  let isFirst = true;

  while (offset < buffer.length) {
    const limit = isFirst ? maxBytes : maxBytes - 1; // 续行行首带空格
    let sliceEnd = Math.min(offset + limit, buffer.length);

    // 下一字节若为 UTF-8 续字节，边界仍在码点内部；合法 U+FFFD 不应被当成解码错误。
    while (sliceEnd < buffer.length && (buffer[sliceEnd]! & 0xc0) === 0x80) {
      sliceEnd -= 1;
    }
    const str = buffer.subarray(offset, sliceEnd).toString("utf8");

    resultLines.push(isFirst ? str : ` ${str}`);
    offset = sliceEnd;
    isFirst = false;
  }

  return resultLines.join("\r\n");
}

/**
 * 构造 VALARM 提前提醒闹钟块
 */
export function buildValarmBlock(reminderMinutes: number, title: string): string[] {
  if (reminderMinutes <= 0) return [];

  let triggerDuration: string;
  if (reminderMinutes % 1440 === 0) {
    triggerDuration = `-P${reminderMinutes / 1440}D`;
  } else if (reminderMinutes % 60 === 0) {
    triggerDuration = `-PT${reminderMinutes / 60}H`;
  } else {
    triggerDuration = `-PT${reminderMinutes}M`;
  }

  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(`【面试日程提醒】${title}`)}`,
    `TRIGGER:${triggerDuration}`,
    "END:VALARM",
  ];
}

/**
 * 构建完整的 RFC 5545 iCalendar 内容文本
 */
export function buildIcsCalendar(options: {
  calendarName?: string;
  events: IcsEventOptions[];
  todos?: IcsTodoOptions[];
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Resume Life//Interview Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName || "求职面试日程")}`,
  ];

  const nowStamp = formatIcsDate(new Date());

  for (const evt of options.events) {
    const startStr = formatIcsDate(evt.startTime);
    if (!startStr) continue;
    const end = evt.endTime || new Date(evt.startTime.getTime() + 60 * 60 * 1000);
    const endStr = formatIcsDate(end);

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${evt.uid}`);
    lines.push(`DTSTAMP:${nowStamp}`);
    lines.push(`DTSTART:${startStr}`);
    lines.push(`DTEND:${endStr}`);
    lines.push(`SUMMARY:${escapeIcsText(evt.title)}`);

    if (evt.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(evt.description)}`);
    }
    if (evt.location) {
      lines.push(`LOCATION:${escapeIcsText(evt.location)}`);
    }
    if (evt.url) {
      lines.push(`URL:${escapeIcsText(evt.url)}`);
    }
    lines.push(`STATUS:${evt.status || "CONFIRMED"}`);

    if (evt.reminderMinutes && evt.reminderMinutes > 0) {
      lines.push(...buildValarmBlock(evt.reminderMinutes, evt.title));
    }
    lines.push("END:VEVENT");
  }

  if (options.todos && options.todos.length > 0) {
    for (const todo of options.todos) {
      const dueStr = formatIcsDate(todo.dueTime);
      if (!dueStr) continue;
      // 待办在截止前 30 分钟到截止时刻作为一个备忘事项区间
      const todoStart = new Date(todo.dueTime.getTime() - 30 * 60 * 1000);
      const startStr = formatIcsDate(todoStart);

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${todo.uid}`);
      lines.push(`DTSTAMP:${nowStamp}`);
      lines.push(`DTSTART:${startStr}`);
      lines.push(`DTEND:${dueStr}`);
      lines.push(`SUMMARY:${escapeIcsText(`[准备待办] ${todo.title}`)}`);
      if (todo.description) {
        lines.push(`DESCRIPTION:${escapeIcsText(todo.description)}`);
      }
      // 待办到期前 15 分钟触发提醒
      lines.push(...buildValarmBlock(15, `准备待办截止：${todo.title}`));
      lines.push("END:VEVENT");
    }
  }

  lines.push("END:VCALENDAR");

  // 对所有行执行折行处理并以 CRLF 规范拼接
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * 浏览器端触发 ICS 文本文件下载
 */
export function downloadIcsFile(filename: string, icsContent: string): void {
  if (typeof window === "undefined" || !document) return;
  const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename.endsWith(".ics") ? filename : `${filename}.ics`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
