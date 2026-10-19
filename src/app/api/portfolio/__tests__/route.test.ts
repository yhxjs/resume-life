import { resolveStyle } from "@/lib/templates";
import { afterEach, describe, it, expect, vi } from "vitest";
import { GET } from "../sources/route";
import { POST } from "../export/route";
import { NextRequest } from "next/server";
import * as portfolioLib from "@/lib/portfolio";
import * as generatorLib from "@/lib/portfolio-generator";

afterEach(() => vi.restoreAllMocks());

describe("portfolio API routes", () => {
  it("GET /api/portfolio/sources 应返回正确数据源结构", async () => {
    vi.spyOn(portfolioLib, "loadPortfolioSources").mockReturnValue({
      resumes: [
        {
          id: 1,
          title: "测试简历",
          updated_at: "2026-09-29",
          versions: [],
        },
      ],
      projects: [],
    });

    const res = await GET(new Request("http://localhost/api/portfolio/sources"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resumes).toHaveLength(1);
    expect(data.resumes[0].title).toBe("测试简历");
  });

  it("POST /api/portfolio/export 校验空参数应返回 400", async () => {
    const req = new NextRequest("http://localhost/api/portfolio/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resumeId: 0, selectedProjects: [] }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("POST /api/portfolio/export 正常参数应返回 zip 流", async () => {
    vi.spyOn(portfolioLib, "assemblePortfolioData").mockReturnValue({
      siteTitle: "测试作品集",
      siteSubtitle: "工程师",
      accentColor: "#2563eb",
      themeMode: "auto",
      anonymizeConfig: {
        name: { enabled: true, mode: "surname_only" },
        phone: { enabled: true, mode: "prefix_only" },
        email: { enabled: true, mode: "mask_account" },
        location: { enabled: true, mode: "city_only" },
        birthday: { enabled: true, mode: "year_only" },
        links: { enabled: true, mode: "remove" },
        avatar: { enabled: true },
        customRules: [],
      },
      resumeSnapshot: { resolved_style: resolveStyle("classic", []),
        title: "测试简历",
        template: "classic",
        style_overrides: {},
        modules: [
          {
            key: "basic",
            type: "basic",
            label: "基本信息",
            sort: 0,
            content: { name: "王小五", title: "后端" },
          },
        ],
      },
      projects: [],
    });

    vi.spyOn(generatorLib, "createPortfolioZip").mockResolvedValue(
      Buffer.from("mock-zip-content")
    );

    const req = new NextRequest("http://localhost/api/portfolio/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resumeId: 1,
        selectedProjects: [],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("portfolio-");
  });
});
