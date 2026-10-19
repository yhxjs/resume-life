import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ApplicationsPage from "../applications/page";
import BankPage from "../bank/page";
import SettingsPage from "../settings/page";
import ResumeEditorPage from "../resumes/[id]/page";
import PrintPage from "../resumes/[id]/print/page";
import LlmUsagePage from "../settings/usage/page";
import ToolsPage from "../tools/page";
import LoginPage from "../login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: "9001" }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

describe("关键入口页面首屏", () => {
  it("求职投递入口在数据加载前仍显示可达的导航与创建入口", () => {
    const html = renderToStaticMarkup(<ApplicationsPage />);
    expect(html).toContain("登记新投递");
  });

  it("题库入口在列表加载前显示导入入口", () => {
    expect(renderToStaticMarkup(<BankPage />)).toContain("导入考题");
  });

  it("设置页未读取到数据时不输出 API 密钥", () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).not.toContain("synthetic-secret");
  });

  it("简历编辑和打印页首屏不在数据未就绪时输出头像", async () => {
    const editor = await ResumeEditorPage({ params: Promise.resolve({ id: "9001" }) });
    expect(renderToStaticMarkup(editor)).not.toContain("/api/uploads/");
    expect(renderToStaticMarkup(<PrintPage />)).not.toContain("/api/uploads/");
  });

  it("用量页与工具入口提供清晰标题", () => {
    expect(renderToStaticMarkup(<LlmUsagePage />)).toContain("用量统计");
    expect(renderToStaticMarkup(<ToolsPage />)).toContain("JD 考点画像");
  });

  it("登录页在状态返回前显示品牌与连接提示，不渲染任何表单数据", () => {
    const html = renderToStaticMarkup(<LoginPage />);
    expect(html).toContain("简历奕生");
    expect(html).toContain("正在连接服务器");
  });
});
