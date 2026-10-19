// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AvatarCropperModal } from "../avatar-cropper-modal";

const images: HTMLImageElement[] = [];
const drawImage = vi.fn();

function loadImage(index = images.length - 1) {
  act(() => images[index]!.onload?.(new Event("load")));
}

function renderCropper() {
  const onCropComplete = vi.fn();
  const props = { open: true, imageSrc: "blob:photo-1", onClose: vi.fn(), onCropComplete };
  return { ...render(<AvatarCropperModal {...props} />), props, onCropComplete };
}

beforeEach(() => {
  images.length = 0;
  drawImage.mockReset();
  vi.stubGlobal("Image", vi.fn(function () {
    const img = document.createElement("img");
    Object.defineProperties(img, { width: { value: 420 }, height: { value: 560 } });
    images.push(img);
    return img;
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["cropped"], { type: "image/jpeg" }));
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AvatarCropperModal keyboard access", () => {
  it("uses arrow keys to pan the focused canvas and exports the adjusted crop", async () => {
    const { onCropComplete } = renderCropper();
    loadImage();
    const canvas = screen.getByRole("application", { name: "照片裁剪区域" });
    expect(document.activeElement).toBe(canvas);
    expect(canvas.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(canvas.getAttribute("aria-describedby")!)?.textContent).toContain("方向键");
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    expect(drawImage.mock.lastCall).toEqual([images[0], 5, 5, 210, 280]);
    fireEvent.keyDown(canvas, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowUp", shiftKey: true });
    expect(drawImage.mock.lastCall).toEqual([images[0], -15, -15, 210, 280]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认并使用此证件照" })));
    const exportedCrop = drawImage.mock.lastCall!;
    expect(exportedCrop[0]).toBe(images[0]);
    expect(exportedCrop[1]).toBeCloseTo(-15 * 450 / 210);
    expect(exportedCrop[2]).toBeCloseTo(-15 * 450 / 210);
    expect(exportedCrop.slice(3)).toEqual([450, 600]);
    expect(onCropComplete).toHaveBeenCalledWith(expect.any(File));
  });

  it("names the zoom slider and keeps the canvas in the modal focus trap", () => {
    renderCropper();
    loadImage();
    const slider = screen.getByRole("slider", { name: "缩放大小" }) as HTMLInputElement;
    expect(slider.labels?.[0]?.textContent).toBe("缩放大小");
    expect(slider.getAttribute("aria-valuetext")).toBe("100%");
    fireEvent.change(slider, { target: { value: "1" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("200%");
    const canvas = screen.getByRole("application", { name: "照片裁剪区域" });
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "Tab", shiftKey: true });
    const confirm = screen.getByRole("button", { name: "确认并使用此证件照" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(canvas);
  });

  it("ignores a late load callback after the crop source changes", () => {
    const { rerender, props } = renderCropper();
    const oldImage = images[0]!;
    const oldLoad = oldImage.onload!;
    rerender(<AvatarCropperModal {...props} imageSrc="blob:photo-2" />);
    loadImage();
    act(() => oldLoad.call(oldImage, new Event("load")));
    expect((screen.getByRole("button", { name: "确认并使用此证件照" }) as HTMLButtonElement).disabled).toBe(false);
    expect(drawImage.mock.lastCall?.[0]).toBe(images[1]);
  });
});
