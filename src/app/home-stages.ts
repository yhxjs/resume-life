export type StageItem = {
  href: string;
  title: string;
  desc: string;
  badge: string;
  highlight?: boolean;
  primaryBadge?: boolean;
};

export type StageGroup = {
  stage: string;
  tag: string;
  isCore?: boolean;
  title: string;
  sub: string;
  desc: string;
  footerText: string;
  footerLink: string;
  footerLinkText: string;
  items: StageItem[];
};

/** 备考四大阶段定义与结构化功能项 */
export const STAGES: StageGroup[] = [
  {
    stage: "01",
    tag: "STAGE 01",
    title: "筑基储备 · 素材与简历",
    sub: "打好地基，言之有物",
    desc: "梳理过往经历，沉淀真实技术材料，由 AI 提炼 STAR 亮点并结构化打造工业级排版简历。",
    footerText: "建立简历 · 沉淀项目知识库",
    footerLink: "/resumes",
    footerLinkText: "进入筑基工作台 →",
    items: [
      {
        href: "/applications",
        title: "求职看板",
        desc: "投递漏斗转化、面试日程排期与简历/JD/模拟面试全景打通，掌控应聘全流程。",
        badge: "全流程看板",
        primaryBadge: true,
      },
      {
        href: "/resumes",
        title: "简历管理",
        desc: "多份简历并存、六大模块结构化维护；导入 PDF/Word 解析并导出打印级 A4 PDF。",
        badge: "核心工作台",
      },
      {
        href: "/styles",
        title: "样式工厂",
        desc: "模板预设一键切换，AI 自然语言排版微调，调配专属于自己的简历版式风格。",
        badge: "排版微调",
      },
      {
        href: "/knowledge",
        title: "知识库",
        desc: "沉淀项目设计文档与上线复盘材料，由 AI 提炼 STAR 亮点并一键摘录进简历。",
        badge: "项目沉淀",
      },
    ],
  },
  {
    stage: "02",
    tag: "STAGE 02",
    isCore: true,
    title: "实战淬炼 · 模考与口才",
    sub: "高压逼真，逐题深挖",
    desc: "针对项目与目标岗位针对性出题，全真多轮高压文字模考与逐句表达打磨脱稿演练。",
    footerText: "高压沙盘 · 建议临考前每日一练",
    footerLink: "/interviews",
    footerLinkText: "开启演练场 →",
    items: [
      {
        href: "/interviews",
        title: "模拟面试",
        desc: "输入岗位 JD、选择简历，逐题动态深度出题；支持单轮模考与技术初试/复试/HR 三轮进阶连打。",
        badge: "全真考场",
        highlight: true,
      },
      {
        href: "/drills",
        title: "题目练习",
        desc: "项目深挖题基于真实项目生成，岗位通用题按 JD/方向出题；逐题即时评分与四维小分批阅。",
        badge: "专项精练",
      },
      {
        href: "/intros",
        title: "自我介绍工坊",
        desc: "按简历与岗位定制 30 秒/2 分钟两版自我介绍，逐句点评打磨，背诵遮罩脱稿演练。",
        badge: "演讲表达",
      },
    ],
  },
  {
    stage: "03",
    tag: "STAGE 03",
    title: "复盘精进 · 归纳与题源",
    sub: "温故知新，查漏补缺",
    desc: "透视四维能力短板，错题二刷归纳攻克，沉淀通用八股与行为考题作为出题基石。",
    footerText: "每场必复盘 · 聚合四维能力成长",
    footerLink: "/review",
    footerLinkText: "进入复盘看板 →",
    items: [
      {
        href: "/review",
        title: "复盘看板",
        desc: "跨练习与面试聚合四维评分：历史成长折线走势、能力雷达对比与按项目的作答深度分布。",
        badge: "量化看板",
      },
      {
        href: "/notebook",
        title: "错题本",
        desc: "收藏演练与面试中翻车的题目，自定义分类归纳，连同历史作答与导师解析随时温习。",
        badge: "定向消错",
      },
      {
        href: "/bank",
        title: "岗位题库",
        desc: "导入岗位通用的八股与行为题，按方向归类沉淀，作为 AI 练习与模考出题的底层参考题源。",
        badge: "通用题源",
      },
    ],
  },
  {
    stage: "04",
    tag: "STAGE 04",
    title: "定向突破 · 工具与模型",
    sub: "趁手利器，保驾护航",
    desc: "岗位 JD 画像解析、黑话解码、薪资谈判沙盘模拟以及底层 AI 模型调度设置。",
    footerText: "多维助手 · 赋能攻坚每处细节",
    footerLink: "/tools",
    footerLinkText: "打开工具箱 →",
    items: [
      {
        href: "/tools",
        title: "求职工具箱",
        desc: "JD 考点画像拆解、岗位黑话暗语解码、防守答疑与实操薪资谈判沙盘推演。",
        badge: "画像与谈薪",
      },
      {
        href: "/settings",
        title: "AI 系统设置",
        desc: "配置 OpenAI 兼容服务凭证与解析、总结、出题、评分任务级模型分工体系。",
        badge: "系统配置",
      },
    ],
  },
];
