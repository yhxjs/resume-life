"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";
import { errorMessage } from "@/lib/error-message";
import { PREPARATION_LABELS, type ApplicationPreparation, type PreparationKind, type PreparationResource } from "@/lib/application-preparation-types";
import type { CursorPage } from "@/lib/cursor-pagination";

export function useApplicationPreparation(id: string) {
  const [data, setData] = useState<ApplicationPreparation | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const action = useRef<AbortController | null>(null);
  const load = useRef<AbortController | null>(null);
  const base = `/api/applications/${id}/preparation`;

  const reload = useCallback(async () => {
    load.current?.abort();
    const controller = new AbortController();
    load.current = controller;
    try {
      const result = await jsonFetch<ApplicationPreparation>(base, { signal: controller.signal });
      if (!controller.signal.aborted) { setData(result); setError(""); }
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }
  }, [base]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => { clearTimeout(timer); load.current?.abort(); action.current?.abort(); };
  }, [reload]);

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>, refresh = true) {
    if (action.current) return false;
    const controller = new AbortController();
    action.current = controller;
    setBusy(label); setError(""); setNotice("");
    try {
      await work(controller.signal);
      if (controller.signal.aborted) return false;
      if (refresh) await reload();
      setNotice(`${label}成功`);
      return true;
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
      return false;
    } finally {
      if (action.current === controller) { action.current = null; setBusy(""); }
    }
  }

  function mutate(path: "resources" | "tasks", method: "POST" | "PATCH" | "DELETE", body: unknown, label: string) {
    return run(label, async (signal) => {
      await jsonFetch(`${base}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    });
  }

  async function toggleTask(taskId: number, done: boolean) {
    if (action.current || !data) return;
    const previous = data.tasks.find((task) => task.id === taskId);
    if (!previous) return;
    setData((current) => current ? { ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, done } : task) } : current);
    if (!await mutate("tasks", "PATCH", { id: taskId, done }, "更新待办")) {
      setData((current) => current ? { ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, done: previous.done } : task) } : current);
    }
  }

  async function generate(kind: "diagnosis" | "intro" | "portrait") {
    if (!data) return;
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
    if (!cursor) return;
    await run(`加载${PREPARATION_LABELS[kind]}`, async (signal) => {
      const page = await jsonFetch<CursorPage<PreparationResource>>(`${base}/resources?kind=${kind}&limit=5&cursor=${cursor}`, { signal });
      setData((current) => current ? { ...current, resources: { ...current.resources, [kind]: { ...page, items: [...current.resources[kind].items, ...page.items] } } } : current);
    }, false);
  }

  return { data, error, busy, notice, reload, mutate, toggleTask, generate, loadMore };
}
