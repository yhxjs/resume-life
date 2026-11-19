import { ROUND_STATUS_CONFIG, STAGE_CONFIG } from "@/lib/applications-types";
import { PREPARATION_KINDS, type ApplicationPreparation, type PreparationKind, type PreparationResource, type PreparationTask } from "@/lib/application-preparation-types";
import type { CursorPage } from "@/lib/cursor-pagination";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const cursorId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value) && positiveId(Number(value));
function fail(message: string): never { throw new Error(message); }

export function readPreparationTask(value: unknown): PreparationTask {
  if (!object(value) || !positiveId(value.id) || typeof value.title !== "string" || !value.title.trim() || typeof value.done !== "boolean"
    || typeof value.created_at !== "string" || (value.due_time !== undefined && (typeof value.due_time !== "string" || (value.due_time !== "" && !Number.isFinite(Date.parse(value.due_time)))))) {
    fail("待办响应不完整");
  }
  return value as PreparationTask;
}

/** ID 游标只接受向后推进的完整资料页，坏页不能吞掉原游标或追加伪记录。 */
export function readPreparationResourcePage(value: unknown, kind: PreparationKind, cursor?: string): CursorPage<PreparationResource> {
  if (!object(value) || !Array.isArray(value.items) || (value.nextCursor !== null && !cursorId(value.nextCursor))
    || (value.total !== undefined && (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < value.items.length))) fail("准备资料分页响应不完整");
  let previous = cursor === undefined ? Infinity : Number(cursor);
  for (const item of value.items) {
    if (!object(item) || !positiveId(item.id) || item.id >= previous || typeof item.title !== "string" || typeof item.summary !== "string"
      || typeof item.created_at !== "string" || typeof item.linked !== "boolean" || (item.resume_id !== null && !positiveId(item.resume_id))) fail("准备资料分页条目不完整或顺序无效");
    const expectedHref = kind === "intro" ? `/intros/${item.id}` : kind === "portrait" ? `/tools/jd/${item.id}` : kind === "interview" ? `/interviews/${item.id}` : kind === "series" ? `/interviews/series/${item.id}` : null;
    if (item.href !== expectedHref) fail("准备资料链接与记录不符");
    previous = item.id;
  }
  if (value.nextCursor !== null && (!value.items.length || Number(value.nextCursor) !== previous)) fail("准备资料分页游标未正确推进");
  return value as CursorPage<PreparationResource>;
}

/** 首读、刷新和关联写入统一校验所属投递及实际渲染的完整快照。 */
export function readApplicationPreparation(value: unknown, applicationId: number): ApplicationPreparation {
  if (!object(value) || !object(value.application) || value.application.id !== applicationId || !positiveId(applicationId)
    || typeof value.application.company !== "string" || typeof value.application.role !== "string" || typeof value.application.jd !== "string"
    || typeof value.application.stage !== "string" || !Object.hasOwn(STAGE_CONFIG, value.application.stage)
    || (value.application.resume_id !== null && !positiveId(value.application.resume_id))
    || (value.application.resume_version_id != null && !positiveId(value.application.resume_version_id))
    || !object(value.resources) || !Array.isArray(value.tasks)) fail("准备页快照不完整或投递不符");
  const ids = new Set<number>();
  for (const row of value.tasks) {
    const task = readPreparationTask(row);
    if (ids.has(task.id)) fail("准备页待办包含重复记录");
    ids.add(task.id);
  }
  for (const kind of PREPARATION_KINDS) readPreparationResourcePage(value.resources[kind], kind);
  if (value.application.interviews !== undefined) {
    if (!Array.isArray(value.application.interviews)) fail("准备页面试轮次响应不完整");
    ids.clear();
    for (const row of value.application.interviews) {
      if (!object(row) || !positiveId(row.id) || ids.has(row.id) || row.application_id !== applicationId || typeof row.round_name !== "string"
        || typeof row.status !== "string" || !Object.hasOwn(ROUND_STATUS_CONFIG, row.status)
        || ["interview_time", "interviewer", "notes", "created_at", "updated_at"].some(key => typeof row[key] !== "string")) fail("准备页面试轮次响应不完整或投递不符");
      ids.add(row.id);
    }
  }
  return value as ApplicationPreparation;
}

export function assertPreparationAcknowledged(value: unknown): void {
  if (!object(value) || value.ok !== true) fail("写入确认响应不完整");
}
