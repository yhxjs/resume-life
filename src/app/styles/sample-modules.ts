import type { ModuleData } from "@/lib/modules";

// 预览用样例数据：涵盖全部六种模块结构，让每个样式参数都有可见效果
export const SAMPLE_MODULES: Pick<ModuleData, "type" | "label" | "content">[] = [
  {
    type: "basic",
    label: "基本信息",
    content: {
      name: "林知遥",
      gender: "女",
      age: "26岁",
      phone: "138-0013-0000",
      email: "linzhiyao@example.com",
      location: "杭州",
      birthday: "1998-05",
      links: "github.com/linzhiyao",
    },
  },
  {
    type: "summary",
    label: "自我评价",
    content: {
      text: "五年后端开发经验，长期负责高并发交易链路的设计与稳定性建设，习惯以数据驱动优化，乐于沉淀可复用的工程实践。",
    },
  },
  {
    type: "work",
    label: "工作经历",
    content: [
      {
        id: "s1",
        company: "云启科技",
        title: "高级后端工程师",
        start: "2021-07",
        end: "至今",
        subItems: [
          { id: "sub1", label: "所属部门", value: "基础架构 / 交易核心组" },
          { id: "sub2", label: "核心技术", value: "Java, Spring Cloud, Kafka, Redis" },
        ],
        descriptionStyle: "unordered",
        descriptionItems: [
          "负责交易系统核心链路设计与重构，主导缓存架构升级，支撑峰值 QPS 提升 3 倍。",
          "搭建全链路压测平台与故障演练体系，推动线上 P0/P1 稳定性事故率同比下降 60%。",
          "主导微服务间异步通信治理，制定事件驱动规范，消除订单状态跨节点不一致隐患。",
        ],
        description:
          "负责交易系统核心链路设计与重构，主导缓存架构升级，支撑峰值 QPS 提升 3 倍。\n搭建全链路压测平台与故障演练体系，推动线上 P0/P1 稳定性事故率同比下降 60%。\n主导微服务间异步通信治理，制定事件驱动规范，消除订单状态跨节点不一致隐患。",
      },
      {
        id: "s2",
        company: "星河网络",
        title: "后端工程师",
        start: "2019-07",
        end: "2021-06",
        subItems: [
          { id: "sub3", label: "所属部门", value: "电商事业部 / 会员中心" },
        ],
        descriptionStyle: "ordered",
        descriptionItems: [
          "参与会员中心微服务拆分与订单领域建模，推动核心接口平均耗时从 480ms 降至 160ms。",
          "建立高频热点数据二级缓存与热点探测机制，有效抵御大促秒杀洪峰对数据库的冲击。",
        ],
        description:
          "参与会员中心微服务拆分与订单领域建模，推动核心接口平均耗时从 480ms 降至 160ms。\n建立高频热点数据二级缓存与热点探测机制，有效抵御大促秒杀洪峰对数据库的冲击。",
      },
    ],
  },
  {
    type: "projects",
    label: "项目经历",
    content: [
      {
        id: "s3",
        name: "实时数据同步平台",
        role: "技术负责人",
        start: "2022-03",
        end: "2023-08",
        subItems: [
          { id: "sub4", label: "技术栈", value: "Flink, Debezium, Kafka, ClickHouse" },
        ],
        descriptionStyle: "unordered",
        descriptionItems: [
          "基于 CDC 与分布式消息队列构建多源数据实时同步平台，覆盖业务核心表 40+ 张。",
          "创新性设计精确一次（Exactly-Once）幂等重放与断点续传机制，全链路数据一致率达 99.99%。",
          "研发端到端延迟监控与报警大盘，实现毫秒级数据漂移感知与自动化自愈修复。",
        ],
        description:
          "基于 CDC 与分布式消息队列构建多源数据实时同步平台，覆盖业务核心表 40+ 张。\n创新性设计精确一次（Exactly-Once）幂等重放与断点续传机制，全链路数据一致率达 99.99%。\n研发端到端延迟监控与报警大盘，实现毫秒级数据漂移感知与自动化自愈修复。",
      },
    ],
  },
  {
    type: "education",
    label: "教育经历",
    content: [
      {
        id: "s4",
        school: "浙江大学",
        degree: "本科",
        field: "计算机科学与技术",
        start: "2015-09",
        end: "2019-06",
        description: "GPA 3.7/4.0，两次获校一等奖学金。",
      },
    ],
  },
  {
    type: "skills",
    label: "专业技能",
    content: {
      items: ["Java / Kotlin", "MySQL · Redis · Kafka", "分布式系统设计", "Kubernetes / Docker", "系统稳定性与压测"],
    },
  },
];
