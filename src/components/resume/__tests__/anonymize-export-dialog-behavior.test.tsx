// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { AnonymizeExportDialog } from "../anonymize-export-dialog";
import type { ModuleData } from "@/lib/modules";
import { DEFAULT_ANONYMIZE_CONFIG } from "@/lib/resume-anonymize";

type CheckDialogProps = ComponentProps<typeof import("../resume-export-check-dialog").ResumeExportCheckDialog>;

const mocks = vi.hoisted(() => ({
  check: vi.fn<(props: CheckDialogProps) => void>(),
  downloadCheckedResume: vi.fn(async () => {}),
  resumeToMarkdown: vi.fn<(title: string, modules: ModuleData[]) => string>(),
  fetch: vi.fn(),
  createObjectURL: vi.fn<(_blob: Blob) => string>(() => "blob:anonymized"),
  revokeObjectURL: vi.fn(),
  downloads: [] as Array<{ href: string; filename: string }>,
}));

vi.mock("@/lib/resume-export-client", () => ({
  downloadCheckedResume: mocks.downloadCheckedResume,
  measureResumeExportLayout: () => [],
}));
vi.mock("@/lib/resume-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/resume-markdown")>();
  mocks.resumeToMarkdown.mockImplementation(original.resumeToMarkdown);
  return { ...original, resumeToMarkdown: mocks.resumeToMarkdown };
});
vi.mock("@/components/resume/resume-export-check-dialog", () => ({
  ResumeExportCheckDialog: (props: CheckDialogProps) => {
    mocks.check(props);
    return props.open ? (
      <div>
        <button type="button" onClick={() => void props.onContinue(["metric-1"], false)}>确认继续</button>
        <button type="button" onClick={props.onClose}>返回修改</button>
      </div>
    ) : null;
  },
}));

const modules: ModuleData[] = [
  { key: "basic", type: "basic", label: "基本信息", sort: 0, content: {
    name: "张三", phone: "13800000000", email: "zhangsan@test.com", location: "北京市海淀区中关村",
    birthday: "1994-06-15", links: "github.com/zhangsan", avatar: "data:image/png;base64,test",
  } },
  { key: "work", type: "work", label: "工作经历", sort: 1, content: [
    { id: "w1", company: "字节跳动", title: "前端技术专家", description: "主导 Project-Zeus 架构演进" },
  ] },
  { key: "projects", type: "projects", label: "项目经历", sort: 2, content: [
    { id: "p1", name: "全栈简历生成系统", role: "核心架构师" },
  ] },
  { key: "education", type: "education", label: "教育经历", sort: 3, content: [
    { id: "e1", school: "清华大学", degree: "本科" },
  ] },
];

function renderDialog(props: Partial<ComponentProps<typeof AnonymizeExportDialog>> = {}) {
  return render(<AnonymizeExportDialog open onClose={vi.fn()} resumeId="r-1" title="张三的前端简历"
    modules={modules} {...props} />);
}

function identityPreview() {
  return screen.getByText("身份脱敏:").parentElement!;
}

function addRule(source = "Project-Zeus", replacement = "保密系统") {
  fireEvent.change(screen.getByPlaceholderText("输入其他敏感词(如 内部代号/秘密系统名)"), { target: { value: source } });
  fireEvent.change(screen.getByPlaceholderText("替换占位符(如 [某保密微服务平台])"), { target: { value: replacement } });
  fireEvent.click(screen.getByRole("button", { name: "添加规则" }));
}

