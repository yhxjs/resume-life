"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";
import { errorMessage } from "@/lib/error-message";
import { PREPARATION_LABELS, type ApplicationPreparation, type PreparationKind } from "@/lib/application-preparation-types";
import { assertPreparationAcknowledged, readApplicationPreparation, readPreparationResourcePage, readPreparationTask } from "@/lib/application-preparation-response";

type PreparationAction = { controller: AbortController; phase: "mutation" | "pagination" | "refresh" };

export function useApplicationPreparation(id: string) {
  const [data, setData] = useState<ApplicationPreparation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [writesBlocked, setWritesBlocked] = useState(false);
  const unconfirmed = useRef(false);
  const action = useRef<PreparationAction | null>(null);
  const load = useRef<AbortController | null>(null);
  const deferredReload = useRef(false);
  const active = useRef(true);
  const base = `/api/applications/${id}/preparation`;

  const reload = useCallback(async () => {
    if (!active.current) return false;
    // 写入期间延后读取；即使写入失败，也不能丢掉其他操作要求的刷新。
    if (action.current?.phase === "mutation") { deferredReload.current = true; return false; }
    if (action.current?.phase === "pagination") {
      action.current.controller.abort();
      action.current = null;
      setBusy("");
    }
    load.current?.abort();
    const controller = new AbortController();
    load.current = controller;
    try {
      const result = await jsonFetch<unknown>(base, { signal: controller.signal });
      if (load.current !== controller || controller.signal.aborted) return false;
      const preparation = readApplicationPreparation(result, Number(id));
      setData(preparation); setError("");
      if (unconfirmed.current) {
        unconfirmed.current = false; setWritesBlocked(false);
        setNotice("资料已刷新，请核对刚才的操作结果后再继续。");
      }
      return true;
    } catch (reason) {
      if (load.current === controller && !controller.signal.aborted) setError(`资料刷新失败：${errorMessage(reason)}${unconfirmed.current ? "；写入结果尚未确认，请先刷新资料核对。" : ""}`);
      return false;
    } finally {
      if (load.current === controller) load.current = null;
    }
  }, [base, id]);

  useEffect(() => {
    active.current = true;
    const timer = setTimeout(() => void reload(), 0);
    return () => {
      active.current = false;
      clearTimeout(timer);
      load.current?.abort(); load.current = null;
      action.current?.controller.abort(); action.current = null;
      deferredReload.current = false;
    };
  }, [reload]);

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>, refresh = true, phase: "mutation" | "pagination" = "mutation") {
    if (!active.current || action.current || unconfirmed.current) return false;
    deferredReload.current = false;
    load.current?.abort(); load.current = null;
    const controller = new AbortController();
    const pending: PreparationAction = { controller, phase };
    action.current = pending;
    setBusy(label); setError(""); setNotice("");
    try {
      await work(controller.signal);
      if (action.current !== pending || controller.signal.aborted) return false;
      if (refresh || deferredReload.current) { pending.phase = "refresh"; deferredReload.current = false; await reload(); }
      if (action.current !== pending || controller.signal.aborted) return false;
      setNotice(`${label}成功`);
      return true;
    } catch (reason) {
      if (action.current === pending && !controller.signal.aborted) {
        if (deferredReload.current) {
          pending.phase = "refresh"; deferredReload.current = false;
          await reload();
        }
        if (action.current === pending && !controller.signal.aborted) setError(errorMessage(reason));
      }
      return false;
    } finally {
      if (action.current === pending) { action.current = null; setBusy(""); }
    }
  }

  function mutate(
    path: "resources" | "tasks",
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    label: string,
  ) {
    return run(label, async (signal) => {
      let response: unknown;
      try {
        response = await jsonFetch<unknown>(`${base}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
      } catch (reason) {
        if (signal.aborted) return;
        if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) throw reason;
        blockUnconfirmed(reason);
      }
      if (signal.aborted) return;
      const input = body as { id?: number; title?: string; done?: boolean; due_time?: string };
      let saved: ReturnType<typeof readPreparationTask> | undefined;
      try {
        if (path === "resources") {
          assertPreparationAcknowledged(response);
          const preparation = readApplicationPreparation((response as { preparation?: unknown }).preparation, Number(id));
          setData(preparation);
          return;
        }
        if (method === "POST") {
          saved = readPreparationTask(response);
          const due = input.due_time?.trim() ? new Date(input.due_time.trim()).toISOString() : "";
          if (saved.title !== input.title?.trim() || saved.done !== false || (saved.due_time ?? "") !== due || data?.tasks.some(task => task.id === saved!.id)) throw new Error("新增待办响应与本次提交不符");
        } else assertPreparationAcknowledged(response);
      } catch (reason) {
        blockUnconfirmed(reason);
      }
      // 已确认的待办写入不依赖后续 GET；刷新失败时仍保留真实保存结果。
      setData((current) => {
        if (!current) return current;
        const tasks = method === "POST" ? [saved!, ...current.tasks.filter((task) => task.id !== saved!.id)]
          : method === "DELETE" ? current.tasks.filter((task) => task.id !== input.id)
          : current.tasks.map((task) => task.id !== input.id ? task : { ...task,
            ...(typeof input.done === "boolean" ? { done: input.done } : {}),
            ...(typeof input.title === "string" ? { title: input.title.trim() } : {}),
            ...(typeof input.due_time === "string" ? { due_time: input.due_time.trim() ? new Date(input.due_time.trim()).toISOString() : "" } : {}),
          });
        return { ...current, tasks: tasks.sort((a, b) => Number(a.done) - Number(b.done) || b.id - a.id) };
      });
    }, path === "tasks");
  }

  function blockUnconfirmed(reason: unknown): never {
    unconfirmed.current = true;
    setWritesBlocked(true);
    throw new Error(`写入结果尚未确认：${errorMessage(reason)}。可能已提交，请先刷新资料核对，避免重复操作。`);
  }

  async function toggleTask(taskId: number, done: boolean) {
    if (!active.current || action.current || unconfirmed.current || !data) return;
    const previous = data.tasks.find((task) => task.id === taskId);
    if (!previous) return;
    const optimistic = { ...previous, done };
    setData((current) => current ? { ...current, tasks: current.tasks.map((task) => task.id === taskId ? optimistic : task) } : current);
    if (!await mutate("tasks", "PATCH", { id: taskId, done }, "更新待办")) {
      if (!active.current) return;
      // 只回滚本次乐观对象，不覆盖等待期间读到的最新服务端记录。
      setData((current) => current?.application.id === data.application.id ? { ...current, tasks: current.tasks.map((task) => task === optimistic ? previous : task) } : current);
    }
  }

  async function generate(kind: "diagnosis" | "intro" | "portrait") {
    if (!active.current || action.current || unconfirmed.current || !data) return;
    const app = data.application;
    if (kind !== "portrait" && (!app.resume_id || !app.resume_version_id)) {
      setError("请先为这次投递选择已发布的简历版本");
      return;
    }
    await run(`生成${PREPARATION_LABELS[kind]}`, async (signal) => {
      const body = { application_id: app.id, resume_id: app.resume_id, resume_version_id: app.resume_version_id, jd: app.jd, job_title: `${app.company} · ${app.role}`.slice(0, 100) };
      if (kind === "intro") {
        await fetchSse("/api/intros", { body, signal });
      } else {
        await jsonFetch(kind === "diagnosis" ? `/api/resumes/${app.resume_id}/diagnose` : "/api/tools/jd-portraits", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
        });
      }
    });
  }

  async function loadMore(kind: PreparationKind) {
    const cursor = data?.resources[kind].nextCursor;
    if (!active.current || unconfirmed.current || !cursor || load.current) return;
    await run(`加载${PREPARATION_LABELS[kind]}`, async (signal) => {
      const response = await jsonFetch<unknown>(`${base}/resources?kind=${kind}&limit=5&cursor=${cursor}`, { signal });
      if (signal.aborted) return;
      const page = readPreparationResourcePage(response, kind, cursor);
      setData((current) => current ? { ...current, resources: { ...current.resources, [kind]: { ...page, items: [...current.resources[kind].items, ...page.items] } } } : current);
    }, false, "pagination");
  }

  return { data, error, busy, notice, writesBlocked, reload, mutate, toggleTask, generate, loadMore };
}
