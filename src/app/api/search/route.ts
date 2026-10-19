import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { escapeLike, getDb } from "@/lib/db";
import { logServerEvent, requestIdFrom } from "@/lib/server-errors";
import { extractSnippetsFromText, type MatchedSnippet } from "@/lib/search-snippet";
import { loadSearchMatches } from "@/lib/search-matches";

/**
 * 至少 3 个 Unicode 字符且不含 %、_、反斜线或双引号的查询先用三元组 FTS 缩小候选，再用 LIKE 核对。
 * 短词和含上述特殊字符的查询仍走 LIKE 扫描，代价随库中文字总量增长。
 * 超过此阈值记录结构化告警，用于观察短词退化与大库检索开销。
 */
const SLOW_SEARCH_THRESHOLD_MS = 500;

/** 全局搜索：跨简历（标题/模块内容）、项目（名称/总结/材料）、题目、面试记录（JD/对话） */
async function handleGet(req: Request) {
  const startedAt = Date.now();
  const rawQ = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!rawQ) {
    return NextResponse.json({ resumes: [], projects: [], questions: [], interviews: [], applications: [] });
  }

  // 防范畸形或超长输入导致的正则模糊扫描拒绝服务，截断至前 100 字符
  const q = rawQ.slice(0, 100);
  const like = `%${escapeLike(q)}%`;
  const indexedTerm = [...q].length >= 3 && !/[%_\\"]/u.test(q) ? `"${q}"` : null;
  const db = getDb();

  const applicationsRaw = db
    .prepare(
      `SELECT id, company, role, stage, updated_at, notes, jd FROM applications
       WHERE ${indexedTerm ? "id IN (SELECT rowid FROM search_fts_applications WHERE search_fts_applications MATCH ?) AND " : ""}
         (company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR jd LIKE ? ESCAPE '\\')
       ORDER BY updated_at DESC
       LIMIT 8`
    )
    .all(...(indexedTerm ? [indexedTerm] : []), like, like, like, like) as {
      id: number;
      company: string;
      role: string;
      stage: string;
      updated_at: string;
      notes: string;
      jd: string;
    }[];

  const applications = applicationsRaw.map((app) => {
    const snippets: MatchedSnippet[] = [];
    if (app.notes) {
      snippets.push(...extractSnippetsFromText(app.notes, q, { source: "备注", maxSnippets: 2 }));
    }
    if (app.jd && snippets.length < 3) {
      snippets.push(...extractSnippetsFromText(app.jd, q, { source: "岗位要求", maxSnippets: 2 }));
    }
    return {
      id: app.id,
      company: app.company,
      role: app.role,
      stage: app.stage,
      updated_at: app.updated_at,
      snippets,
    };
  });

  const resumesRaw = db
    .prepare(
      `SELECT id, title, updated_at FROM resumes
       WHERE ${indexedTerm ? `id IN (
         SELECT rowid FROM search_fts_resumes WHERE search_fts_resumes MATCH ?
         UNION SELECT resume_id FROM resume_modules WHERE id IN (
           SELECT rowid FROM search_fts_resume_modules WHERE search_fts_resume_modules MATCH ?)) AND ` : ""}
         (title LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM resume_modules m
                     WHERE m.resume_id = resumes.id AND m.content LIKE ? ESCAPE '\\'
                     LIMIT 1))
       ORDER BY updated_at DESC
       LIMIT 8`
    )
    .all(...(indexedTerm ? [indexedTerm, indexedTerm] : []), like, like) as { id: number; title: string; updated_at: string }[];

  const resumeModules = loadSearchMatches(db, "resume", resumesRaw.map((resume) => resume.id), like);

  const resumes = resumesRaw.map((r) => {
    const snippets: MatchedSnippet[] = [];
    const matchedModules = resumeModules.get(r.id) ?? [];
    for (const m of matchedModules) {
      if (snippets.length >= 3) break;
      const srcName = m.label || m.type || "简历模块";
      snippets.push(...extractSnippetsFromText(m.content, q, { source: srcName, maxSnippets: 2 }));
    }
    return {
      id: r.id,
      title: r.title,
      updated_at: r.updated_at,
      snippets,
    };
  });

  const projectsRaw = db
    .prepare(
      `SELECT id, name, summary, updated_at FROM projects
       WHERE ${indexedTerm ? `id IN (
         SELECT rowid FROM search_fts_projects WHERE search_fts_projects MATCH ?
         UNION SELECT project_id FROM project_materials WHERE id IN (
           SELECT rowid FROM search_fts_project_materials WHERE search_fts_project_materials MATCH ?)) AND ` : ""}
         (name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM project_materials pm
                     WHERE pm.project_id = projects.id
                       AND (pm.title LIKE ? ESCAPE '\\' OR pm.content LIKE ? ESCAPE '\\')
                     LIMIT 1))
       ORDER BY updated_at DESC
       LIMIT 8`
    )
    .all(...(indexedTerm ? [indexedTerm, indexedTerm] : []), like, like, like, like) as {
      id: number;
      name: string;
      summary: string;
      updated_at: string;
    }[];

  const projectMaterials = loadSearchMatches(db, "project", projectsRaw.map((project) => project.id), like);

  const projects = projectsRaw.map((p) => {
    const snippets: MatchedSnippet[] = [];
    if (p.summary) {
      snippets.push(...extractSnippetsFromText(p.summary, q, { source: "项目总结", maxSnippets: 2 }));
    }
    if (snippets.length < 3) {
      const matchedMaterials = projectMaterials.get(p.id) ?? [];
      for (const pm of matchedMaterials) {
        if (snippets.length >= 3) break;
        const srcName = pm.title || "项目材料";
        snippets.push(...extractSnippetsFromText(pm.content, q, { source: srcName, maxSnippets: 2 }));
      }
    }
    return {
      id: p.id,
      name: p.name,
      updated_at: p.updated_at,
      snippets,
    };
  });

  const questionsRaw = db
    .prepare(
      `SELECT q.id, q.drill_id, q.idx, q.question, q.answer, q.comment, q.reference,
              COALESCE(p.name, NULLIF(d.direction, ''), substr(d.jd, 1, 30), '') AS label
       FROM drill_questions q
       JOIN drills d ON d.id = q.drill_id
       LEFT JOIN projects p ON p.id = d.project_id
       WHERE ${indexedTerm ? "q.id IN (SELECT rowid FROM search_fts_drill_questions WHERE search_fts_drill_questions MATCH ?) AND " : ""}
         (q.question LIKE ? ESCAPE '\\' OR q.answer LIKE ? ESCAPE '\\'
          OR q.comment LIKE ? ESCAPE '\\' OR q.reference LIKE ? ESCAPE '\\')
       ORDER BY q.id DESC
       LIMIT 8`
    )
    .all(...(indexedTerm ? [indexedTerm] : []), like, like, like, like) as {
    id: number;
    drill_id: number;
    idx: number;
    question: string;
    answer: string;
    comment: string;
    reference: string;
    label: string | null;
  }[];

  const questions = questionsRaw.map((qItem) => {
    const snippets: MatchedSnippet[] = [];
    if (qItem.answer) {
      snippets.push(...extractSnippetsFromText(qItem.answer, q, { source: "作答内容", maxSnippets: 2 }));
    }
    if (qItem.comment && snippets.length < 3) {
      snippets.push(...extractSnippetsFromText(qItem.comment, q, { source: "点评反馈", maxSnippets: 2 }));
    }
    if (qItem.reference && snippets.length < 3) {
      snippets.push(...extractSnippetsFromText(qItem.reference, q, { source: "参考要点", maxSnippets: 2 }));
    }
    return {
      id: qItem.id,
      drill_id: qItem.drill_id,
      idx: qItem.idx,
      question: qItem.question,
      label: qItem.label,
      snippets,
    };
  });

  const interviewsRaw = db
    .prepare(
      `SELECT i.id, i.jd, i.status, i.created_at, r.title AS resume_title,
              (SELECT COUNT(*) FROM interview_turns t
               WHERE t.interview_id = i.id AND t.answered_at != '') AS answered
       FROM interviews i
       JOIN resumes r ON r.id = i.resume_id
       WHERE ${indexedTerm ? `i.id IN (
         SELECT rowid FROM search_fts_interviews WHERE search_fts_interviews MATCH ?
         UNION SELECT interview_id FROM interview_turns WHERE id IN (
           SELECT rowid FROM search_fts_interview_turns WHERE search_fts_interview_turns MATCH ?)) AND ` : ""}
         (i.jd LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM interview_turns t
                     WHERE t.interview_id = i.id
                       AND (t.question LIKE ? ESCAPE '\\' OR t.answer LIKE ? ESCAPE '\\')
                     LIMIT 1))
       ORDER BY i.id DESC
       LIMIT 8`
    )
    .all(...(indexedTerm ? [indexedTerm, indexedTerm] : []), like, like, like) as {
    id: number;
    jd: string;
    status: string;
    created_at: string;
    resume_title: string;
    answered: number;
  }[];

  const interviewTurns = loadSearchMatches(db, "interview", interviewsRaw.map((interview) => interview.id), like);

  const interviews = interviewsRaw.map((it) => {
    const snippets: MatchedSnippet[] = [];
    if (it.jd) {
      snippets.push(...extractSnippetsFromText(it.jd, q, { source: "岗位要求", maxSnippets: 2 }));
    }
    if (snippets.length < 3) {
      const turns = interviewTurns.get(it.id) ?? [];
      for (const turn of turns) {
        if (snippets.length >= 3) break;
        if (turn.question) {
          snippets.push(...extractSnippetsFromText(turn.question, q, { source: "面试追问", maxSnippets: 1 }));
        }
        if (turn.answer && snippets.length < 3) {
          snippets.push(...extractSnippetsFromText(turn.answer, q, { source: "回答内容", maxSnippets: 1 }));
        }
      }
    }
    return {
      id: it.id,
      jd: it.jd,
      status: it.status,
      created_at: it.created_at,
      resume_title: it.resume_title,
      answered: it.answered,
      snippets,
    };
  });

  const result = { resumes, projects, questions, interviews, applications };
  const durationMs = Date.now() - startedAt;
  if (durationMs >= SLOW_SEARCH_THRESHOLD_MS) {
    logServerEvent("warn", "search.slow", {
      requestId: requestIdFrom(req),
      durationMs,
      context: {
        queryLength: q.length,
        thresholdMs: SLOW_SEARCH_THRESHOLD_MS,
        resultCount: resumes.length + projects.length + questions.length + interviews.length + applications.length,
      },
    });
  }
  return NextResponse.json(result);
}

export const GET = withRouteErrorHandling("GET /api/search", handleGet);
