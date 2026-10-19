/**
 * 简历缩放核心算子与常量定义
 */

/** A4 纸张宽度在标准 96 DPI 下对应的像素宽度（210mm） */
export const A4_BASE_WIDTH = 794;

/** 最小与最大允许缩放比例 */
export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.0;

/** 默认快捷预设档位 */
export const ZOOM_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5] as const;

/**
 * 根据容器实际可用宽度计算等比自适应缩放比
 * @param containerWidth 容器实际宽度（像素）
 * @param padding 左右边距和安全余量总和，默认 32px
 */
export function calcFitWidthScale(containerWidth: number, padding = 32): number {
  if (containerWidth <= 0) return 1;
  const available = Math.max(0, containerWidth - padding);
  const raw = available / A4_BASE_WIDTH;
  // 向下舍入保留两位小数，确保缩放后的实际像素绝对不会超出容器可用宽度导致意外出现横向微溢出与振荡
  const floored = Math.floor(raw * 100) / 100;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, floored));
}

/**
 * 获取放大时上一档的目标比例
 * 若当前比例在预设档位之间，优先跳到大于当前值的最近预设档；若超出最大预设档则按 +25% 递增
 */
export function getNextZoomIn(currentScale: number): number {
  const rounded = Math.round(currentScale * 100) / 100;
  for (const preset of ZOOM_PRESETS) {
    if (preset > rounded + 0.01) {
      return preset;
    }
  }
  const next = Math.round((rounded + 0.25) * 100) / 100;
  return Math.min(MAX_SCALE, next);
}

/**
 * 获取缩小时下一档的目标比例
 * 若当前比例在预设档位之间，优先跳到小于当前值的最近预设档；若低于最小预设档则按 -25% 递减
 */
export function getNextZoomOut(currentScale: number): number {
  const rounded = Math.round(currentScale * 100) / 100;
  for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) {
    const preset = ZOOM_PRESETS[i];
    if (preset !== undefined && preset < rounded - 0.01) {
      return preset;
    }
  }
  const prev = Math.round((rounded - 0.25) * 100) / 100;
  return Math.max(MIN_SCALE, prev);
}

/**
 * 根据滚轮 deltaY 线性计算目标缩放比例
 * 严格保持线性增量（固定滚动量对应固定的绝对缩放增减比例，例如每 100px 对应 5%），
 * 限制在 [MIN_SCALE, MAX_SCALE] 之间，保留两位小数
 */
export function calcWheelZoom(currentScale: number, deltaY: number): number {
  // deltaY > 0 为向下滚（缩小），deltaY < 0 为向上滚（放大）
  // 采用恒定线性系数，每 100px delta 线性增减 0.05 (5%)
  const deltaScale = -deltaY * 0.0005;
  const next = currentScale + deltaScale;
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
  return Math.round(clamped * 100) / 100;
}

/**
 * 格式化缩放比例显示为百分比文本（如 1.0 -> "100%", 0.75 -> "75%"）
 */
export function formatZoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
