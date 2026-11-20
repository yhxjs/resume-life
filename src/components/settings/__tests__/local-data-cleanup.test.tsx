// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { LocalDataCleanup } from "../local-data-cleanup";
import { RESUME_IMPORT_SESSION_KEY } from "@/lib/resume-import-session";
import { SALARY_CREATION_STORAGE_KEY } from "@/lib/salary-creation-storage";
import { clearSensitiveBrowserData, hasSensitiveBrowserDrafts } from "@/lib/browser-sensitive-data";
import { CUSTOM_CLI_PROFILES_KEY } from "@/lib/custom-cli-storage";

vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("resume_life_anonymize_config", "synthetic");
  sessionStorage.setItem("resume-life:draft:1", '{"title":"合成敏感内容"}');
  localStorage.setItem("other-app", "keep");
  localStorage.setItem("resume_life_project_repo_paths_1", '["C:/synthetic/legacy"]');
  localStorage.setItem("resume_life_project_repo_paths_old:2", '["C:/synthetic/old"]');
  localStorage.setItem(CUSTOM_CLI_PROFILES_KEY, '[{"command":"synthetic-client"}]');
  sessionStorage.setItem("other-app", "keep");
  vi.mocked(confirmDialog).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("主动清理仅删除应用敏感键并给出完成反馈", async () => {
  render(<LocalDataCleanup />);
  fireEvent.click(screen.getByRole("button", { name: "清除本机敏感副本" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已清除"));
  expect(localStorage.getItem("resume_life_anonymize_config")).toBeNull();
  expect(sessionStorage.getItem("resume-life:draft:1")).toBeNull();
  expect(localStorage.getItem("other-app")).toBe("keep");
  expect(localStorage.getItem("resume_life_project_repo_paths_1")).toBeNull();
  expect(localStorage.getItem("resume_life_project_repo_paths_old:2")).toBeNull();
  expect(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)).toBeNull();
  expect(sessionStorage.getItem("other-app")).toBe("keep");
});
it.each([RESUME_IMPORT_SESSION_KEY, SALARY_CREATION_STORAGE_KEY])("退出时能发现、保留和清除单独的会话草稿 %s", key => {
  sessionStorage.removeItem("resume-life:draft:1");
  sessionStorage.setItem(key, "saved draft");
  expect(hasSensitiveBrowserDrafts()).toBe(true);
  clearSensitiveBrowserData(true);
  expect(sessionStorage.getItem(key)).toBe("saved draft");
  clearSensitiveBrowserData();
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(hasSensitiveBrowserDrafts()).toBe(false);
  expect(sessionStorage.getItem("other-app")).toBe("keep");
});
it("保留草稿也清除所有项目路径和脱敏规则", () => {
  clearSensitiveBrowserData(true);
  expect(sessionStorage.getItem("resume-life:draft:1")).not.toBeNull();
  expect(localStorage.getItem("resume_life_anonymize_config")).toBeNull();
  expect(localStorage.getItem("resume_life_project_repo_paths_1")).toBeNull();
  expect(localStorage.getItem("resume_life_project_repo_paths_old:2")).toBeNull();
  expect(localStorage.getItem(CUSTOM_CLI_PROFILES_KEY)).toBeNull();
  expect(localStorage.getItem("other-app")).toBe("keep");
});
it("取消清理保留副本", async () => {
  vi.mocked(confirmDialog).mockResolvedValue(false);
  render(<LocalDataCleanup />);
  fireEvent.click(screen.getByRole("button", { name: "清除本机敏感副本" }));
  await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
  expect(sessionStorage.getItem("resume-life:draft:1")).not.toBeNull();
  expect(localStorage.getItem("resume_life_anonymize_config")).not.toBeNull();
});
it("存储失败不能显示清理成功", async () => {
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("存储被禁止"); });
  render(<LocalDataCleanup />);
  fireEvent.click(screen.getByRole("button", { name: "清除本机敏感副本" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("清除未完成"));
  expect(screen.queryByRole("status")).toBeNull();
});
