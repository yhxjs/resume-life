import type { ResumeStyle } from "./template-styles";
import type { ResumeStyleOverrides } from "./templates";

/** 标准 96 DPI 下 A4 纸张物理高度（297mm ≈ 1122.52px） */
export const A4_HEIGHT_PX = 1123;

export type PageFitStatus = {
  /** 是否完美收纳于单页内 */
  isSinglePage: boolean;
  /** 内容高度占单页 A4 的百分比（例如 94% 或 105%） */
  heightPercent: number;
  /** 溢出单页的绝对像素量（未溢出为 0） */
  overflowPx: number;
  /** 预估多出/溢出的行数（未溢出为 0） */
  overflowLines: number;
};

/**
 * 计算当前内容相对于单页 A4 的适应状态与溢出行数估算
 */
export function estimatePageFitStatus(
  contentHeight: number,
  targetHeight: number = A4_HEIGHT_PX,
  style?: Partial<ResumeStyle>
): PageFitStatus {
  const safeContent = Math.max(0, Math.round(contentHeight));
  const safeTarget = Math.max(100, Math.round(targetHeight));
  const isSinglePage = safeContent <= safeTarget;
  const overflowPx = isSinglePage ? 0 : safeContent - safeTarget;

  const baseSize = style?.baseSize ?? 12;
  const lineHeight = style?.lineHeight ?? 1.55;
  const descItemGap = style?.descItemGap ?? 2;
  const approxLineHeight = Math.max(12, baseSize * lineHeight + descItemGap);

  const overflowLines = isSinglePage
    ? 0
    : Math.max(1, Math.ceil(overflowPx / approxLineHeight));

  const heightPercent = Math.round((safeContent / safeTarget) * 100);

  return {
    isSinglePage,
    heightPercent,
    overflowPx,
    overflowLines,
  };
}

/**
 * 多阶渐进智能单页压缩算法
 *
 * 针对最后多出 2-3 行导致难看跨页的痛点：
 * - 阶梯 1（无损间距）：收敛模块间距 (sectionGap)、条目间距 (entryGap)、描述要点间距 (descItemGap)、页面边距 (pageMargin)；
 * - 阶梯 2（轻度紧凑）：若溢出比例较高，步进紧凑行高 (lineHeight)；
 * - 阶梯 3（微调字号）：若极端溢出，微调正文字号 (baseSize)。
 *
 * 纯函数，输入当前基准样式与真实纸张高度，返回推荐的简历级覆盖参数。
 */
export function calculateAutoFitOverrides(
  baseStyle: ResumeStyle,
  currentContentHeight: number,
  targetHeight: number = A4_HEIGHT_PX
): ResumeStyleOverrides {
  // 如果本来就在单页内，不需要任何压缩覆盖
  if (currentContentHeight <= targetHeight) {
    return {};
  }

  const overflowRatio = (currentContentHeight - targetHeight) / targetHeight;
  const overrides: ResumeStyleOverrides = {};

  const gapFactor = Math.min(1, Math.max(0.15, overflowRatio / 0.12));

  // 模块上下间距收敛（最低保底 6px / 3px）
  const minSectionBefore = 6;
  const minSectionAfter = 3;
  overrides.sectionGapBefore = Math.max(
    minSectionBefore,
    Math.round(baseStyle.sectionGapBefore - (baseStyle.sectionGapBefore - minSectionBefore) * gapFactor)
  );
  overrides.sectionGapAfter = Math.max(
    minSectionAfter,
    Math.round(baseStyle.sectionGapAfter - (baseStyle.sectionGapAfter - minSectionAfter) * gapFactor)
  );

  // 经历条目间距与描述点间距收敛（最低保底 5px / 1px）
  const minEntryGap = 5;
  const minDescItemGap = 1;
  overrides.entryGap = Math.max(
    minEntryGap,
    Math.round(baseStyle.entryGap - (baseStyle.entryGap - minEntryGap) * gapFactor)
  );
  const baseDescGap = baseStyle.descItemGap ?? 2;
  overrides.descItemGap = Math.max(
    minDescItemGap,
    Math.round(baseDescGap - (baseDescGap - minDescItemGap) * gapFactor)
  );

  // 页面边距微调：从 13~16mm 适度收敛到 10~11mm
  if (baseStyle.pageMargin > 10) {
    const marginReduction = Math.min(3.5, overflowRatio * 30);
    overrides.pageMargin = Math.max(10, Math.round((baseStyle.pageMargin - marginReduction) * 10) / 10);
  }

  if (overflowRatio > 0.035) {
    const lineRatio = Math.min(1, (overflowRatio - 0.035) / 0.12);
    const minLineHeight = 1.42;
    overrides.lineHeight = Math.max(
      minLineHeight,
      Math.round((baseStyle.lineHeight - (baseStyle.lineHeight - minLineHeight) * lineRatio * 0.75) * 100) / 100
    );
  }

  if (overflowRatio > 0.09) {
    const fontRatio = Math.min(1, (overflowRatio - 0.09) / 0.1);
    const minBaseSize = 11.0;
    overrides.baseSize = Math.max(
      minBaseSize,
      Math.round((baseStyle.baseSize - (baseStyle.baseSize - minBaseSize) * fontRatio * 0.6) * 10) / 10
    );
  }

  return overrides;
}
