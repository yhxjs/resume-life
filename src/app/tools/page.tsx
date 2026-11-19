import Link from "next/link";

const TOOLS = [
  {
    href: "/tools/jd",
    title: "JD 考点画像",
    desc: "根据 JD 提炼有原文依据的准备重点与练习方向；信息不足时不凑考点，也不预测真实面试必问。",
    badge: "岗位准备建议",
    actionText: "立即使用画像工具",
  },
  {
    href: "/tools/decoder",
    title: "面试黑话与暗号解码器",
    desc: "结合上下文解释“抗压能力强”、“拥抱变化”等招聘表述，区分可能含义、风险信号与待核实条件，整理具体提问。",
    badge: "暗号解码",
    actionText: "立即开始暗号解码",
  },
  {
    href: "/tools/defense",
    title: "简历排雷与防御演练",
    desc: "结合全文核对表述依据、数据口径与个人分工，整理待澄清问题，基于真实经历练习回答并获得反馈。",
    badge: "证据审阅 · 回答练习",
    actionText: "开始简历排雷与自辩",
  },
  {
    href: "/tools/gap",
    title: "离职与空窗沟通准备",
    desc: "针对裁员、内耗、裸辞、Gap、备考、创业或休整经历，按已知事实准备多版表达；区分已确定计划与建议，未知内容标注待补充。",
    badge: "敏感经历表达",
    actionText: "查看沟通建议",
  },
  {
    href: "/tools/salary",
    title: "Offer 谈判与薪酬博弈模拟器",
    desc: "输入目标公司类型、期望薪资与现有筹码，练习多轮模拟谈判；区分模拟报价与已知条件，查看回复建议和结束复盘。",
    badge: "模拟 HR · 谈判复盘",
    actionText: "开始薪酬谈判练习",
  },
  {
    href: "/tools/portfolio",
    title: "个人作品集与静态主页",
    desc: "选择简历草稿或发布版，按需加入项目档案，调整模板与主题并实时预览、下载静态主页。基础身份信息默认脱敏，项目正文仍需自行核对。",
    badge: "静态站点生成",
    actionText: "进入作品集工作台",
  },
];

export default function ToolsPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            求职特战工具箱
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            轻量实用外挂工具矩阵，随取随用，覆盖考点解码、简历审阅、敏感经历表达与薪酬谈判练习。
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {TOOLS.map((t) => {
          const isDanger = t.href.includes("defense");
          const isSalary = t.href.includes("salary");
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`group rounded-2xl border p-6 shadow-card-subtle transition-all duration-200 flex flex-col justify-between ${
                isSalary
                  ? "border-primary/40 bg-primary-soft/30 hover:border-primary/70 hover:shadow-card-float"
                  : isDanger
                    ? "border-danger/30 bg-card hover:border-danger/60 hover:shadow-card-float"
                    : "border-line bg-card hover:border-primary/60 hover:shadow-card-float"
              }`}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <span className={`font-serif text-lg font-bold transition-colors ${
                    isSalary ? "text-primary" : isDanger ? "text-danger" : "text-ink group-hover:text-primary"
                  }`}>
                    {t.title}
                  </span>
                  <span className={`shrink-0 inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                    isSalary
                      ? "border-primary/30 bg-primary-soft text-primary"
                      : isDanger
                        ? "border-danger/30 bg-danger-wash text-danger"
                        : "border-primary/20 bg-primary-soft text-primary"
                  }`}>
                    {t.badge}
                  </span>
                </div>
                <p className="text-xs text-muted leading-relaxed">
                  {t.desc}
                </p>
              </div>

              <div className={`pt-4 mt-4 border-t flex items-center justify-between text-xs font-bold transition-colors ${
                isSalary
                  ? "border-primary/20 text-primary"
                  : isDanger
                    ? "border-danger/20 text-danger"
                    : "border-line/60 text-primary"
              }`}>
                <span>{t.actionText}</span>
                <span aria-hidden className="transition-transform group-hover:translate-x-1.5 font-sans">→</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
