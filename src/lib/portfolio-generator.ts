import JSZip from "jszip";
import type { SafePortfolioData } from "./portfolio-anonymize";
import { resumeToMarkdown } from "./resume-markdown";
import { renderResumeToHtml } from "./pdf-render";
import { generatePortfolioCss, generatePortfolioHtml, generatePortfolioJs } from "./portfolio-resume-template";
export { generatePortfolioCss, generatePortfolioHtml, generatePortfolioJs, generatePortfolioPreviewHtml } from "./portfolio-resume-template";
import { assertPortfolioSourceBytes, assertPortfolioExpandedBytes } from "./portfolio-export-budget";

export function generateStandaloneResumeHtml(data: SafePortfolioData): string {
  const { resumeSnapshot } = data;
  return renderResumeToHtml({ resume: resumeSnapshot, modules: resumeSnapshot.modules }, []);
}

export function generateResumeMarkdown(data: SafePortfolioData): string {
  const { candidateName, candidateTitle, resumeSnapshot } = data;
  return resumeToMarkdown(`${candidateName} · ${candidateTitle}（脱敏版离线简历）`, resumeSnapshot.modules);
}

export async function createPortfolioZip(data: SafePortfolioData, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  assertPortfolioSourceBytes(Buffer.byteLength(JSON.stringify(data)));
  const zip = new JSZip();

  const indexHtml = generatePortfolioHtml(data);
  const styleCss = generatePortfolioCss(data.accentColor, data.siteTemplate);
  const appJs = generatePortfolioJs(data.themeMode, data.siteTemplate);
  const resumeHtml = generateStandaloneResumeHtml(data);
  const resumeMd = generateResumeMarkdown(data);

  const readme = `# 个人作品集与静态主页

本压缩包由 **简历奕生 (Resume Life)** 自动生成，按所选规则遮盖基础信息和标题中的同名信息。项目正文、自定义链接与其他敏感内容须在公开前人工核对。

## 目录结构
- \`index.html\`: 个人作品集主页（自包含，双击即可直接在本地离线浏览器中打开浏览）。
- \`resume.html\`: 独立脱敏简历预览页（排版优雅，支持无痕打印导出 PDF）。
- \`resume.md\`: 纯文本 Markdown 简历，方便导入笔记库（Obsidian / Notion / 语雀）。
- \`assets/\`: 纯本地自包含的 CSS 样式与 JavaScript 交互脚本（零外部 CDN 依赖，永不失效）。

## 如何快速部署？
1. **GitHub Pages**:
   - 新建 GitHub 仓库，解压本包至根目录或 \`/docs\` 目录，推送后在 Settings -> Pages 开启。
2. **Vercel / Netlify**:
   - 登录控制台，直接将解压后的文件夹拖拽至网页完成零配置秒级上线。
3. **传统 Web 服务器 (Nginx / Apache)**:
   - 解压至静态资源托管目录即可。
`;

  assertPortfolioExpandedBytes([indexHtml, styleCss, appJs, resumeHtml, resumeMd, readme]
    .reduce((bytes, content) => bytes + Buffer.byteLength(content), 0));
  signal?.throwIfAborted();

  zip.file("index.html", indexHtml);
  zip.file("resume.html", resumeHtml);
  zip.file("resume.md", resumeMd);
  zip.file("README.md", readme);

  const assets = zip.folder("assets");
  if (assets) {
    assets.file("style.css", styleCss);
    assets.file("app.js", appJs);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  signal?.throwIfAborted();
  return buffer;
}
