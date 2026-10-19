import type { Page } from "@playwright/test";
import type { ModuleData } from "../../src/lib/modules";
import type { Application, ApplicationStage, ApplicationStats } from "../../src/lib/applications-types";
import { calculateBatchFunnelMetrics, calculateFunnelMetrics } from "../../src/lib/application-funnel";
import type { ResumeStyleOverrides } from "../../src/lib/templates";

export function syntheticResume() {
  return {
    resume: { id: 9001, title: "合成测试简历", template: "classic", style_overrides: {} as ResumeStyleOverrides, created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z" },
    modules: [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "合成姓名", city: "上海", phone: "", email: "", links: "" } },
      { key: "summary", type: "summary", label: "个人简介", sort: 1, content: { text: "合成简历正文" } },
    ] as ModuleData[],
  };
}

/** 所有 API 均在浏览器侧拦截，避免界面测试接触开发者数据。 */
export async function mockApi(page: Page, applications: Application[] = []) {
  const resume = syntheticResume();
  const writes: Record<string, unknown>[] = [];
  const applicationWrites: Record<string, unknown>[] = [];
  let applicationData = applications.map((application) => ({ ...application }));
  const controls = {
    failSaves: false,
    failNextApplicationListRequests: 0,
    failNextApplicationStatsRequests: 0,
    applicationListRequests: [] as string[],
    applicationStatsRequests: 0,
    beforePatch: async (body: Record<string, unknown>) => { void body; },
    writes,
    applicationWrites,
    applications: () => applicationData.map((application) => ({ ...application })),
    resume: () => resume,
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    let response: unknown = {};
    if (path === "/api/resumes/9001") {
      if (method === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writes.push(body);
        await controls.beforePatch(body);
        if (controls.failSaves) {
          await route.fulfill({ status: 503, json: { error: "合成保存失败" } });
          return;
        }
        const modules = body.modules as Record<string, unknown> | undefined;
        if (modules) resume.modules = resume.modules.map((m) => Object.hasOwn(modules, m.key) ? { ...m, content: modules[m.key] } : m);
        if (typeof body.title === "string") resume.resume.title = body.title;
        if (typeof body.template === "string") resume.resume.template = body.template;
        if (body.styleOverrides !== undefined) resume.resume.style_overrides = (body.styleOverrides ?? {}) as ResumeStyleOverrides;
        const rename = body.renameModule as { key: string; label: string } | undefined;
        if (rename) resume.modules = resume.modules.map((m) => m.key === rename.key ? { ...m, label: rename.label } : m);
        if (Array.isArray(body.moduleOrder)) resume.modules = body.moduleOrder.flatMap((key) => {
          const found = resume.modules.find((m) => m.key === key);
          return found ? [found] : [];
        });
        if (typeof body.removeModule === "string") resume.modules = resume.modules.filter((m) => m.key !== body.removeModule);
      }
      response = resume;
    } else if (path === "/api/resumes") response = [{ ...resume.resume, versions: [{ id: 90001, version: 1, name: "测试发布版本" }] }];
    else if (path === "/api/templates") response = { items: [] };
    else if (path === "/api/reviews") response = { items: [], nextCursor: null, summary: { date: "2026-09-27", total: 0, due: 0, notebook: 0, remedial: 0, overdue: 0, completed_today: 0 } };
    else if (path === "/api/applications/stats") {
      controls.applicationStatsRequests += 1;
      if (controls.failNextApplicationStatsRequests > 0) {
        controls.failNextApplicationStatsRequests -= 1;
        await route.fulfill({ status: 503, json: { error: "合成统计失败" } });
        return;
      }
      const counts: Record<ApplicationStage, number> = {
        interested: 0,
        applied: 0,
        interviewing: 0,
        interview: 0,
        reviewing: 0,
        offer: 0,
        rejected: 0,
      };
      for (const application of applicationData) counts[application.stage] += 1;
      const totalLeads = counts.interested + counts.applied + counts.interviewing + counts.interview + counts.reviewing + counts.offer;
      const appliedTotal = counts.applied + counts.interviewing + counts.interview + counts.reviewing + counts.offer;
      const interviewingTotal = counts.interviewing + counts.interview + counts.reviewing + counts.offer;
      const funnelApplications = applicationData.map(({ id, stage, batch_name, hiring_stage, terminal_stage, terminal_reason, stage_history }) => ({
        id,
        stage,
        batch_name,
        hiring_stage,
        terminal_stage,
        terminal_reason,
        stage_history,
      }));
      response = {
        counts,
        totalActive: totalLeads,
        upcomingInterviews: [],
        rates: {
          appliedRate: totalLeads > 0 ? Math.round((appliedTotal / totalLeads) * 100) : 0,
          interviewRate: appliedTotal > 0 ? Math.round((interviewingTotal / appliedTotal) * 100) : 0,
          offerRate: interviewingTotal > 0 ? Math.round((counts.offer / interviewingTotal) * 100) : 0,
        },
        funnel: calculateFunnelMetrics(funnelApplications),
        batchStats: calculateBatchFunnelMetrics(funnelApplications),
      } satisfies ApplicationStats;
    }
    else if (path === "/api/applications" && method === "GET") {
      controls.applicationListRequests.push(url.toString());
      if (controls.failNextApplicationListRequests > 0) {
        controls.failNextApplicationListRequests -= 1;
        await route.fulfill({ status: 503, json: { error: "合成列表失败" } });
        return;
      }
      const q = url.searchParams.get("q")?.trim().toLocaleLowerCase() ?? "";
      const stage = url.searchParams.get("stage");
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor
        ? JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as { updatedAt: string; id: number }
        : null;
      const filtered = applicationData
        .filter((application) => !stage || stage === "all" || application.stage === stage)
        .filter((application) => !q || [application.company, application.role, application.notes]
          .some((value) => value.toLocaleLowerCase().includes(q)))
        .filter((application) => !cursor || application.updated_at < cursor.updatedAt ||
          (application.updated_at === cursor.updatedAt && application.id < cursor.id))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id - left.id);
      const items = filtered.slice(0, limit);
      const last = items.at(-1);
      response = {
        items,
        nextCursor: filtered.length > limit && last
          ? Buffer.from(JSON.stringify({ updatedAt: last.updated_at, id: last.id }), "utf8").toString("base64url")
          : null,
      };
    }
    else if (path === "/api/applications" && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      applicationWrites.push(body);
      const timestamp = new Date().toISOString();
      const created: Application = {
        id: Math.max(0, ...applicationData.map(({ id }) => id)) + 1,
        company: String(body.company ?? ""),
        role: String(body.role ?? ""),
        flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
        salary_range: String(body.salary_range ?? ""),
        stage: (body.stage ?? "interested") as ApplicationStage,
        resume_id: body.resume_id == null ? null : Number(body.resume_id),
        resume_version_id: body.resume_version_id == null ? null : Number(body.resume_version_id),
        jd: String(body.jd ?? ""),
        interview_id: body.interview_id == null ? null : Number(body.interview_id),
        interview_series_id: body.interview_series_id == null ? null : Number(body.interview_series_id),
        next_interview_at: String(body.next_interview_at ?? ""),
        notes: String(body.notes ?? ""),
        created_at: timestamp,
        updated_at: timestamp,
      };
      applicationData = [...applicationData, created];
      response = created;
    }
    else if (/^\/api\/applications\/\d+$/.test(path) && method === "GET") {
      response = applicationData.find(application => application.id === Number(path.split("/").at(-1)));
      if (!response) {
        await route.fulfill({ status: 404, json: { error: "未找到合成投递" } });
        return;
      }
    }
    else if (/^\/api\/applications\/\d+$/.test(path) && method === "PATCH") {
      const id = Number(path.split("/").at(-1));
      const body = route.request().postDataJSON() as Record<string, unknown>;
      applicationWrites.push(body);
      await controls.beforePatch(body);
      const existing = applicationData.find((application) => application.id === id);
      if (!existing) {
        await route.fulfill({ status: 404, json: { error: "未找到合成投递" } });
        return;
      }
      const updated = { ...existing, ...body, id, updated_at: new Date().toISOString() } as Application;
      applicationData = applicationData.map((application) => application.id === id ? updated : application);
      response = updated;
    }
    else if (/^\/api\/applications\/\d+$/.test(path) && method === "DELETE") {
      const id = Number(path.split("/").at(-1));
      applicationData = applicationData.filter((application) => application.id !== id);
      response = { ok: true };
    }
    else if (path === "/api/settings/configured") response = { configured: false };
    else if (path === "/api/projects" && method === "GET") response = [];
    else if (path === "/api/bank/directions" && method === "GET") response = [];
    else if (path === "/api/bank" && method === "GET") response = { items: [], nextCursor: null };
    else if (path === "/api/interviews" || path === "/api/interviews/series") response = { items: [], nextCursor: null, total: 0 };
    await route.fulfill({ json: response });
  });
  return controls;
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
