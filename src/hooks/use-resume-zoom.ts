"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  calcFitWidthScale,
  getNextZoomIn,
  getNextZoomOut,
  calcWheelZoom,
  MIN_SCALE,
  MAX_SCALE,
} from "@/lib/zoom";

export interface UseResumeZoomOptions {
  /** 初始缩放模式：auto 代表自适应容器宽度，manual 代表使用固定比例 */
  defaultMode?: "auto" | "manual";
  /** 手动模式下的初始比例，默认 1.0 (100%) */
  defaultManualScale?: number;
  /** 容器内边距扣除值（单位 px），默认 32 */
  padding?: number;
}

export interface UseResumeZoomReturn {
  mode: "auto" | "manual";
  scale: number;
  autoScale: number;
  isAutoFit: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  isPanning: boolean;
  isSpacePressed: boolean;
  isCtrlPressed: boolean;
  viewportClassName: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  paperRef: React.RefObject<HTMLDivElement | null>;
  paperHeight: number;
  zoomIn: () => void;
  zoomOut: () => void;
  setManualScale: (target: number) => void;
  resetToAuto: () => void;
  handleViewportPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function useResumeZoom({
  defaultMode = "auto",
  defaultManualScale = 1.0,
  padding = 32,
}: UseResumeZoomOptions = {}): UseResumeZoomReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);

  const [mode, setMode] = useState<"auto" | "manual">(defaultMode);
  const [autoScale, setAutoScale] = useState(0.7);
  const [manualScale, setManualScaleState] = useState(defaultManualScale);
  const [paperHeight, setPaperHeight] = useState(1123);

  // 抓手平移与空格键、Ctrl/Cmd 键状态
  const [isPanning, setIsPanning] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isCtrlPressed, setIsCtrlPressed] = useState(false);
  const panStartRef = useRef<{
    startX: number;
    startY: number;
    startScrollLeft: number;
    startScrollTop: number;
  } | null>(null);

  // 测量容器尺寸与纸张高度（带防抖与迟滞保护，彻底杜绝一页临界点垂直滚动条显隐振荡引发的抖动与重影）
  const measure = useCallback(() => {
    const container = containerRef.current;
    const paper = paperRef.current;
    if (!container) return;

    if (container.clientWidth > 0) {
      const calculated = calcFitWidthScale(container.clientWidth, padding);
      setAutoScale((prev) => {
        // 迟滞保护（hysteresis）：滚动条宽度约为 17px，折合 scale 差值约为 0.021
        // 如果当前值与新值仅相差 <= 0.025，且已有有效值，则保持当前 scale，避免反复跳变
        if (prev > 0 && Math.abs(calculated - prev) < 0.025) {
          return prev;
        }
        return calculated;
      });
    }
    if (paper && paper.offsetHeight > 0) {
      setPaperHeight((prev) => {
        // 纸张高度微差防抖（防止 297mm 在小数像素 1122~1123 之间抖动）
        if (Math.abs(prev - paper.offsetHeight) <= 2) {
          return prev;
        }
        return paper.offsetHeight;
      });
    }
  }, [padding]);

  useEffect(() => {
    measure();
    const container = containerRef.current;
    const paper = paperRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        measure();
      });
    });
    ro.observe(container);
    if (paper) ro.observe(paper);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [measure]);

  const effectiveScale = mode === "auto" ? autoScale : manualScale;

  const setManualScale = useCallback((target: number) => {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(target * 100) / 100));
    setManualScaleState(clamped);
    setMode("manual");
  }, []);

  const resetToAuto = useCallback(() => {
    setMode("auto");
    measure();
  }, [measure]);

  const zoomIn = useCallback(() => {
    const next = getNextZoomIn(effectiveScale);
    setManualScale(next);
  }, [effectiveScale, setManualScale]);

  const zoomOut = useCallback(() => {
    const next = getNextZoomOut(effectiveScale);
    setManualScale(next);
  }, [effectiveScale, setManualScale]);

  // 全局修饰键（Space / Ctrl / Meta）监听：在非输入态下切换抓手光标与抓手模式
  useEffect(() => {
    const isEditingElement = (el: Element | null) =>
      Boolean(el?.closest("button, a[href], input, textarea, select, [role='button'], [role='link'], [contenteditable='true']"));

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditingElement(document.activeElement)) return;

      if (e.code === "Space") {
        // 防止页面空格滚动
        e.preventDefault();
        setIsSpacePressed(true);
      } else if (e.key === "Control" || e.key === "Meta") {
        setIsCtrlPressed(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      } else if (e.key === "Control" || e.key === "Meta") {
        setIsCtrlPressed(false);
      }
    };

    const handleWindowBlur = () => {
      setIsSpacePressed(false);
      setIsCtrlPressed(false);
    };

    window.addEventListener("keydown", handleKeyDown, { passive: false });
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, []);

  // Ctrl / Cmd + 滚轮缩放监听
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // 阻止浏览器默认页面缩放

      const currentScale = mode === "auto" ? autoScale : manualScale;
      const targetScale = calcWheelZoom(currentScale, e.deltaY);
      if (Math.abs(targetScale - currentScale) < 0.005) return;

      // 计算鼠标在当前内容坐标系中的绝对位置，保持锚点位置在缩放后不发生跳动
      const rect = container.getBoundingClientRect();
      const mouseViewportX = e.clientX - rect.left;
      const mouseViewportY = e.clientY - rect.top;

      const contentX = (container.scrollLeft + mouseViewportX) / currentScale;
      const contentY = (container.scrollTop + mouseViewportY) / currentScale;

      setManualScaleState(targetScale);
      setMode("manual");

      // 异步在下一帧校正滚动位置，保证平滑稳定
      requestAnimationFrame(() => {
        container.scrollLeft = contentX * targetScale - mouseViewportX;
        container.scrollTop = contentY * targetScale - mouseViewportY;
      });
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [mode, autoScale, manualScale]);

  // 鼠标按住拖拽平移事件处理
  const handleViewportPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;

      const target = e.target as HTMLElement | null;
      const isMiddleClick = e.button === 1;
      const isLeftClick = e.button === 0;

      if (!isMiddleClick && !isLeftClick) return;

      const isModifierPan = isSpacePressed || isCtrlPressed || e.ctrlKey || e.metaKey;

      // 如果是左键且没有按修饰键（Space / Ctrl / Meta）：判断是否点击在非纸张空白区
      if (isLeftClick && !isModifierPan) {
        // 如果点击在纸张内容区（.paper 或其子元素），保持原有文字选中与寸照微调行为，不平移
        if (target?.closest(".paper")) {
          return;
        }
      }

      // 如果点击在交互式控件（按钮、链接、输入框等），不平移
      if (target?.closest("button, a, input, [role='button'], [role='option']")) {
        return;
      }

      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startScrollLeft: container.scrollLeft,
        startScrollTop: container.scrollTop,
      };

      const currentTarget = e.currentTarget;
      currentTarget.setPointerCapture(e.pointerId);

      const onPointerMove = (moveEvent: PointerEvent) => {
        const panState = panStartRef.current;
        if (!panState) return;
        const dx = moveEvent.clientX - panState.startX;
        const dy = moveEvent.clientY - panState.startY;
        container.scrollLeft = panState.startScrollLeft - dx;
        container.scrollTop = panState.startScrollTop - dy;
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        currentTarget.removeEventListener("pointermove", onPointerMove);
        currentTarget.removeEventListener("pointerup", onPointerUp);
        currentTarget.removeEventListener("pointercancel", onPointerUp);
        try {
          currentTarget.releasePointerCapture(upEvent.pointerId);
        } catch {
          // pointer capture 安全兜底
        }
        setIsPanning(false);
        panStartRef.current = null;
      };

      currentTarget.addEventListener("pointermove", onPointerMove);
      currentTarget.addEventListener("pointerup", onPointerUp);
      currentTarget.addEventListener("pointercancel", onPointerUp);
    },
    [isSpacePressed, isCtrlPressed]
  );

  const canZoomIn = effectiveScale < MAX_SCALE - 0.01;
  const canZoomOut = effectiveScale > MIN_SCALE + 0.01;

  // 动态视口光标类名：拖动中为 grabbing，按住 Space / Ctrl / Meta 时悬停为 grab
  const viewportClassName = isPanning
    ? "cursor-grabbing select-none"
    : isSpacePressed || isCtrlPressed
    ? "cursor-grab"
    : "";

  return {
    mode,
    scale: effectiveScale,
    autoScale,
    isAutoFit: mode === "auto",
    canZoomIn,
    canZoomOut,
    isPanning,
    isSpacePressed,
    isCtrlPressed,
    viewportClassName,
    containerRef,
    paperRef,
    paperHeight,
    zoomIn,
    zoomOut,
    setManualScale,
    resetToAuto,
    handleViewportPointerDown,
  };
}
