import Link from "next/link";

const TOOLS = [
  {
    href: "/tools/jd",
    title: "JD 考点画像",
    desc: "粘贴一段岗位要求，AI 解析生成考点雷达：必考技能、可能追问方向与公司风格猜测，面试前定向准备。",
    badge: "考点雷达",
    actionText: "立即使用画像工具",
  },
  {
    href: "/tools/decoder",
    title: "面试黑话与暗号解码器",
    desc: "一键穿透“抗压能力强”、“拥抱变化”、“从0到1”等 JD 潜台词，揭示工作真相、面试应对潜规则与反向提问避坑指南。",
    badge: "暗号解码",
    actionText: "立即开始暗号解码",
  },
  {
    href: "/tools/defense",
    title: "简历排雷与防御演练",
    desc: "AI 扮演毒舌大厂面试官逐行排雷，圈出假大空、数据疑点与术语堆砌等高危软肋，提供防御预案与抽屉式即问即评自辩对练。",
    badge: "毒舌面试官 · 攻防演练",
    actionText: "开始简历排雷与自辩",
  },
  {
    href: "/tools/gap",
    title: "离职原因与空窗期高情商对策库",
    desc: "针对裁员、内耗、裸辞、Gap、考公考研或创业试错等敏感经历，重塑为合理求职动机与成长契机，生成 HR 听着舒适合规的话术。",
    badge: "敏感经历重塑",
    actionText: "查看高情商对策库",
  },
  {
    href: "/tools/salary",
    title: "Offer 谈判与薪酬博弈模拟器",
    desc: "输入目标公司等级、期望薪资与竞品底牌，AI 扮演 HR 施压拉扯，右侧实时军师拆解说服逻辑并示范高情商话术。",
    badge: "双重视角博弈",
    actionText: "进入薪酬博弈战场",
  },
  {
    href: "/tools/portfolio",
    title: "个人作品集与静态主页",
    desc: "将简历发布版本与项目库深度档案智能合成，脱敏生成现代化响应式静态站点 Zip 包，解压即可上线或离线浏览。",
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
            轻量实用外挂工具矩阵，随取随用，覆盖考点解码、毒舌排雷、敏感经历重塑与薪酬拉扯博弈。
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
