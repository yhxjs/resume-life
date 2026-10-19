// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiagnoseDialog } from "../diagnose-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { useResumeOptions } from "@/hooks/use-resume-options";
import type { ModuleData } from "@/lib/modules";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({
  getResumeSaveQueue: () => ({ flush: async () => {}, needsUnloadWarning: false }),
}));
vi.mock("@/components/common/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
  alertDialog: vi.fn(async () => {}),
}));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: vi.fn() }));

const resumeOptions = [
  { id: 4, title: "我的简历", updated_at: "", versions: [{ id: 42, version: 2, name: "新版" }, { id: 41, version: 1, name: "投递版" }] },
];

const modules: ModuleData[] = [
  { key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["React", "TypeScript"] } },
];

const historyResponse = (adoptions = false) => ({
  current: {
    id: 7,
    job_id: "job-1",
    job_title: "资深前端",
    jd: "岗位 JD 全文",
    resume_version_id: 41,
    created_at: "2026-09-27T10:00:00.000Z",
    adoptions: adoptions
      ? [{ moduleKey: "skills", suggestionIndex: 0, value: ["React", "TypeScript", "Node.js"], applied_at: "2026-09-27T11:00:00.000Z" }]
      : [],
    resume_snapshot: { title: "简历", modules: [] },
    report: {
      match: 8,
      summary: "整体匹配良好",
      modules: [
        {
          moduleKey: "skills",
          label: "技能",
          scores: { depth: 8, structure: 7, authenticity: 9, completeness: 6 },
          gaps: "缺少 Node.js 相关技能",
          suggestions: [
            { itemId: "", field: "items", reason: "JD 明确要求 Node.js", draft: ["React", "TypeScript", "Node.js"] },
          ],
        },
      ],
    },
  },
  previous: null,
  history: [{ id: 7, job_id: "job-1", job_title: "资深前端", created_at: "2026-09-27T10:00:00.000Z", match: 8 }],
});

beforeEach(() => {
  vi.mocked(useResumeOptions).mockReturnValue({ resumes: resumeOptions, resumesError: "", reloadResumes: vi.fn() });
  vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") return historyResponse(true) as never;
    if (String(url).startsWith("/api/resumes/4/diagnose")) return historyResponse() as never;
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openDialog() {
  const onApply = vi.fn(() => true);
  render(<DiagnoseDialog resumeId="4" modules={modules} onApply={onApply} />);
  fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));
  return onApply;
}

async function openReport() {
  const onApply = openDialog();
  // 改写草稿 textarea 已按建议草稿填充，说明报告加载完成
  const draft = (await screen.findByRole("textbox", { name: /改写草稿/ })) as HTMLTextAreaElement;
  expect(draft.value).toBe("React\nTypeScript\nNode.js");
  return onApply;
}

