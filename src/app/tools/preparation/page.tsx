"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ApplicationDialog } from "@/components/application/application-dialog";
import { Loading, PageHeader } from "@/components/common/ui-bits";
import { useCursorList } from "@/hooks/use-cursor-list";
import { PreparationPlanPanel } from "@/components/application/preparation-plan-panel";
import type { Application } from "@/lib/applications-types";
import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { btnGhost, btnPrimary, inputCls } from "@/lib/ui";

export default function PreparationToolPage() {
  return <div className="mx-auto max-w-6xl space-y-6">
    <Link href="/tools" className="text-sm text-muted hover:text-primary">← 求职工具箱</Link>
    <PageHeader title="上场计划" desc="把岗位准备变成一张行动清单：补齐资料、安排训练，带着把握上场。" />
    <Suspense fallback={<Loading label="读取岗位…" />}><PreparationToolContent /></Suspense>
  </div>;
}

function PreparationToolContent() {
  const query = useSearchParams().get("applicationId");
  const id = parseCanonicalPositiveId(query);
  if (query !== null && !Number.isSafeInteger(id)) return <div role="alert" className="space-y-3"><p className="text-danger">岗位编号无效，请重新选择岗位。</p><Link className={btnGhost} href="/tools/preparation">选择岗位</Link></div>;
  return query === null ? <ApplicationPicker /> : <PreparationPlanPanel key={id} id={id} />;
}

function ApplicationPicker() {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useCursorList<Application>({
    queryKey: `preparation-plans:${keyword.trim()}`,
    buildUrl: cursor => {
      const query = new URLSearchParams({ limit: "12", q: keyword.trim() });
      if (cursor) query.set("cursor", cursor);
      return `/api/applications?${query}`;
    },
    validatePage: page => {
      if (page.items.some(app => !Number.isSafeInteger(app.id) || app.id <= 0 || typeof app.company !== "string" || typeof app.role !== "string")) throw new Error("岗位列表不完整，请重新加载");
    },
  });
  return <section aria-label="选择准备岗位" className="space-y-5">
    <div className="rounded-2xl border border-primary/20 bg-primary-soft/40 p-6 sm:p-8">
      <p className="text-xs font-semibold tracking-widest text-primary">从下一次机会开始</p>
      <h2 className="mt-3 font-serif text-2xl font-bold">选定岗位，再安排每一步</h2>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">根据该投递的 JD、简历版本和已关联资料检查缺项，生成预计耗时与执行入口。清单与完成进度按岗位保存，随时回来继续准备。</p>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-sm">查找投递岗位<input className={`${inputCls} mt-2`} value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索公司或岗位名称" /></label>
      <button className={btnPrimary} onClick={() => setCreating(true)}>添加岗位</button>
    </div>
    {list.loading && <Loading label="加载岗位…" />}
    {list.listError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger"><p>{list.listError}</p><button className={btnGhost} onClick={list.failedCursor ? list.loadMore : list.reload}>重试加载</button></div>}
    {!list.loading && list.items?.length === 0 && <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">{keyword.trim() ? "没有找到匹配的岗位，试试其他关键词。" : "还没有投递岗位。添加公司与岗位后，即可从补齐资料开始准备。"}</p>}
    <div className="grid gap-4 sm:grid-cols-2">{list.items?.map(app => <Link key={app.id} href={`/tools/preparation?applicationId=${app.id}`} className="group min-w-0 rounded-xl border border-line bg-card p-5 shadow-card-subtle transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
      <p className="break-words text-sm text-muted">{app.company}</p>
      <h3 className="mt-1 break-words font-serif text-lg font-bold group-hover:text-primary">{app.role}</h3>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs"><span className="text-muted">{app.jd?.trim() ? "JD 已保存" : "待补 JD"} · {app.resume_version_id ? "已关联简历版本" : "待选简历版本"}</span><span className="font-semibold text-primary">安排上场计划 →</span></div>
    </Link>)}</div>
    {list.hasMore && <button className={btnGhost} disabled={list.loadingMore} onClick={list.loadMore}>{list.loadingMore ? "加载中…" : "更多岗位"}</button>}
    {creating && <ApplicationDialog onClose={() => setCreating(false)} onSuccess={app => { setCreating(false); router.push(`/tools/preparation?applicationId=${app.id}`); }} />}
  </section>;
}
