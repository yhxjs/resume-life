import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnoseDialog } from "@/components/resume/diagnose-dialog";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { jsonFetch } from "@/lib/fetcher";

let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void> = [];
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? (value as (old: unknown) => unknown)(slots[index]) : value; }];
  },
  useEffect: (effect: () => void) => { effects.push(effect); },
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/hooks/use-modal-focus", () => ({ useModalFocus: () => ({ current: null }) }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: vi.fn() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({ getResumeSaveQueue: () => ({ flush: async () => {}, drain: async () => {}, needsUnloadWarning: false }) }));

type Props = { children?: ReactNode; disabled?: boolean; value?: unknown; onClick?: () => unknown; onChange?: (event: { target: { value: string } }) => void };
function find(root: ReactNode, match: (element: ReactElement<Props>) => boolean): ReactElement<Props> {
  let result: ReactElement<Props> | undefined;
  function visit(node: ReactNode) {
    if (!isValidElement<Props>(node) || result) return;
    if (match(node)) result = node;
    else Children.forEach(node.props.children, visit);
  }
  visit(root);
  if (!result) throw new Error("未找到目标控件");
  return result;
}
function render() { cursor = 0; return DiagnoseDialog({ resumeId: "4", modules: [], onApply: () => true }); }
const empty = { current: null, previous: null, history: [] };
const current = { id: 7, job_id: "job", job_title: "后端", jd: "JD", resume_version_id: 41, created_at: "2026-09-27", adoptions: [], resume_snapshot: { title: "简历", modules: [] }, report: { match: 8, summary: "诊断", modules: [] } };
const history = { current, previous: null, history: [{ ...current, match: 8 }] };
const options = [{ id: 4, title: "简历", updated_at: "", versions: [{ id: 42, version: 2, name: "新版" }, { id: 41, version: 1, name: "投递版" }] }];

beforeEach(() => {
  slots = []; effects = []; cursor = 0; vi.clearAllMocks();
  vi.stubGlobal("window", { location: { search: "" } });
  vi.stubGlobal("document", { body: {} });
  vi.mocked(useResumeOptions).mockReturnValue({ resumes: options, resumesError: "", reloadResumes: vi.fn() });
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
    if (String(url).startsWith("/api/applications/")) return { id: 8, resume_id: 4, resume_version_id: 41, jd: "JD" } as never;
    return (init?.method === "POST" || String(url).includes("diagnosis_id") ? history : empty) as never;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("JD 诊断发布版本", () => {
  it("新诊断默认最新已发布版并携带版本参数", async () => {
    await find(render(), (node) => node.type === "button").props.onClick?.();
    find(render(), (node) => node.type === "textarea").props.onChange?.({ target: { value: "JD" } });
    await find(render(), (node) => node.type === "button" && node.props.children === "开始诊断").props.onClick?.();
    await vi.waitFor(() => {
      const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ resume_version_id: 42 });
    });
  });

  it("未发布时禁止诊断，显示共用版本发布提示", async () => {
    vi.mocked(useResumeOptions).mockReturnValue({ resumes: [{ ...options[0]!, versions: [] }], resumesError: "", reloadResumes: vi.fn() });
    await find(render(), (node) => node.type === "button").props.onClick?.();
    find(render(), (node) => node.type === "textarea").props.onChange?.({ target: { value: "JD" } });
    const tree = render();
    expect(find(tree, (node) => node.type === ResumeVersionSelect).props.value).toBe("");
    const button = find(tree, (node) => node.type === "button" && node.props.children === "开始诊断");
    expect(button.props.disabled).toBe(true);
    await button.props.onClick?.();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("投递历史诊断重新生成仍固定原绑定版本", async () => {
    vi.stubGlobal("window", { location: { search: "?diagnosisId=7&applicationId=8" } });
    render(); effects.splice(0).forEach((effect) => effect());
    await vi.waitFor(() => expect(slots[0]).toBe(true));
    const tree = render();
    await find(tree, (node) => node.type === "button" && String(node.props.children).includes("再次诊断")).props.onClick?.();
    await vi.waitFor(() => {
      const call = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ application_id: 8, resume_version_id: 41 });
    });
    expect(find(tree, (node) => node.type === ResumeVersionSelect).props).toMatchObject({ value: 41, disabled: true });
  });

  it("普通历史诊断保留旧版本，新岗位默认最新发布版", async () => {
    vi.stubGlobal("window", { location: { search: "?diagnosisId=7" } });
    render(); effects.splice(0).forEach((effect) => effect());
    await vi.waitFor(() => expect(slots[0]).toBe(true));
    expect(find(render(), (node) => node.type === ResumeVersionSelect).props.value).toBe(41);
    await find(render(), (node) => node.type === "button" && node.props.children === "诊断新岗位").props.onClick?.();
    expect(find(render(), (node) => node.type === ResumeVersionSelect).props.value).toBe(42);
  });

  it("投递资料读取失败后不能悄悄改用最新版本生成", async () => {
    vi.stubGlobal("window", { location: { search: "?diagnosisId=7&applicationId=8" } });
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (String(url).startsWith("/api/applications/")) throw new Error("投递读取失败");
      return history as never;
    });
    render(); effects.splice(0).forEach((effect) => effect());
    await vi.waitFor(() => expect(slots[0]).toBe(true));
    find(render(), (node) => node.type === "textarea").props.onChange?.({ target: { value: "JD" } });
    const button = find(render(), (node) => node.type === "button" && node.props.children === "开始诊断");
    expect(button.props.disabled).toBe(true);
    await button.props.onClick?.();
    expect(vi.mocked(jsonFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});
