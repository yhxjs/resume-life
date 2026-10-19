"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Modal } from "@/components/common/modal";
import { btnGhost, btnPrimary } from "@/lib/ui";

interface AvatarCropperModalProps {
  open: boolean;
  imageSrc: string;
  onClose: () => void;
  onCropComplete: (file: File) => Promise<void> | void;
}

const CROP_W = 210; // 3:4 比例，宽 210
const CROP_H = 280; // 3:4 比例，高 280
const OUTPUT_W = 450;
const OUTPUT_H = 600;

export function AvatarCropperModal({
  open,
  imageSrc,
  onClose,
  onCropComplete,
}: AvatarCropperModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const zoomId = useId();
  const instructionsId = useId();

  const [scale, setScale] = useState(1);
  const [minScale, setMinScale] = useState(0.2);
  const [maxScale, setMaxScale] = useState(3);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; originX: number; originY: number }>({
    x: 0,
    y: 0,
    originX: 0,
    originY: 0,
  });

  const [saving, setSaving] = useState(false);
  // 记录「哪张图已加载完成」而不是一个布尔量：布尔量必须在 imageSrc 变化时
  // 于 effect 里同步置 false，会多触发一次渲染；改成派生值后，
  // imageSrc 一变化 imageLoaded 自动为 false，且旧图的 onload 迟到也不会误开确认按钮。
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const imageLoaded = loadedSrc !== null && loadedSrc === imageSrc;

  // 加载图片
  useEffect(() => {
    if (!open || !imageSrc) return;
    const img = new Image();
    let cancelled = false;
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      imageRef.current = img;
      // 计算初始缩放使图片铺满取景框
      const scaleX = CROP_W / img.width;
      const scaleY = CROP_H / img.height;
      const initialScale = Math.max(scaleX, scaleY);
      setScale(initialScale);
      setMinScale(initialScale * 0.5);
      setMaxScale(Math.max(initialScale * 3.5, 3));
      // 居中偏移
      setOffset({
        x: (CROP_W - img.width * initialScale) / 2,
        y: (CROP_H - img.height * initialScale) / 2,
      });
      setLoadedSrc(imageSrc);
    };
    img.src = imageSrc;
    return () => {
      cancelled = true;
      img.onload = null;
      if (imageRef.current === img) imageRef.current = null;
    };
  }, [open, imageSrc]);

  // 绘制取景框与图片
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 绘制底图（平移 + 缩放）
    ctx.save();
    ctx.drawImage(img, offset.x, offset.y, img.width * scale, img.height * scale);
    ctx.restore();
  }, [offset, scale]);

  useEffect(() => {
    if (imageLoaded) {
      renderCanvas();
    }
  }, [imageLoaded, renderCanvas]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!imageLoaded) return;
    const step = e.shiftKey ? 20 : 5;
    let dx = 0;
    let dy = 0;
    switch (e.key) {
      case "ArrowLeft": dx = -step; break;
      case "ArrowRight": dx = step; break;
      case "ArrowUp": dy = -step; break;
      case "ArrowDown": dy = step; break;
      default: return;
    }
    e.preventDefault();
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  // 鼠标 / 指针拖动图片位置
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setOffset({
      x: Math.round(dragStartRef.current.originX + dx),
      y: Math.round(dragStartRef.current.originY + dy),
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  // 滚轮缩放
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    const nextScale = Math.min(Math.max(scale * zoomFactor, minScale), maxScale);

    // 以画布中心为缩放锚点调整 offset
    const cx = CROP_W / 2;
    const cy = CROP_H / 2;
    const ratio = nextScale / scale;
    setOffset((prev) => ({
      x: cx - (cx - prev.x) * ratio,
      y: cy - (cy - prev.y) * ratio,
    }));
    setScale(nextScale);
  };

  // 重置居中
  const handleReset = () => {
    const img = imageRef.current;
    if (!img) return;
    const scaleX = CROP_W / img.width;
    const scaleY = CROP_H / img.height;
    const initialScale = Math.max(scaleX, scaleY);
    setScale(initialScale);
    setOffset({
      x: (CROP_W - img.width * initialScale) / 2,
      y: (CROP_H - img.height * initialScale) / 2,
    });
  };

  // 确认裁剪并生成高质量图片
  const handleConfirm = async () => {
    const img = imageRef.current;
    if (!img) return;
    setSaving(true);
    try {
      const offscreen = document.createElement("canvas");
      offscreen.width = OUTPUT_W;
      offscreen.height = OUTPUT_H;
      const ctx = offscreen.getContext("2d");
      if (!ctx) throw new Error("无法创建画布上下文");

      const exportScaleRatio = OUTPUT_W / CROP_W;
      ctx.drawImage(
        img,
        offset.x * exportScaleRatio,
        offset.y * exportScaleRatio,
        img.width * scale * exportScaleRatio,
        img.height * scale * exportScaleRatio
      );

      const blob = await new Promise<Blob | null>((resolve) => {
        offscreen.toBlob(resolve, "image/jpeg", 0.92);
      });

      if (!blob) throw new Error("图片导出失败");

      const file = new File([blob], "avatar.jpg", { type: "image/jpeg" });
      await onCropComplete(file);
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="裁剪与缩放证件照"
      description="拖动照片或聚焦取景框后使用方向键调整位置，使用下方滑块缩放大小。"
    >
      <div className="flex flex-col items-center space-y-4 py-2">
        <p id={instructionsId} className="sr-only">
          使用方向键每次移动照片 5 像素，按住 Shift 每次移动 20 像素。按 Tab 可移至缩放滑块。
        </p>
        {/* 取景预览框 */}
        <div className="relative flex items-center justify-center rounded-xl bg-neutral-900/90 p-4 shadow-inner">
          <div
            className="relative overflow-hidden rounded-md border-2 border-primary shadow-lg"
            style={{ width: CROP_W, height: CROP_H, touchAction: "none" }}
          >
            <canvas
              ref={canvasRef}
              width={CROP_W}
              height={CROP_H}
              tabIndex={0}
              role="application"
              aria-label="照片裁剪区域"
              aria-describedby={instructionsId}
              onKeyDown={handleKeyDown}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
              className="cursor-move select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
              title="拖动或使用方向键移动照片，滚轮或下方滑块缩放"
            />
            {/* 3:4 标准人像参考标线 */}
            <div className="pointer-events-none absolute inset-0 border border-white/40 border-dashed" />
            <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/90">
              标准 3:4 证件照
            </div>
          </div>
        </div>

        {/* 缩放滑块与微调控制 */}
        <div className="w-full max-w-sm space-y-2 px-2">
          <div className="flex items-center justify-between text-xs text-muted">
            <label htmlFor={zoomId}>缩放大小</label>
            <button
              type="button"
              className="underline text-primary hover:text-primary-hover"
              onClick={handleReset}
            >
              重置居中
            </button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">小</span>
            <input
              id={zoomId}
              type="range"
              min={minScale}
              max={maxScale}
              step={(maxScale - minScale) / 100}
              value={scale}
              aria-valuetext={`${Math.round((scale / (minScale * 2)) * 100)}%`}
              onChange={(e) => {
                const nextScale = Number(e.target.value);
                const cx = CROP_W / 2;
                const cy = CROP_H / 2;
                const ratio = nextScale / scale;
                setOffset((prev) => ({
                  x: cx - (cx - prev.x) * ratio,
                  y: cy - (cy - prev.y) * ratio,
                }));
                setScale(nextScale);
              }}
              className="flex-1 accent-primary cursor-pointer"
            />
            <span className="text-xs text-muted">大</span>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex w-full justify-end gap-2 pt-3 border-t border-line">
          <button type="button" className={btnGhost} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={handleConfirm}
            disabled={saving || !imageLoaded}
          >
            {saving ? "裁剪处理中…" : "确认并使用此证件照"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
