"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { fetchSse, SseServerError } from "@/lib/fetch-sse";
import { errorMessage } from "@/lib/error-message";
import { readPreparationPlan, type PlanStep, type PreparationPlan } from "@/lib/preparation-plan-types";

export function usePreparationPlan(id: number) {
  const [data, setData] = useState<PreparationPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  const active = useRef(true);
  const unconfirmed = useRef(false);
  const base = `/api/tools/preparation-plans/${id}`;

  const reload = useCallback(async () => {
    if (!active.current || pending.current) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const result = readPreparationPlan(await jsonFetch<unknown>(base, { signal: controller.signal }), id);
      if (reading.current !== controller || controller.signal.aborted) return;
      setData(result); setError(""); setBlocked(false); unconfirmed.current = false;
    } catch (reason) {
      if (!controller.signal.aborted && reading.current === controller) setError(errorMessage(reason));
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  }, [base, id]);

  useEffect(() => {
    active.current = true;
    const timer = setTimeout(() => void reload(), 0);
    const onFocus = () => { if (!unconfirmed.current) void reload(); };
    window.addEventListener("focus", onFocus);
    return () => {
      active.current = false;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      reading.current?.abort(); pending.current?.abort();
      reading.current = null; pending.current = null;
    };
  }, [reload]);

  async function run(label: string, work: (signal: AbortSignal) => Promise<PreparationPlan>) {
    if (!active.current || pending.current || unconfirmed.current || !data) return;
    reading.current?.abort(); reading.current = null;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(label); setError(""); setNotice("");
    try {
      const result = await work(controller.signal);
      if (controller.signal.aborted || pending.current !== controller) return;
      setData(result); setNotice(`${label}完成`);
    } catch (reason) {
      if (controller.signal.aborted || pending.current !== controller) return;
      const uncertain = !(reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) &&
        !(reason instanceof SseServerError && reason.outcome === "not_saved");
      if (uncertain) { unconfirmed.current = true; setBlocked(true); }
      setError(`${errorMessage(reason)}${uncertain ? "；请先刷新清单核对执行结果，再继续操作。" : ""}`);
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(""); }
    }
  }

  function generate() {
    if (!data) return;
    const contextKey = data.contextKey;
    return run("生成准备清单", async signal => {
      const result = readPreparationPlan(await jsonFetch<unknown>(base, { method: "POST", body: JSON.stringify({ contextKey }), signal }), id);
      if (!result.generatedAt || result.contextKey !== contextKey) throw new Error("清单生成结果未确认");
      return result;
    });
  }

  function complete(step: PlanStep, done: boolean) {
    if (!data) return;
    const contextKey = data.contextKey;
    return run(done ? "标记训练" : "恢复待练", async signal => {
      const result = readPreparationPlan(await jsonFetch<unknown>(base, { method: "PATCH", body: JSON.stringify({ contextKey, key: step.key, done }), signal }), id);
      if (result.contextKey !== contextKey || result.steps.find(item => item.key === step.key)?.done !== done) throw new Error("训练进度尚未确认");
      return result;
    });
  }

  function generateMaterial(step: PlanStep) {
    if (!data || step.done || step.blocked || !["portrait", "intro", "diagnosis"].includes(step.key)) return;
    const app = data.application;
    const contextKey = data.contextKey;
    return run(`生成${step.key === "portrait" ? "考点画像" : step.key === "intro" ? "自我介绍" : "简历诊断"}`, async signal => {
      const body = { application_id: app.id, jd: app.jd, resume_id: app.resume_id, resume_version_id: app.resume_version_id, job_title: `${app.company} · ${app.role}`.slice(0, 100) };
      if (step.key === "intro") await fetchSse("/api/intros", { body, signal });
      else await jsonFetch(step.key === "portrait" ? "/api/tools/jd-portraits" : `/api/resumes/${app.resume_id}/diagnose`, { method: "POST", body: JSON.stringify(body), signal });
      const result = readPreparationPlan(await jsonFetch<unknown>(base, { signal }), id);
      if (result.contextKey !== contextKey || !result.steps.find(item => item.key === step.key)?.done) throw new Error("资料生成结果尚未确认");
      return result;
    });
  }

  return { data, error, busy, notice, blocked, reload, generate, complete, generateMaterial };
}
