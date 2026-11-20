"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader, SectionTitle } from "@/components/common/ui-bits";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { btnGhost, btnPrimary, cardCls, inputCls, labelCls } from "@/lib/ui";
import {
  analyzeOffer, createExampleOffers, createOfferDraft, hrQuestions, preferenceScore, PREFERENCES,
  type OfferDraft, type PreferenceWeights, type ScenarioKey,
} from "@/lib/offer-comparison";
import { OfferForm } from "./offer-form";
import { OfferResults, offerName } from "./offer-results";

export default function OfferComparisonPage() {
  const [offers, setOffers] = useState<[OfferDraft, OfferDraft]>(() => [createOfferDraft(), createOfferDraft()]);
  const [weights, setWeights] = useState<PreferenceWeights>({ growth: 3, stability: 3, culture: 3, flexibility: 3 });
  const [scenario, setScenario] = useState<ScenarioKey>("neutral");
  const [showErrors, setShowErrors] = useState(false);
  const [example, setExample] = useState(false);
  const [touched, setTouched] = useState(false);
  const copyFeedback = useCopyFeedback();
  const analyses = [analyzeOffer(offers[0]), analyzeOffer(offers[1])] as const;
  const scores: [number | null, number | null] = [preferenceScore(offers[0], weights), preferenceScore(offers[1], weights)];
  const questions = offers.map(hrQuestions);
  const questionText = offers.map((offer, index) => `${offerName(offer, index)}\n${questions[index]?.map((question, i) => `${i + 1}. ${question}`).join("\n") || "当前清单无待确认问题。"}`).join("\n\n");
  const ready = analyses.every(analysis => analysis.scenarios !== null);

  function updateOffer(index: number, offer: OfferDraft) {
    setTouched(true);
    setOffers(current => index === 0 ? [offer, current[1]] : [current[0], offer]);
  }

  return <div className="mx-auto max-w-6xl space-y-6 pb-8">
    <nav aria-label="面包屑" className="flex flex-wrap gap-2 text-xs text-muted"><Link href="/tools" className="hover:text-primary">求职工具箱</Link><span aria-hidden>/</span><span>Offer 比较</span></nav>
    <PageHeader title="Offer 实际价值比较器" desc="把收入、时间和在意的事放在一起，比较两份 Offer 的实际取舍。" actions={<Link href="/tools/salary" className={btnGhost}>练习薪酬谈判 →</Link>} />
    <div className="space-y-2 rounded-xl border border-line bg-surface p-4 text-xs leading-relaxed text-muted">
      <p>统一按人民币、完整年度、税前口径计算。未知项留空，没有的项目填 0；默认 12 薪、40 小时 / 周、48 工作周 / 年、每周到岗 5 天，请按实际修改。</p>
      <p>结果随填写实时更新。数据仅在当前页面用于计算，离开或刷新后不保存，无需配置 AI。</p>
    </div>
    {example && <p role="status" className="rounded-lg bg-accent-wash p-3 text-sm text-accent">当前从示例数据开始，请替换为自己的 Offer 条件；示例不代表任何公司的真实薪酬。</p>}
    <form noValidate onSubmit={event => { event.preventDefault(); setShowErrors(true); if (ready) document.getElementById("offer-comparison-results")?.scrollIntoView({ behavior: "instant", block: "start" }); }}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>填写两份 Offer</SectionTitle>
        {!touched && !example && <button type="button" className={btnGhost} onClick={() => { setOffers(createExampleOffers()); setExample(true); setShowErrors(false); }}>用示例体验</button>}
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {offers.map((offer, index) => <OfferForm key={index} id={index === 0 ? "A" : "B"} offer={offer} analysis={analyses[index]!} showErrors={showErrors} onChange={value => updateOffer(index, value)} />)}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" className={btnPrimary}>检查并查看比较</button>
        {showErrors && !ready && <p role="alert" className="text-sm text-danger">请补齐或修正标注的条件，再查看完整比较。未填项目不会按 0 计算。</p>}
        {ready && <p role="status" className="text-xs text-primary">两份 Offer 已可计算，下方结果已更新。</p>}
      </div>
    </form>

    <section className={`${cardCls} space-y-4 p-4 sm:p-6`} aria-label="个人偏好">
      <SectionTitle>什么对你更重要</SectionTitle>
      <p className="max-w-prose text-xs leading-relaxed text-muted">设置重要性，再按了解的情况给两份 Offer 打分。权重 0 表示不参与，1–5 越高越重要；评分 1–5 越高越符合期待，未知可保持待评估。</p>
      <div className="space-y-3">
        {PREFERENCES.map(({ key, label }) => <fieldset key={key} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">{label}</legend>
          <label className="space-y-1"><span className={labelCls}>{label}权重</span>
            <select className={inputCls} value={weights[key]} onChange={event => setWeights(current => ({ ...current, [key]: Number(event.target.value) }))}>
              {[0, 1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value === 0 ? "0 · 不参与" : `${value} · ${value === 5 ? "非常重要" : "重要性"}`}</option>)}
            </select>
          </label>
          {offers.map((offer, index) => <label key={index} className="space-y-1"><span className={labelCls}>Offer {index === 0 ? "A" : "B"} · {label}评分</span>
            <select className={inputCls} value={offer.ratings[key] ?? ""} onChange={event => updateOffer(index, { ...offer, ratings: { ...offer.ratings, [key]: event.target.value === "" ? null : Number(event.target.value) } })}>
              <option value="">待评估</option>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value} / 5</option>)}
            </select>
          </label>)}
        </fieldset>)}
      </div>
      {Object.values(weights).every(value => value === 0) && <p className="text-xs text-muted">所有权重为 0，个人偏好不参与本次比较。</p>}
    </section>

    <div id="offer-comparison-results" className="scroll-mt-20"><OfferResults offers={offers} analyses={[analyses[0], analyses[1]]} scores={scores} scenario={scenario} onScenarioChange={setScenario} /></div>

    <section className={`${cardCls} space-y-4 p-4 sm:p-6`} aria-label="待向 HR 确认的问题">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>待向 HR 确认的问题</SectionTitle>
        <button type="button" className={btnGhost} disabled={copyFeedback.copying} onClick={() => void copyFeedback.copy(questionText)}>{copyFeedback.copiedText === questionText ? "已复制" : "复制两份问题清单"}</button>
      </div>
      <p className="text-xs leading-relaxed text-muted">根据收入项目、已核实条件和偏好待评估项自动整理。勾选已核实条件后，清单同步更新。</p>
      {copyFeedback.copyError && <p role="alert" className="text-xs text-danger">{copyFeedback.copyError.message}</p>}
      <div className="grid gap-5 lg:grid-cols-2">
        {offers.map((offer, index) => <section key={index} className="min-w-0 space-y-3 rounded-xl border border-line p-4" aria-label={`${index === 0 ? "Offer A" : "Offer B"} 确认清单`}>
          <h3 className="break-words font-medium">{offerName(offer, index)}</h3>
          {questions[index]?.length ? <ol className="list-decimal space-y-3 pl-5 text-xs leading-relaxed text-muted">{questions[index]?.map(question => <li key={question}>{question}</li>)}</ol> : <p className="text-sm text-muted">当前清单无待确认问题。后续条件变更时请重新核实。</p>}
        </section>)}
      </div>
    </section>
  </div>;
}
