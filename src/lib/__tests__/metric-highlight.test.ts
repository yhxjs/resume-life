import { describe, expect, it } from "vitest";
import {
  fillSampleValues,
  findMetricSpans,
  segmentForPreview,
  segmentsToHtml,
} from "../metric-highlight";

/** 取出识别到的片段文本，便于断言 */
function texts(input: string): string[] {
  return findMetricSpans(input).map((s) => s.text);
}

describe("findMetricSpans", () => {
  it("识别百分比", () => {
    expect(texts("首屏耗时降低 30%")).toEqual(["降低 30%"]);
  });

  it("百分比前无动词时只取数值与单位", () => {
    expect(texts("复用率 60%")).toEqual(["60%"]);
  });

  it("识别数值 + 英文单位", () => {
    expect(texts("P99 延迟从 2.5s 降至 0.8s")).toEqual(["从 2.5s 降至 0.8s"]);
  });

  it("识别中文数量单位", () => {
    expect(texts("支撑日活 10 万+ 的稳定运行")).toEqual(["10 万+"]);
    expect(texts("共 12 个团队")).toEqual(["12 个"]);
  });

  it("识别倍数", () => {
    expect(texts("吞吐提升 3 倍")).toEqual(["提升 3 倍"]);
  });

  it("识别吞吐类英文指标缩写", () => {
    expect(texts("峰值 QPS 5000")).toEqual(["QPS 5000"]);
    expect(texts("DAU 达 100 万")).toEqual(["DAU 达 100 万"]);
  });

  it("指标片段不带尾随空格", () => {
    expect(texts("峰值 QPS 5000 后回落")).toEqual(["QPS 5000"]);
  });

  it("识别千分位与小数", () => {
    expect(texts("累计 1,200 万条")).toEqual(["1,200 万条"]);
  });

  it("从/由 起头的变化区间是同一个片段", () => {
    expect(texts("周期从 5 天缩短到 2 天")).toEqual(["从 5 天缩短到 2 天"]);
    expect(texts("TP99 由 280ms 降至 65ms")).toEqual(["由 280ms 降至 65ms"]);
  });

  it("箭头形式的变化区间", () => {
    expect(texts("吞吐量 20% → 80%")).toEqual(["20% → 80%"]);
  });

  it("无量化指标时返回空数组", () => {
    expect(findMetricSpans("负责团队前端架构重构与组件库建设")).toEqual([]);
  });

  it("年份不被误标", () => {
    expect(findMetricSpans("2024 年加入团队")).toEqual([]);
    expect(findMetricSpans("2024年加入团队")).toEqual([]);
  });

  it("裸「月」不在单位白名单，坐标式日期不被误标", () => {
    expect(findMetricSpans("2024年3月—2025年6月 任职于某公司")).toEqual([]);
    expect(findMetricSpans("工作时间：2024年3月到2025年6月")).toEqual([]);
    expect(findMetricSpans("2022年3月至2024年6月")).toEqual([]);
    expect(findMetricSpans("入职时间：2024年3月")).toEqual([]);
  });

  it("「个月」仍在单位白名单", () => {
    expect(texts("耗时 3 个月")).toEqual(["3 个月"]);
  });

  it("方括号占位符里的数字不被当作已成立的成果", () => {
    expect(findMetricSpans("支撑 [请填入真实规模，例如：日活10万+] 的运行")).toEqual([]);
  });

  it("多指标按位置升序且互不重叠", () => {
    const spans = findMetricSpans("首屏降低 40%，构建耗时减少 2 分钟，日活 10 万+");
    expect(spans.map((s) => s.text)).toEqual(["降低 40%", "减少 2 分钟", "10 万+"]);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });

  it("span 的 start/end 与原文切片一致", () => {
    const input = "构建耗时优化 40%";
    const [span] = findMetricSpans(input);
    expect(input.slice(span!.start, span!.end)).toBe(span!.text);
  });

  it("括号内与句尾的指标都能识别", () => {
    expect(texts("优化构建（耗时降低 40%）")).toEqual(["降低 40%"]);
    expect(texts("整体效率提升 3 倍")).toEqual(["提升 3 倍"]);
  });
});

