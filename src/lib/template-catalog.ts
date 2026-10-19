export type TemplateKey =
  | "classic"
  | "modern"
  | "twocol"
  | "tech"
  | "minimal"
  | "academic"
  | "compact"
  | "executive"
  | "ats"
  | "creative"
  | "twocol_card"
  | "banner_navy"
  | "banner_dark"
  | "banner_teal"
  | "card_purple"
  | "banner_twocol";

export type TemplateCategory =
  | "all"
  | "general"
  | "banner"
  | "tech"
  | "minimal"
  | "academic"
  | "compact"
  | "executive"
  | "creative";

export type ResumeTemplateMeta = {
  key: TemplateKey;
  label: string;
  desc: string;
  category: TemplateCategory;
  tags: string[];
  previewColor: string;
};

export const RESUME_TEMPLATES: ResumeTemplateMeta[] = [
  {
    key: "classic",
    label: "经典单栏",
    desc: "居中标题 + 分隔线，稳重通用，适合传统国企/外企/教育",
    category: "general",
    tags: ["经典", "通用", "单栏", "宋体"],
    previewColor: "#262626",
  },
  {
    key: "banner_navy",
    label: "通栏商务蓝",
    desc: "顶部深蓝通栏色块横幅 + 白字沉稳，层次分明，名企高管/金融首选",
    category: "banner",
    tags: ["顶部色块", "通栏", "商务", "大气"],
    previewColor: "#1e3a8a",
  },
  {
    key: "banner_dark",
    label: "通栏黑曜石",
    desc: "顶部极客黑通栏色块 + 青蓝点缀，对比鲜明，技术专家/架构师必备",
    category: "banner",
    tags: ["顶部色块", "通栏", "极客黑", "科技"],
    previewColor: "#0f172a",
  },
  {
    key: "banner_teal",
    label: "通栏松石绿",
    desc: "顶部深青松石绿通栏色块，清新高级脱俗，适合产品经理/运营主管",
    category: "banner",
    tags: ["顶部色块", "通栏", "松石绿", "现代"],
    previewColor: "#0f766e",
  },
  {
    key: "card_purple",
    label: "卡片紫罗兰",
    desc: "页眉圆角悬浮色块卡片，优雅轻奢，适合设计/品牌策划/文创新媒体",
    category: "banner",
    tags: ["顶部色块", "卡片式", "紫罗兰", "设计感"],
    previewColor: "#6d28d9",
  },
  {
    key: "banner_twocol",
    label: "通栏双栏风",
    desc: "顶部通栏色块横幅 + 下方双栏排版，信息容量大且视觉冲击强",
    category: "banner",
    tags: ["顶部色块", "双栏", "通栏", "全能"],
    previewColor: "#1d4ed8",
  },
  {
    key: "modern",
    label: "现代简约",
    desc: "左对齐大标题 + 强调色小节，清爽紧凑，适合互联网各岗位",
    category: "general",
    tags: ["现代", "清爽", "单栏", "蓝调"],
    previewColor: "#2563eb",
  },
  {
    key: "twocol",
    label: "双栏专业",
    desc: "侧栏放基本信息/技能/评价，主栏放经历，层次分明高效",
    category: "general",
    tags: ["双栏", "高效", "层次感"],
    previewColor: "#2563eb",
  },
  {
    key: "tech",
    label: "极客工程师",
    desc: "极客青蓝 + 左侧强调条，代码风格技能标签，紧凑科技感",
    category: "tech",
    tags: ["技术", "研发", "极客", "单栏"],
    previewColor: "#0284c7",
  },
  {
    key: "minimal",
    label: "极简纯粹",
    desc: "无多余装饰，纯粹黑灰与精致留白，突出文字内容本身",
    category: "minimal",
    tags: ["极简", "无装饰", "设计感", "黑白"],
    previewColor: "#171717",
  },
  {
    key: "academic",
    label: "学术科研",
    desc: "严谨宋体 + 经典学术深蓝，下划线分隔，论文报告风范",
    category: "academic",
    tags: ["学术", "科研", "硕博", "宋体"],
    previewColor: "#1e3a8a",
  },
  {
    key: "compact",
    label: "高密紧凑",
    desc: "紧凑行高与边距控制，单页容纳更多经历，适合资深骨干",
    category: "compact",
    tags: ["高密度", "多经历", "单页控", "紧凑"],
    previewColor: "#334155",
  },
  {
    key: "executive",
    label: "商务精英",
    desc: "深邃藏青 + 色块小节标题，稳重权威，适合管理/咨询/金融",
    category: "executive",
    tags: ["管理", "商务", "色块", "高端"],
    previewColor: "#0f172a",
  },
  {
    key: "ats",
    label: "ATS 通关标准",
    desc: "标准黑白对比与单栏排版，无花哨样式，利于招聘系统解析",
    category: "general",
    tags: ["ATS友好", "外企招聘", "易解析"],
    previewColor: "#1f2937",
  },
  {
    key: "creative",
    label: "活力创意",
    desc: "紫罗兰个性强调色 + 鲜明副标题，适合产品/运营/品牌策划",
    category: "creative",
    tags: ["创意", "设计", "新媒体", "个性"],
    previewColor: "#7c3aed",
  },
  {
    key: "twocol_card",
    label: "双栏雅致",
    desc: "墨绿雅致双栏，侧栏清爽，主栏项目经历丰富舒展",
    category: "general",
    tags: ["双栏", "墨绿", "雅致", "全能"],
    previewColor: "#059669",
  },
];

