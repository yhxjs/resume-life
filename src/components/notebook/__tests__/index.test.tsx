// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  CategoryChangeDialog,
  CategoryManageDialog,
  NotebookStarButton,
} from "../index";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));

const categories = [{ id: 1, name: "面试", entry_count: 2 }];

beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/notebook/categories") return categories as never;
    if (method === "POST" && url === "/api/notebook") return { id: 99 } as never;
    if (method === "POST" && url === "/api/notebook/categories") return { id: 2, name: "算法" } as never;
    if (method === "PATCH" && url === "/api/notebook/categories/1") return { id: 1, name: "面试改" } as never;
    if (method === "PATCH" && url === "/api/notebook/5") return { ok: true } as never;
    if (method === "DELETE" && url === "/api/notebook/5") return { ok: true } as never;
    throw new Error(`unexpected request: ${method} ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NotebookStarButton 收藏星标", () => {
  it("未收藏时点击弹出分类弹窗，选择分类后收藏并回调 notebookId", async () => {
    const onChanged = vi.fn();
    render(
      <NotebookStarButton
        source="drill"
        sourceId={11}
        question="什么是闭包？"
        notebookId={null}
        onChanged={onChanged}
      />
    );

    // 状态变化：点击触发按钮 → 收藏弹窗出现，分类列表加载完成
    fireEvent.click(screen.getByRole("button", { name: /收藏到错题本|收藏/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("什么是闭包？")).toBeTruthy();
    await within(dialog).findByText("面试");

    // 选择分类「面试」后确认收藏
    fireEvent.click(within(dialog).getByRole("button", { name: "面试" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "收藏" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledWith(99);
    });
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ source: "drill", source_id: 11, category_id: 1 });
  });

  it("已收藏时点击直接取消收藏并回调 null", async () => {
    const onChanged = vi.fn();
    render(
      <NotebookStarButton
        source="interview"
        sourceId={12}
        question="什么是事件循环？"
        notebookId={5}
        onChanged={onChanged}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledWith(null);
    });
    expect(vi.mocked(jsonFetch).mock.calls.some(([url, init]) => url === "/api/notebook/5" && init?.method === "DELETE")).toBe(true);
  });
});

describe("CategoryChangeDialog 移动分类", () => {
  it("保存时以 PATCH 提交目标分类并回调 onSaved", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <CategoryChangeDialog
        entryId={5}
        question="什么是闭包？"
        initialCategoryId={null}
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("面试");
    fireEvent.click(within(dialog).getByRole("button", { name: "面试" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(call?.[0]).toBe("/api/notebook/5");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ category_id: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CategoryManageDialog 分类管理", () => {
  it("加载分类列表，新建分类后回调 onChanged", async () => {
    const onChanged = vi.fn();
    render(<CategoryManageDialog onClose={vi.fn()} onChanged={onChanged} />);

    await screen.findByText("面试");
    expect(screen.getByText("2 道题")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("新分类名称"), { target: { value: "算法" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: "算法" });
  });

  it("重命名分类后提交 PATCH", async () => {
    const onChanged = vi.fn();
    render(<CategoryManageDialog onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByText("面试");

    // 状态变化：点击重命名后进入行内编辑
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const editInput = screen.getByLabelText("重命名分类：面试") as HTMLInputElement;
    expect(editInput.value).toBe("面试");

    fireEvent.change(editInput, { target: { value: "面试改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(call?.[0]).toBe("/api/notebook/categories/1");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ name: "面试改" });
  });
});
