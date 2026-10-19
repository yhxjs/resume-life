// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { BasicEditor } from "../module-content-editors";

const images: HTMLImageElement[] = [];
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const fetchMock = vi.fn();

function selectPhoto(container: HTMLElement, name = "photo.jpg") {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File([name], name, { type: "image/jpeg" })] },
  });
}

function renderEditor(content: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  return { ...render(<StrictMode><BasicEditor content={content} onChange={onChange} status="idle" /></StrictMode>), onChange };
}

beforeEach(() => {
  images.length = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:owned-${createObjectURL.mock.calls.length}`);
  revokeObjectURL.mockReset();
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ url: "/uploads/avatar.jpg" }) });
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Image", vi.fn(function () {
    const img = document.createElement("img");
    Object.defineProperties(img, { width: { value: 420 }, height: { value: 560 } });
    images.push(img);
    return img;
  }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback(new Blob(["cropped"], { type: "image/jpeg" }));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BasicEditor crop object URL ownership", () => {
  it("上传中禁止重叠移除，完成后可移除新头像", async () => {
    const { container, onChange } = renderEditor({ avatar: "/uploads/old.jpg" });
    selectPhoto(container);
    act(() => images.at(-1)!.onload?.(new Event("load")));
    let resolveUpload!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "确认并使用此证件照" }));
    await act(async () => {});
    const remove = screen.getByRole("button", { name: /^移除$/ });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(remove);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => resolveUpload({ ok: true, json: async () => ({ url: "/uploads/new.jpg" }) }));
    expect((remove as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(remove);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ avatar: "" }), { immediate: true });
  });

  it("上传等待期间的新姓名和电话保留", async () => {
    const original = { name: "旧姓名", phone: "旧电话" };
    const { container, onChange, rerender } = renderEditor(original);
    selectPhoto(container);
    act(() => images.at(-1)!.onload?.(new Event("load")));
    let resolveUpload!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "确认并使用此证件照" }));
    await act(async () => {});
    rerender(<StrictMode><BasicEditor content={{ name: "新姓名", phone: "新电话" }} onChange={onChange} status="idle" /></StrictMode>);
    await act(async () => resolveUpload({ ok: true, json: async () => ({ url: "/uploads/avatar.jpg" }) }));
    expect(onChange).toHaveBeenCalledWith({ name: "新姓名", phone: "新电话", avatar: "/uploads/avatar.jpg", avatarX: 0, avatarY: 0 }, { immediate: true });
  });

  it("卸载后到达的上传响应不提交草稿", async () => {
    const { container, onChange, unmount } = renderEditor();
    selectPhoto(container);
    act(() => images.at(-1)!.onload?.(new Event("load")));
    let resolveUpload!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "确认并使用此证件照" }));
    await act(async () => {});
    unmount();
    await act(async () => resolveUpload({ ok: true, json: async () => ({ url: "/uploads/avatar.jpg" }) }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("releases replaced and cancelled photos exactly once without revoking an active crop", () => {
    const { container, unmount } = renderEditor();
    selectPhoto(container);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    selectPhoto(container, "replacement.jpg");
    expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-1"]]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-1"], ["blob:owned-2"]]);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("releases the current crop on unmount in StrictMode", () => {
    const { container, unmount } = renderEditor();
    selectPhoto(container);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-1"]]);
  });

  it("releases the original photo after upload completes and the crop closes", async () => {
    const { container, onChange, unmount } = renderEditor();
    selectPhoto(container);
    act(() => images.at(-1)!.onload?.(new Event("load")));
    let resolveUpload!: (response: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "确认并使用此证件照" }));
    await act(async () => {});
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => resolveUpload({ ok: true, json: async () => ({ url: "/uploads/avatar.jpg" }) }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ avatar: "/uploads/avatar.jpg" }), { immediate: true });
    expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-1"]]);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it.each(["/uploads/existing-avatar.jpg", "blob:externally-owned"])("releases a selected photo when switching to %s but never revokes that avatar", (avatar) => {
    const { container, unmount } = renderEditor({ avatar });
    selectPhoto(container);
    fireEvent.click(screen.getByRole("button", { name: "裁剪缩放" }));
    expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-1"]]);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    unmount();
    expect(revokeObjectURL.mock.calls).toEqual([["blob:owned-1"]]);
  });
});