describe("fillSampleValues", () => {
  it("把带「例如」的占位符替换为示例值", () => {
    const r = fillSampleValues("首屏耗时降低 [请填入真实提升%，例如：30%]");
    expect(r.text).toBe("首屏耗时降低 30%");
    expect(r.filled.map((f) => f.value)).toEqual(["30%"]);
  });

  it("支持全角冒号", () => {
    const r = fillSampleValues("支撑 [请填入真实规模，例如：日活10万+] 的运行");
    expect(r.text).toBe("支撑 日活10万+ 的运行");
    expect(r.filled.map((f) => f.value)).toEqual(["日活10万+"]);
  });

  it("多个占位符按出现顺序记录", () => {
    const r = fillSampleValues(
      "降低 [请填入真实提升%，例如：30%]，规模 [请填入真实规模，例如：日活10万+]"
    );
    expect(r.filled.map((f) => f.value)).toEqual(["30%", "日活10万+"]);
    expect(r.text).toBe("降低 30%，规模 日活10万+");
  });

  it("不含「例如」的占位符保持原样", () => {
    const input = "性能提升 [请填入真实数据]";
    const r = fillSampleValues(input);
    expect(r.text).toBe(input);
    expect(r.filled.map((f) => f.value)).toEqual([]);
  });

  it("无占位符时原样返回", () => {
    const input = "主导订单链路重构";
    const r = fillSampleValues(input);
    expect(r.text).toBe(input);
    expect(r.filled.map((f) => f.value)).toEqual([]);
  });

  it("占位符外的正文不受影响", () => {
    const r = fillSampleValues("例如这是正文 [请填入真实数据，例如：20%] 收尾");
    expect(r.text).toBe("例如这是正文 20% 收尾");
    expect(r.filled.map((f) => f.value)).toEqual(["20%"]);
  });

  it("空字符串安全", () => {
    expect(fillSampleValues("")).toEqual({ text: "", filled: [] });
  });

  it("filled 带出被替换值在结果文本中的区间", () => {
    const r = fillSampleValues("首屏耗时降低 [请填入真实提升%，例如：30%]");
    expect(r.text).toBe("首屏耗时降低 30%");
    expect(r.filled).toEqual([{ value: "30%", start: 7, end: 10 }]);
    expect(r.text.slice(7, 10)).toBe("30%");
  });

  it("多个占位符的区间各自正确且按出现顺序", () => {
    const r = fillSampleValues(
      "降低 [请填入真实提升%，例如：30%]，规模 [请填入真实规模，例如：日活10万+]"
    );
    expect(r.filled.map((f) => f.value)).toEqual(["30%", "日活10万+"]);
    for (const f of r.filled) expect(r.text.slice(f.start, f.end)).toBe(f.value);
  });
});

const PLAIN = { bold: true, color: "inherit" };

