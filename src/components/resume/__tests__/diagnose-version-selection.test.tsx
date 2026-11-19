// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnoseDialog } from "@/components/resume/diagnose-dialog";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: vi.fn() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({ getResumeSaveQueue: () => ({ flush: async () => {}, needsUnloadWarning: false }) }));
const empty = { current: null, previous: null, history: [] };
const current = { id: 7, job_id: "job", job_title: "后端", jd: "JD", resume_version_id: 41, created_at: "2026-09-27", adoptions: [], resume_snapshot: { title: "简历", modules: [] }, report: { match: 8, summary: "诊断", modules: [] } };
const history = { current, previous: null, history: [{ ...current, match: 8 }] };
const options = [{ id: 4, title: "简历", updated_at: "", versions: [{ id: 42, version: 2, name: "新版" }, { id: 41, version: 1, name: "投递版" }] }];
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  vi.mocked(useResumeOptions).mockReturnValue({ resumes: options, resumesError: "", reloadResumes: vi.fn() });
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (url, init) => {
    if (String(url).startsWith("/api/applications/")) return { id: 8, resume_id: 4, resume_version_id: 41, jd: "JD" } as never;
    return (init?.method === "POST" || String(url).includes("diagnosis_id") ? history : empty) as never;
  });
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
async function open() {
  render(<DiagnoseDialog resumeId="4" modules={[]} onApply={() => true} />);
  fireEvent.click(screen.getByRole("button", { name: "JD 诊断" }));
  await waitFor(() => expect(screen.queryByText("正在处理，请稍候…")).toBeNull());
}

describe("JD 诊断发布版本", () => {
  it("新诊断默认最新已发布版并携带版本参数", async () => {
    await open(); fireEvent.change(screen.getByLabelText("岗位要求（JD）"), { target: { value: "JD" } });
    expect((screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement).value).toBe("42");
    fireEvent.click(screen.getByRole("button", { name: "开始诊断" }));
    await waitFor(() => expect(posts()).toHaveLength(1)); expect(JSON.parse(String(posts()[0]?.[1]?.body))).toMatchObject({ resume_version_id: 42 });
  });
  it("未发布时禁止诊断，显示共用版本发布提示", async () => {
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: [{ ...options[0]!, versions: [] }], resumesError: "", reloadResumes: vi.fn() });
    await open(); fireEvent.change(screen.getByLabelText("岗位要求（JD）"), { target: { value: "JD" } });
    expect(screen.getByRole("button", { name: "开始诊断" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/请先/)).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "开始诊断" })); expect(posts()).toHaveLength(0);
  });
  it("投递历史诊断重新生成仍固定原绑定版本", async () => {
    window.history.replaceState(null, "", "/?diagnosisId=7&applicationId=8"); render(<DiagnoseDialog resumeId="4" modules={[]} onApply={() => true} />);
    const again = await screen.findByRole("button", { name: "按所选发布版本再次诊断" });
    const version = screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement; expect(version.value).toBe("41"); expect(version.disabled).toBe(true);
    fireEvent.click(again); await waitFor(() => expect(posts()).toHaveLength(1)); expect(JSON.parse(String(posts()[0]?.[1]?.body))).toMatchObject({ application_id: 8, resume_version_id: 41 });
  });
  it("普通历史诊断保留旧版本，新岗位默认最新发布版", async () => {
    window.history.replaceState(null, "", "/?diagnosisId=7"); render(<DiagnoseDialog resumeId="4" modules={[]} onApply={() => true} />);
    await screen.findByRole("button", { name: "诊断新岗位" }); expect((screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement).value).toBe("41");
    fireEvent.click(screen.getByRole("button", { name: "诊断新岗位" })); expect((screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement).value).toBe("42");
  });
  it("投递资料读取失败后不能悄悄改用最新版本生成", async () => {
    window.history.replaceState(null, "", "/?diagnosisId=7&applicationId=8");
    vi.mocked(jsonFetch).mockImplementation(async url => { if (String(url).startsWith("/api/applications/")) throw new Error("投递读取失败"); return history as never; });
    render(<DiagnoseDialog resumeId="4" modules={[]} onApply={() => true} />); expect((await screen.findByRole("alert")).textContent).toContain("投递读取失败");
    fireEvent.change(screen.getByLabelText("岗位要求（JD）"), { target: { value: "JD" } }); const button = screen.getByRole("button", { name: "开始诊断" });
    expect(button.hasAttribute("disabled")).toBe(true); fireEvent.click(button); expect(posts()).toHaveLength(0);
  });
});
