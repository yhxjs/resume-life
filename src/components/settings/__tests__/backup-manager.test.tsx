// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BackupManager } from "../backup-manager";
import { jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { encodePasswordHeader } from "../backup-manager-utils";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
  alertDialog: vi.fn(async () => {}),
}));

const stats = {
  ok: true,
  stats: {
    resumes: 3,
    projects: 2,
    interviews: 1,
    drills: 4,
    bank_entries: 10,
    notebook_entries: 6,
    intros: 5,
    templates: 2,
    totalRecords: 33,
    hasAiConfig: true,
    dbVersion: 1,
  },
};

const manifest = {
  kind: "manifest",
  appName: "resume-life",
  backupVersion: "1.0.0",
  dbVersion: 1,
  createdAt: "2026-09-27T10:00:00.000Z",
  tables: ["resumes"],
  sequences: {},
  files: [],
};

function createBackupFile(name = "resume-life-backup.rlbackup"): File {
  return new File(["BACKUPDATA"], name, { type: "application/vnd.resume-life.backup" });
}

beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation(async (url: string) => {
    if (url === "/api/backup/stats") return stats as never;
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/backup/validate") {
      return new Response(JSON.stringify({ ok: true, manifest, stats: stats.stats, totalRecords: 33 }), { status: 200 });
    }
    if (url === "/api/backup/export") {
      return new Response("BACKUPDATA", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="resume-life-backup-2026.rlbackup"' },
      });
    }
    if (url === "/api/backup/restore") {
      return new Response(JSON.stringify({ ok: true, snapshotCreated: "snap-001" }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  // jsdom 未实现 blob URL，仅记录调用即可
  (window.URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock-url");
  (window.URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("BackupManager 数据管理与灾备恢复", () => {
  it("加载并渲染数据库统计", async () => {
    render(<BackupManager />);

    expect(await screen.findByText("简历 3 份")).toBeTruthy();
    expect(screen.getByText("错题本 6 条")).toBeTruthy();
    expect(screen.getByText(/当前数据库版本 1/)).toBeTruthy();
  });

  it("两次导出密码不一致时显示错误且不发起请求", async () => {
    render(<BackupManager />);
    await screen.findByText("简历 3 份");

    fireEvent.change(screen.getByLabelText("导出密码"), { target: { value: "a".repeat(12) } });
    fireEvent.change(screen.getByLabelText("确认导出密码"), { target: { value: "b".repeat(12) } });
    fireEvent.click(screen.getByRole("button", { name: "导出加密备份 (.rlbackup)" }));

    expect(await screen.findByText("两次输入的导出密码不一致")).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/backup/export")).toBe(false);
  });

  it("导出成功后触发下载并显示成功反馈", async () => {
    render(<BackupManager />);
    await screen.findByText("简历 3 份");

    fireEvent.change(screen.getByLabelText("导出密码"), { target: { value: "a".repeat(12) } });
    fireEvent.change(screen.getByLabelText("确认导出密码"), { target: { value: "a".repeat(12) } });
    fireEvent.click(screen.getByRole("button", { name: "导出加密备份 (.rlbackup)" }));

    expect(await screen.findByText("加密备份导出成功")).toBeTruthy();
    expect(window.URL.createObjectURL).toHaveBeenCalled();
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/backup/export");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ password: "a".repeat(12), confirmation: "a".repeat(12) });
  });

  it("选择 JSON 文件时提示格式不支持", async () => {
    render(<BackupManager />);
    await screen.findByText("简历 3 份");

    const input = screen.getByLabelText("备份文件");
    fireEvent.change(input, { target: { files: [new File(["{}"], "old.json", { type: "application/json" })] } });

    expect(await screen.findByText("备份验证失败：不支持 JSON 文件，请选择 .rlbackup 加密备份")).toBeTruthy();
  });

  it("选择合法备份并输入导入密码后完成校验，确认恢复走完整链路", async () => {
    render(<BackupManager />);
    await screen.findByText("简历 3 份");

    const input = screen.getByLabelText("备份文件");
    fireEvent.change(input, { target: { files: [createBackupFile()] } });

    // 校验防抖 350ms，等待校验结果面板出现
    fireEvent.change(screen.getByLabelText("导入密码"), { target: { value: "p".repeat(12) } });
    expect(await screen.findByText("待恢复备份包详情", undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("备份数据库版本：1")).toBeTruthy();
    const validateCall = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/backup/validate");
    expect((validateCall?.[1]?.headers as Record<string, string>)["X-Resume-Life-Backup-Password"]).toBe(
      encodePasswordHeader("p".repeat(12))
    );

    fireEvent.click(screen.getByRole("button", { name: "完全覆盖并恢复系统数据" }));
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));

    expect(await screen.findByText(/数据恢复成功/)).toBeTruthy();
    expect(screen.getByText("snap-001")).toBeTruthy();
    const restoreCall = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/backup/restore");
    expect((restoreCall?.[1]?.headers as Record<string, string>)["X-Resume-Life-Preserve-Ai-Config"]).toBe("true");
  });
});