describe("DiagnoseDialog JD 诊断交互", () => {
  it("点击触发按钮后打开诊断报告并渲染总体评价与改写草稿", async () => {
    await openReport();

    expect(screen.getByText("总体评价")).toBeTruthy();
    expect(screen.getByText("整体匹配良好")).toBeTruthy();
    expect(screen.getByText("缺少 Node.js 相关技能")).toBeTruthy();
    expect(screen.getByRole("button", { name: "采纳写入" })).toBeTruthy();
  });

  it("点击采纳写入回调 onApply 并以 diagnosis_id 回写 PATCH", async () => {
    const onApply = await openReport();

    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith("skills", "", "items", ["React", "TypeScript", "Node.js"]);
    });
    await waitFor(() => {
      const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
        diagnosis_id: 7,
        module_key: "skills",
        suggestion_index: 0,
      });
    });
    // PATCH 结果回填后该建议标记为已采纳
    expect(await screen.findByText(/已采纳写入/)).toBeTruthy();
    expect(vi.mocked(confirmDialog)).toHaveBeenCalledWith(expect.objectContaining({ title: "确认替换当前内容" }));
  });

  it("编辑改写草稿后采纳，onApply 收到编辑后的草稿内容", async () => {
    const onApply = await openReport();

    const draft = screen.getByRole("textbox", { name: /改写草稿/ });
    fireEvent.change(draft, { target: { value: "React\nTypeScript\nNode.js\nVite" } });
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith("skills", "", "items", ["React", "TypeScript", "Node.js", "Vite"]);
    });
  });

  it("诊断时原文与差距说明中的富文本正常渲染为 HTML 元素而非暴露原始 strong 标签", async () => {
    const richWorkModules: ModuleData[] = [
      {
        key: "work_1",
        type: "work",
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "资深开发",
            description: "核心耗时[待确认示例：<strong>从2.5s降至0.8s</strong>]",
          },
        ],
      },
    ];

    vi.mocked(jsonFetch).mockImplementation(async (url: string) => {
      if (String(url).startsWith("/api/resumes/4/diagnose")) {
        return {
          current: {
            id: 8,
            job_id: "job-2",
            job_title: "Java工程师",
            jd: "JD",
            resume_version_id: 41,
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [],
            resume_snapshot: {
              title: "我的简历",
              modules: richWorkModules,
            },
            report: {
              match: 7,
              summary: "<strong>整体表现尚可</strong>",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 },
                  gaps: "包含重要指标 <strong>从2.5s降至0.8s</strong> 与 &lt;strong&gt;转义&lt;/strong&gt;",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "优化<strong>表达</strong>",
                      draft: "优化后的工作内容",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      throw new Error(`unexpected GET: ${url}`);
    });

    render(<DiagnoseDialog resumeId="4" modules={richWorkModules} onApply={vi.fn(() => true)} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));

    // 等待报告渲染出来
    await screen.findByText("总体评价");

    // 1. 诊断时原文中渲染出 <strong> 标签
    const boldNodes = screen.getAllByText("从2.5s降至0.8s");
    expect(boldNodes.some((el) => el.tagName === "STRONG")).toBe(true);

    // 2. 诊断差距说明 gaps 中也渲染出 <strong> 标签
    const transferredBold = screen.getByText("转义");
    expect(transferredBold.tagName).toBe("STRONG");

    // 3. 总体评价 summary 也渲染出 <strong>
    const summaryBold = screen.getByText("整体表现尚可");
    expect(summaryBold.tagName).toBe("STRONG");

    // 确保没有把 <strong> 当纯文本输出在界面上
    expect(screen.queryByText(/<strong>从2.5s降至0.8s<\/strong>/)).toBeNull();
  });

  it("改写草稿支持富文本编辑并在采纳后将富文本写入简历", async () => {
    const onApply = vi.fn(() => true);
    const workModules: ModuleData[] = [
      {
        key: "work_1",
        type: "work",
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "开发",
            description: "旧工作描述",
          },
        ],
      },
    ];

    vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return {
          current: {
            id: 9,
            job_id: "job-3",
            job_title: "前端",
            jd: "JD",
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [
              {
                moduleKey: "work_1",
                suggestionIndex: 0,
                value: "优化后<strong>核心业务</strong>达成",
                applied_at: "2026-09-27T11:00:00.000Z",
              },
            ],
            resume_snapshot: { title: "简历", modules: workModules },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需突出业务核心",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "对齐 JD",
                      draft: "优化后工作描述",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      if (String(url).startsWith("/api/resumes/4/diagnose")) {
        return {
          current: {
            id: 9,
            job_id: "job-3",
            job_title: "前端",
            jd: "JD",
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [],
            resume_snapshot: { title: "简历", modules: workModules },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需突出业务核心",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "对齐 JD",
                      draft: "优化后工作描述",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<DiagnoseDialog resumeId="4" modules={workModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));

    // 等待编辑器加载
    const richEditor = await screen.findByRole("textbox", { name: "改写草稿" });
    expect(richEditor).toBeTruthy();

    // 模拟在富文本编辑器中输入包含 <strong> 标签的内容
    richEditor.innerHTML = "优化后<strong>核心业务</strong>达成";
    fireEvent.input(richEditor);

    // 点击采纳写入
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    // 验证 onApply 收到带富文本 HTML 的值
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith("work_1", "w1", "description", "优化后<strong>核心业务</strong>达成");
    });

    // 验证已采纳状态下富文本渲染成功（显示加粗核心业务）
    await screen.findByText(/已采纳写入/);
    const adoptedBold = screen.getByText("核心业务");
    expect(adoptedBold.tagName).toBe("STRONG");
    expect(screen.queryByText(/<strong>核心业务<\/strong>/)).toBeNull();
  });

  it("经历多行描述在改写草稿中按多行独立编辑，支持新增、调序、删除与合并采纳", async () => {
    const onApply = vi.fn(() => true);
    const workModules: ModuleData[] = [
      {
        key: "work_1",
        type: "work",
        label: "工作经历",
        sort: 1,
        content: [
          {
            id: "w1",
            company: "某科技",
            title: "开发",
            description: "旧工作描述第1行\n旧工作描述第2行",
          },
        ],
      },
    ];

    vi.mocked(jsonFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return {
          current: {
            id: 10,
            job_id: "job-3",
            job_title: "前端工程师",
            jd: "JD",
            resume_version_id: 41,
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [
              {
                moduleKey: "work_1",
                suggestionIndex: 0,
                value: "优化后第2行\n优化后第1行\n新增第3行",
                applied_at: "2026-09-27T11:00:00.000Z",
              },
            ],
            resume_snapshot: { title: "简历", modules: [] },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需补充",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "分行细化描述",
                      draft: "草稿第1行\n草稿第2行",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      if (String(url).startsWith("/api/resumes/4/diagnose")) {
        return {
          current: {
            id: 10,
            job_id: "job-3",
            job_title: "前端工程师",
            jd: "JD",
            resume_version_id: 41,
            created_at: "2026-09-27T10:00:00.000Z",
            adoptions: [],
            resume_snapshot: {
              title: "简历",
              modules: workModules,
            },
            report: {
              match: 8,
              summary: "良好",
              modules: [
                {
                  moduleKey: "work_1",
                  label: "工作经历",
                  scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
                  gaps: "需补充",
                  suggestions: [
                    {
                      itemId: "w1",
                      field: "description",
                      reason: "分行细化描述",
                      draft: "草稿第1行\n草稿第2行",
                    },
                  ],
                },
              ],
            },
          },
          previous: null,
          history: [],
        } as never;
      }
      throw new Error(`unexpected request: ${url}`);
    });

    render(<DiagnoseDialog resumeId="4" modules={workModules} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: /JD 诊断/ }));

    // 原文多行应按多行列表展示
    expect(await screen.findByText("旧工作描述第1行")).toBeTruthy();
    expect(screen.getByText("旧工作描述第2行")).toBeTruthy();

    // 改写草稿初始包含两行独立的富文本编辑框
    const line1 = await screen.findByRole("textbox", { name: "改写草稿第 1 行" });
    const line2 = screen.getByRole("textbox", { name: "改写草稿第 2 行" });
    expect(line1).toBeTruthy();
    expect(line2).toBeTruthy();

    // 交互：点击“+ 添加一行描述”增加第 3 行
    fireEvent.click(screen.getByRole("button", { name: "+ 添加一行描述" }));
    const line3 = await screen.findByRole("textbox", { name: "改写草稿第 3 行" });
    expect(line3).toBeTruthy();

    // 交互：在第 3 行输入内容
    line3.innerHTML = "新增第3行";
    fireEvent.input(line3);

    // 交互：将第 2 行上移到第 1 行
    const upButtons = screen.getAllByRole("button", { name: /上移第 2 行/ });
    fireEvent.click(upButtons[0]!);

    // 修改原来第 1 行（现在是第 2 行）和原来第 2 行（现在是第 1 行）的内容
    const currentLine1 = screen.getByRole("textbox", { name: "改写草稿第 1 行" });
    currentLine1.innerHTML = "优化后第2行";
    fireEvent.input(currentLine1);

    const currentLine2 = screen.getByRole("textbox", { name: "改写草稿第 2 行" });
    currentLine2.innerHTML = "优化后第1行";
    fireEvent.input(currentLine2);

    // 点击采纳写入
    fireEvent.click(screen.getByRole("button", { name: "采纳写入" }));

    // 验证 onApply 收到换行合并后的多行描述
    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith(
        "work_1",
        "w1",
        "description",
        "优化后第2行\n优化后第1行\n新增第3行"
      );
    });

    // 采纳后展示区域也以多行形式渲染采纳内容
    expect(await screen.findByText("优化后第2行")).toBeTruthy();
    expect(screen.getByText("优化后第1行")).toBeTruthy();
    expect(screen.getByText("新增第3行")).toBeTruthy();
  });
});