function exportedContent() {
  const props = mocks.check.mock.lastCall![0];
  expect(props.open).toBe(true);
  return props.exportedContent!;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.downloads.length = 0;
  mocks.fetch.mockResolvedValue({ ok: true, headers: new Headers({
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("[脱敏版] 张*的前端简历.pdf")}`,
  }), blob: async () => new Blob(["PDF"]) });
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = mocks.createObjectURL;
    static revokeObjectURL = mocks.revokeObjectURL;
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    mocks.downloads.push({ href: this.href, filename: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AnonymizeExportDialog 配置与导出行为", () => {
  it.each([{ avatar: null }, { name: { enabled: true, mode: "wrong" } }, { customRules: [null] }, { customRules: [{ id: "r", source: 1, replacement: "安全" }] }])("损坏配置 %j 恢复安全默认且提供提示", (saved) => {
    localStorage.setItem("resume_life_anonymize_config", JSON.stringify(saved));
    const view = renderDialog({ open: false });
    view.rerender(<AnonymizeExportDialog open onClose={vi.fn()} resumeId="r-1" title="张三" modules={modules} />);
    expect(screen.getByRole("status").textContent).toContain("已恢复默认脱敏设置");
    expect(identityPreview().textContent).toContain("张*");
    expect(JSON.parse(localStorage.getItem("resume_life_anonymize_config")!).avatar).toEqual({ enabled: true });
  });
  it("身份开关和脱敏模式立即更新预览，并保存到基础配置", () => {
    renderDialog();
    expect(identityPreview().textContent).toContain("张*");
    expect(identityPreview().textContent).toContain("138********");
    expect(screen.getByText(/已脱敏 7 项身份信息/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "固定代号" }));
    expect(identityPreview().textContent).toContain("某候选人");
    fireEvent.click(screen.getByRole("checkbox", { name: /姓名脱敏/ }));
    expect(identityPreview().textContent).toContain("张三");
    expect(screen.queryByRole("radio", { name: "固定代号" })).toBeNull();
    expect(screen.getByText(/已脱敏 6 项身份信息/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "保留前3后4 (138****0000)" }));
    expect(identityPreview().textContent).toContain("138****0000");
    const saved = JSON.parse(localStorage.getItem("resume_life_anonymize_config")!);
    expect(saved.name).toMatchObject({ enabled: false, mode: "placeholder" });
    expect(saved.phone).toMatchObject({ enabled: true, mode: "mask_middle" });
  });

  it("重新打开组件读取已保存的配置，基础开关同时控制头像提示", () => {
    localStorage.setItem("resume_life_anonymize_config", JSON.stringify({
      ...DEFAULT_ANONYMIZE_CONFIG, name: { ...DEFAULT_ANONYMIZE_CONFIG.name, enabled: false },
    }));
    renderDialog();
    expect((screen.getByRole("checkbox", { name: /姓名脱敏/ }) as HTMLInputElement).checked).toBe(false);
    expect(identityPreview().textContent).toContain("张三");
    expect(screen.getByText("原始头像照片已安全剥离，输出排版将自动调整。")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "移除个人头像照片" }));
    expect(screen.queryByText("原始头像照片已安全剥离，输出排版将自动调整。")).toBeNull();
    expect(screen.getByText(/已脱敏 5 项身份信息/)).toBeTruthy();
  });

  it("快捷占位、自定义规则的添加、重复拦截和删除保持原行为", () => {
    renderDialog();
    const source = screen.getByPlaceholderText("输入其他敏感词(如 内部代号/秘密系统名)") as HTMLInputElement;
    const replacement = screen.getByPlaceholderText("替换占位符(如 [某保密微服务平台])") as HTMLInputElement;
    expect((screen.getByRole("button", { name: "添加规则" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "+ 保密项目A" }));
    expect(replacement.value).toBe("[某保密核心项目A]");
    fireEvent.change(source, { target: { value: " Project-Zeus " } });
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));
    expect(screen.getByText("补充其他保密代号或敏感词 (1)")).toBeTruthy();
    expect(screen.getByText(/正文替换 3 处敏感实体\/词/)).toBeTruthy();
    expect(source.value).toBe("");
    expect(replacement.value).toBe("");

    addRule("project-zeus", "重复规则");
    expect(screen.getByText(/敏感词「project-zeus」已在规则列表中/)).toBeTruthy();
    expect(screen.getByText("补充其他保密代号或敏感词 (1)")).toBeTruthy();
    fireEvent.click(screen.getByTitle("删除此规则"));
    expect(screen.getByText("补充其他保密代号或敏感词 (0)")).toBeTruthy();
    expect(screen.getByText(/正文替换 2 处敏感实体\/词/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("resume_life_anonymize_config")!).customRules).toEqual([]);
  });

  it("公司和项目默认脱敏、学校默认保留，批量开关和学校勾选更新统计", () => {
    renderDialog();
    const company = screen.getByRole("checkbox", { name: "字节跳动" }) as HTMLInputElement;
    const project = screen.getByRole("checkbox", { name: "全栈简历生成系统" }) as HTMLInputElement;
    const school = screen.getByRole("checkbox", { name: "清华大学" }) as HTMLInputElement;
    expect(company.checked).toBe(true);
    expect(project.checked).toBe(true);
    expect(school.checked).toBe(false);
    const companySection = screen.getByText("自动识别的公司与机构名称 (1)").closest("section")!;
    fireEvent.click(within(companySection).getByRole("button", { name: "取消全选" }));
    expect(company.checked).toBe(false);
    expect((within(companySection).getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/正文替换 1 处敏感实体\/词/)).toBeTruthy();
    fireEvent.click(within(companySection).getByRole("button", { name: "全选脱敏" }));
    fireEvent.click(school);
    expect(company.checked).toBe(true);
    expect(screen.getByText(/正文替换 3 处敏感实体\/词/)).toBeTruthy();
  });

  it("实体覆盖与自定义规则共同进入导出检查，返回修改保留输入草稿和覆盖", () => {
    renderDialog({ layout: [], paperHeight: 1123, pageMargin: 32 });
    const companyRow = screen.getByText("字节跳动").closest("div")!;
    fireEvent.change(within(companyRow).getByRole("textbox"), { target: { value: " 匿名团队 " } });
    addRule();
    const source = screen.getByPlaceholderText("输入其他敏感词(如 内部代号/秘密系统名)") as HTMLInputElement;
    fireEvent.change(source, { target: { value: "尚未添加的代号" } });
    fireEvent.click(screen.getByRole("button", { name: "📄 导出脱敏 Markdown" }));
    const content = exportedContent();
    expect(content.title).toBe("[脱敏版] 张*的前端简历");
    expect(JSON.stringify(content.modules)).toContain("匿名团队");
    expect(JSON.stringify(content.modules)).toContain("保密系统");
    expect(JSON.stringify(content.modules)).not.toContain("字节跳动");
    expect(mocks.check.mock.lastCall![0]).toMatchObject({ layout: [], paperHeight: 1123, pageMargin: 32 });
    fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
    expect((screen.getByPlaceholderText("输入其他敏感词(如 内部代号/秘密系统名)") as HTMLInputElement).value).toBe("尚未添加的代号");
    expect((within(screen.getByText("字节跳动").closest("div")!).getByRole("textbox") as HTMLInputElement).value).toBe(" 匿名团队 ");
    expect(screen.getByText("补充其他保密代号或敏感词 (1)")).toBeTruthy();
  });

  it.each([
    ["md", "📄 导出脱敏 Markdown"],
    ["pdf", "📥 导出脱敏 PDF"],
    ["docx", "导出脱敏 DOCX"],
  ] as const)("%s 导出先等待保存，再使用当前脱敏结果与检查参数", async (format, buttonName) => {
    const pending = Promise.withResolvers<void>();
    const beforeExport = vi.fn(() => pending.promise);
    const onClose = vi.fn();
    renderDialog({ beforeExport, onClose, modules: modules.map((module) => module.type === "work"
      ? { ...module, label: "Project-Zeus 经历" } : module) });
    fireEvent.change(within(screen.getByText("字节跳动").closest("div")!).getByRole("textbox"), { target: { value: "匿名团队" } });
    addRule();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    const content = exportedContent();
    expect(content.modules.find((module) => module.type === "work")!.label).toBe("保密系统 经历");
    expect(beforeExport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
    expect(beforeExport).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.resumeToMarkdown).not.toHaveBeenCalled();
    expect(mocks.downloadCheckedResume).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    if (format === "md") {
      expect(mocks.resumeToMarkdown).toHaveBeenCalledWith(content.title, content.modules);
      expect(mocks.downloads).toEqual([{ href: "blob:anonymized", filename: "[脱敏版] 张*的前端简历.md" }]);
    } else {
      const effectiveConfig = expect.objectContaining({ customRules: expect.arrayContaining([
        expect.objectContaining({ source: "字节跳动", replacement: "匿名团队" }),
        expect.objectContaining({ source: "Project-Zeus", replacement: "保密系统" }),
      ]) });
      if (format === "pdf") {
        expect(mocks.fetch).toHaveBeenCalledWith("/api/resumes/r-1/export/pdf", expect.objectContaining({
          method: "POST", headers: { "Content-Type": "application/json" },
        }));
        expect(JSON.parse(mocks.fetch.mock.lastCall![1].body)).toEqual({
          anonymizeConfig: effectiveConfig, confirmedIssueIds: ["metric-1"], skipExportCheck: false,
        });
        expect(mocks.downloads).toEqual([{ href: "blob:anonymized", filename: "[脱敏版] 张*的前端简历.pdf" }]);
      } else {
        expect(mocks.downloadCheckedResume).toHaveBeenCalledWith("r-1", "[脱敏版] 简历", "docx", ["metric-1"], {
          anonymizeConfig: effectiveConfig, skipExportCheck: false,
        });
      }
    }
    if (format !== "docx") {
      expect(mocks.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:anonymized");
    }
  });

  it("Markdown 正文标题及下载文件名都替换合成姓名和标题中的保密代号", async () => {
    renderDialog({ title: "合成候选人的 Project-Zeus 简历", modules: [
      { key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: "合成候选人" } },
      { key: "summary", type: "summary", label: "简介", sort: 1, content: { text: "Project-Zeus 研发" } },
    ] });
    addRule();
    fireEvent.click(screen.getByRole("button", { name: "📄 导出脱敏 Markdown" }));
    const content = exportedContent();
    for (const secret of ["合成候选人", "Project-Zeus"]) expect(content.title).not.toContain(secret);
    fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
    await waitFor(() => expect(mocks.downloads).toHaveLength(1));
    const blob = mocks.createObjectURL.mock.lastCall![0];
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(text).toContain("保密系统");
    for (const secret of ["合成候选人", "Project-Zeus"]) {
      expect(text).not.toContain(secret);
      expect(mocks.downloads[0]!.filename).not.toContain(secret);
    }
  });

  it.each([true, false])("PDF 有无服务端附件名（%s）都不回退到原标题", async (withHeader) => {
    const safeFilename = "[脱敏版] 合成代号的保密系统简历.pdf";
    mocks.fetch.mockResolvedValueOnce({ ok: true, headers: new Headers(withHeader ? {
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
    } : {}), blob: async () => new Blob(["PDF"]) });
    renderDialog({ title: "合成候选人的 Project-Zeus 简历" });
    fireEvent.click(screen.getByRole("button", { name: "📥 导出脱敏 PDF" }));
    fireEvent.click(screen.getByRole("button", { name: "确认继续" }));
    await waitFor(() => expect(mocks.downloads).toHaveLength(1));
    expect(mocks.downloads[0]!.filename).toBe(withHeader ? safeFilename : "[脱敏版] 简历.pdf");
    expect(mocks.downloads[0]!.filename).not.toContain("合成候选人");
    expect(mocks.downloads[0]!.filename).not.toContain("Project-Zeus");
  });
});
