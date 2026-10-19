import type { Metadata } from "next";
import { connection } from "next/server";
import { requestDataGeneration } from "@/lib/db";
import { DATA_GENERATION_META, INITIAL_DATA_GENERATION } from "@/lib/data-generation-contract";
// Geist 走本地 fontsource 包，中文使用系统字体，构建期不依赖在线下载
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./globals.css";
import { SiteNav } from "@/components/layout/site-nav";
import { ConfirmDialogHost } from "@/components/common/confirm-dialog";

export const metadata: Metadata = {
  title: "简历奕生 — AI 求职准备工具",
  description: "管理结构化简历、沉淀项目知识、练习面试题并模拟面试",
  icons: {
    icon: [
      { url: "/favicon.ico" },
      { url: "/logo.png?v=3" },
    ],
    apple: "/logo.png?v=3",
  },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const generation = requestDataGeneration() ?? INITIAL_DATA_GENERATION;
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <head><meta name={DATA_GENERATION_META} content={generation} /></head>
      <body className="flex min-h-full flex-col">
        <SiteNav />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 sm:px-6 sm:py-10 lg:py-12">
          {children}
        </main>
        <footer className="no-print border-t border-line">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-4 sm:px-6">
            <span className="text-xs text-muted">
              简历奕生 <span className="ml-1 font-mono text-faint">resume-life</span>
            </span>
            <span className="text-xs text-faint">个人求职准备工具</span>
          </div>
        </footer>
        <ConfirmDialogHost />
      </body>
    </html>
  );
}
