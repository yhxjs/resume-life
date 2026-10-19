export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  total?: number;
};

export type UpdatedAtCursor = {
  updatedAt: string;
  id: number;
};

export class InvalidPaginationParameterError extends Error {}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const days = daysInMonth[month - 1];
  return days !== undefined && day <= days;
}

function isValidUpdatedAt(value: string): boolean {
  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    return isValidCalendarDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  }

  const timestamp = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!timestamp) return false;
  return (
    isValidCalendarDate(Number(timestamp[1]), Number(timestamp[2]), Number(timestamp[3])) &&
    Number(timestamp[4]) <= 23 &&
    Number(timestamp[5]) <= 59 &&
    Number(timestamp[6]) <= 59
  );
}

export function parsePageLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get("limit");
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(raw)) throw new InvalidPaginationParameterError("limit 参数无效");

  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new InvalidPaginationParameterError("limit 参数无效");
  }
  return limit;
}

export function parseIdCursor(searchParams: URLSearchParams): number | null {
  const raw = searchParams.get("cursor");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new InvalidPaginationParameterError("cursor 参数无效");

  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new InvalidPaginationParameterError("cursor 参数无效");
  }
  return cursor;
}

export function encodeUpdatedAtCursor(cursor: UpdatedAtCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseUpdatedAtCursor(searchParams: URLSearchParams): UpdatedAtCursor | null {
  const raw = searchParams.get("cursor");
  if (raw === null) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new InvalidPaginationParameterError("cursor 参数无效");
  }

  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) {
      throw new InvalidPaginationParameterError("cursor 参数无效");
    }
    const value = JSON.parse(UTF8_DECODER.decode(bytes)) as Partial<UpdatedAtCursor> | null;
    if (
      !value ||
      typeof value.updatedAt !== "string" ||
      !isValidUpdatedAt(value.updatedAt) ||
      !Number.isSafeInteger(value.id) ||
      (value.id ?? 0) < 1
    ) {
      throw new InvalidPaginationParameterError("cursor 参数无效");
    }
    return { updatedAt: value.updatedAt, id: value.id as number };
  } catch (error) {
    if (error instanceof InvalidPaginationParameterError) throw error;
    throw new InvalidPaginationParameterError("cursor 参数无效");
  }
}

export function createCursorPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (item: T) => string,
): CursorPage<T> {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasNextPage && last !== undefined ? cursorOf(last) : null,
  };
}

export type PaginationParams =
  | { ok: true; limit: number; idCursor: number | null; updatedAtCursor: UpdatedAtCursor | null }
  | { ok: false; response: Response };

/**
 * route 侧统一分页参数入口：一次解析 limit 与对应类型的游标，非法参数直接返回
 * 标准 400 响应，避免每个 route 重复 try/catch 与错误文案。kind 决定解析哪种游标。
 */
export function parsePaginationParams(
  searchParams: URLSearchParams,
  kind: "id" | "updatedAt" | "none" = "id"
): PaginationParams {
  try {
    const limit = parsePageLimit(searchParams);
    const idCursor = kind === "id" ? parseIdCursor(searchParams) : null;
    const updatedAtCursor = kind === "updatedAt" ? parseUpdatedAtCursor(searchParams) : null;
    return { ok: true, limit, idCursor, updatedAtCursor };
  } catch (error) {
    if (error instanceof InvalidPaginationParameterError) {
      return { ok: false, response: Response.json({ error: "分页参数无效" }, { status: 400 }) };
    }
    throw error;
  }
}