describe("segmentForPreview", () => {
  it("按量化片段切分，非指标部分是 text 片段", () => {
    const segs = segmentForPreview("首屏降低 40% 完成", PLAIN);
    expect(segs.map((s) => s.kind)).toEqual(["text", "metric", "text"]);
    expect(segs[0]).toEqual({ kind: "text", text: "首屏" });
    expect(segs[2]).toEqual({ kind: "text", text: " 完成" });
  });

  it("片段文本拼接后等于原文", () => {
    const input = "P99 从 2.5s 降至 0.8s，日活 10 万+";
    const segs = segmentForPreview(input, PLAIN);
    expect(segs.map((s) => s.text).join("")).toBe(input);
  });

  it("bold 选项透传到片段", () => {
    const segs = segmentForPreview("降低 40%", { bold: false, color: "inherit" });
    const metric = segs.find((s) => s.kind === "metric");
    expect(metric).toMatchObject({ bold: false, isSample: false });
  });

  it("color 选项透传到片段", () => {
    const segs = segmentForPreview("降低 40%", { bold: true, color: "#1d4ed8" });
    const metric = segs.find((s) => s.kind === "metric");
    expect(metric).toMatchObject({ color: "#1d4ed8" });
  });

  it("samples 命中的片段 isSample 为 true", () => {
    const r = fillSampleValues("首屏降低 [请填入真实%，例如：30%] 完成");
    const segs = segmentForPreview(r.text, { bold: true, color: "inherit", samples: r.filled });
    expect(segs.find((s) => s.kind === "metric")).toMatchObject({ isSample: true });
  });

  it("未被 samples 命中的片段 isSample 为 false", () => {
    // 示例值区间落在指标片段之前（[0,2) 与 span [2,8) 仅端点相邻，不算相交）
    const segs = segmentForPreview("首屏降低 30% 完成", {
      bold: true,
      color: "inherit",
      samples: [{ value: "99%", start: 0, end: 2 }],
    });
    expect(segs.find((s) => s.kind === "metric")).toMatchObject({ isSample: false });
  });

  it("示例值的命中按区间相交判定：填入值比 span 长时也要命中", () => {
    const r = fillSampleValues("[请填入真实规模，例如：支撑日活10万+]");
    const segs = segmentForPreview(r.text, { bold: true, color: "inherit", samples: r.filled });
    const metric = segs.find((s) => s.kind === "metric");
    expect(metric).toMatchObject({ text: "10万+", isSample: true });
  });

  it("区间形态的示例值命中", () => {
    const r = fillSampleValues("[请填入真实优化效果，例如：首屏耗时从2.5s降至0.8s]");
    const segs = segmentForPreview(r.text, { bold: true, color: "inherit", samples: r.filled });
    const metric = segs.find((s) => s.kind === "metric");
    expect(metric).toMatchObject({ text: "从2.5s降至0.8s", isSample: true });
  });

  it("prompt 三个规范范例全部命中", () => {
    for (const value of ["提升30%", "支撑日活10万+", "首屏耗时从2.5s降至0.8s"]) {
      const r = fillSampleValues(`成果：[请填入真实数据，例如：${value}]`);
      const segs = segmentForPreview(r.text, { bold: true, color: "inherit", samples: r.filled });
      expect(segs.find((s) => s.kind === "metric")).toMatchObject({ isSample: true });
    }
  });

  it("未与任何示例值区间相交的片段仍为 false", () => {
    // span 会把前导动词「提升」一并纳入（[0,6)），所以一条未相交的片段由
    // 第二条指标承担：span "12 个" 与示例值区间 [3,6) 不相交（仅端点相邻）
    const r = fillSampleValues("提升 [请填入真实数据，例如：30%]，另计 12 个团队");
    const segs = segmentForPreview(r.text, { bold: true, color: "inherit", samples: r.filled });
    const metrics = segs.filter((s) => s.kind === "metric") as {
      text: string;
      isSample: boolean;
    }[];
    expect(metrics.find((s) => s.text.includes("30%"))?.isSample).toBe(true);
    expect(metrics.find((s) => s.text.includes("12"))?.isSample).toBe(false);
  });

  it("无指标时只有一个 text 片段", () => {
    const segs = segmentForPreview("负责架构重构", PLAIN);
    expect(segs).toEqual([{ kind: "text", text: "负责架构重构" }]);
  });

  it("空字符串返回空数组", () => {
    expect(segmentForPreview("", PLAIN)).toEqual([]);
  });
});

describe("segmentsToHtml", () => {
  it("示例值写入后保留待确认标记，包括不带单位的示例数字", () => {
    for (const value of ["40%", "5000"]) {
      const filled = fillSampleValues(`收益 [请填入真实数据，例如：${value}]`);
      const html = segmentsToHtml(segmentForPreview(filled.text, { ...PLAIN, samples: filled.filled }));
      expect(html).toContain("[待确认示例：");
      expect(html).toContain(value);
    }
  });
  it("加粗片段产出 strong", () => {
    const html = segmentsToHtml([
      { kind: "text", text: "降低 " },
      { kind: "metric", text: "40%", bold: true, color: "inherit", isSample: false },
    ]);
    expect(html).toBe("降低 <strong>40%</strong>");
  });

  it("bold 为 false 时不产出 strong", () => {
    const html = segmentsToHtml([
      { kind: "metric", text: "40%", bold: false, color: "inherit", isSample: false },
    ]);
    expect(html).toBe("40%");
  });

  it("非 inherit 颜色产出 span", () => {
    const html = segmentsToHtml([
      { kind: "metric", text: "40%", bold: true, color: "#1d4ed8", isSample: false },
    ]);
    expect(html).toBe('<strong><span style="color: #1d4ed8">40%</span></strong>');
  });

  it("color 为 inherit 时不产出 span", () => {
    const html = segmentsToHtml([
      { kind: "metric", text: "40%", bold: true, color: "inherit", isSample: false },
    ]);
    expect(html).not.toContain("<span");
  });

  it("任何情况都不产出 u 标签", () => {
    const html = segmentsToHtml([
      { kind: "text", text: "a" },
      { kind: "metric", text: "40%", bold: true, color: "#1d4ed8", isSample: true },
    ]);
    expect(html).not.toContain("<u>");
  });

  it("转义尖括号与 &", () => {
    const html = segmentsToHtml([{ kind: "text", text: "a < b & c > d" }]);
    expect(html).toBe("a &lt; b &amp; c &gt; d");
  });

  it("空数组返回空串", () => {
    expect(segmentsToHtml([])).toBe("");
  });
});
