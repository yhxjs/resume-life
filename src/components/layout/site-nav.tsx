"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CommandPalette } from "@/components/layout/command-palette";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { Modal } from "@/components/common/modal";
import { alertDialog } from "@/components/common/confirm-dialog";
import { btnGhost, btnPrimary } from "@/lib/ui";
import { clearSensitiveBrowserData, hasSensitiveBrowserDrafts } from "@/lib/browser-sensitive-data";
import { prepareResumeQueuesForLogout } from "@/lib/resume-save-queue-registry";

type NavItem =
  | {
      type: "link";
      href: string;
      label: string;
    }
  | {
      type: "dropdown";
      label: string;
      children: { href: string; label: string; desc?: string }[];
    };

const NAV_ITEMS: NavItem[] = [
  { type: "link", href: "/", label: "首页" },
  {
    type: "dropdown",
    label: "简历中心",
    children: [
      { href: "/resumes", label: "简历管理", desc: "结构化维护与导出" },
      { href: "/styles", label: "样式工厂", desc: "模板样式与 AI 调优" },
      { href: "/knowledge", label: "知识库", desc: "项目沉淀与材料提炼" },
    ],
  },
  {
    type: "dropdown",
    label: "面试演练",
    children: [
      { href: "/interviews", label: "模拟面试", desc: "全真文字模考与连打" },
      { href: "/drills", label: "题目练习", desc: "项目深挖与通用题精练" },
      { href: "/intros", label: "自我介绍", desc: "30秒/2分钟定制与背诵" },
    ],
  },
  {
    type: "dropdown",
    label: "题库复盘",
    children: [
      { href: "/review", label: "复盘看板", desc: "多维评分与趋势分析" },
      { href: "/notebook", label: "错题本", desc: "错题温习与分类整理" },
      { href: "/bank", label: "岗位题库", desc: "八股与行为题沉淀" },
    ],
  },
  { type: "link", href: "/applications", label: "求职看板" },
  { type: "link", href: "/tools", label: "工具箱" },
  { type: "link", href: "/settings", label: "设置" },
];

export function SiteNav() {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [logoutChoiceOpen, setLogoutChoiceOpen] = useState(false);
  const drawerRef = useModalFocus(drawerOpen, () => setDrawerOpen(false));
  const [lastPath, setLastPath] = useState(pathname);
  const navRef = useRef<HTMLElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 路由变化自动收起下拉菜单与移动端抽屉
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpenDropdown(null);
    if (drawerOpen) setDrawerOpen(false);
  }

  const clearCloseTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const handleMouseEnter = (label: string) => {
    clearCloseTimeout();
    setOpenDropdown(label);
  };

  const handleMouseLeave = () => {
    clearCloseTimeout();
    timeoutRef.current = setTimeout(() => {
      setOpenDropdown(null);
    }, 150);
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        const focused = document.activeElement;
        const dropdown = focused instanceof HTMLElement ? focused.closest("[data-nav-dropdown]") : null;
        const trigger = dropdown?.querySelector<HTMLButtonElement>("button[aria-expanded='true']");
        trigger?.focus();
        setOpenDropdown(null);
        setDrawerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearCloseTimeout();
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  // Ctrl+K（Mac 为 Cmd+K）全局唤起/收起搜索面板
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 登录页不需要站点导航；放在所有 hook 之后，保证路由切换时 hook 调用数稳定
  if (pathname === "/login") return null;

  async function handleLogout() {
    try {
      if (hasSensitiveBrowserDrafts()) {
        setLogoutChoiceOpen(true);
        return;
      }
      await finishLogout(false);
    } catch {
      // 存储不可读不能阻止撤销会话；将草稿状态视作未知，让用户明确选择。
      setLogoutError("无法检查本机未保存草稿，请选择保留或清除后退出。清理失败时会提示手动清除本站数据。");
      setLogoutChoiceOpen(true);
    }
  }

  async function finishLogout(keepDrafts: boolean) {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await jsonFetch("/api/auth/logout", { method: "POST" });
      prepareResumeQueuesForLogout();
      try {
        clearSensitiveBrowserData(keepDrafts);
      } catch {
        await alertDialog({ title: "会话已退出", message: "本机副本清除未完成。请在浏览器中清除本站数据，并关闭其他打开的标签页。" });
      }
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 登出是鉴权状态切换，整页刷新以清空所有页面的客户端状态
      window.location.assign("/login");
    } catch (reason) {
      setLogoutError(`退出失败：${errorMessage(reason)}。请重试退出。`);
      setLoggingOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b-2 border-primary bg-chrome">
      <nav
        ref={navRef}
        className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-2 px-4 sm:px-6"
      >
        <div className="flex items-center gap-4">
          <Link
            href="/"
            onClick={() => setDrawerOpen(false)}
            className="flex shrink-0 items-center gap-2.5 whitespace-nowrap font-serif text-[18px] font-bold tracking-wide text-chrome-ink group"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt="简历奕生 Logo"
              width={30}
              height={30}
              className="rounded-lg object-cover shadow-xs ring-1 ring-white/20 transition-transform duration-200 group-hover:scale-105"
            />
            <span>简历奕生</span>
            <span aria-hidden className="h-2 w-2 self-center rounded-full bg-chrome-dot" />
          </Link>

          {/* 桌面端导航（md 及以上显示） */}
          <div className="hidden md:flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              if (item.type === "link") {
                const active =
                  item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-chrome-active font-medium text-on-chrome-active"
                        : "text-chrome-muted hover:bg-chrome-line/50 hover:text-chrome-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              }

              const isChildActive = item.children.some((child) =>
                pathname.startsWith(child.href)
              );
              const isOpen = openDropdown === item.label;

              return (
                <div
                  key={item.label}
                  data-nav-dropdown
                  className="relative shrink-0"
                  onMouseEnter={() => handleMouseEnter(item.label)}
                  onMouseLeave={handleMouseLeave}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setOpenDropdown((cur) => (cur === item.label ? null : item.label))
                    }
                    aria-expanded={isOpen}
                    aria-controls={`nav-dropdown-${item.label}`}
                    className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      isOpen || isChildActive
                        ? "bg-chrome-active font-medium text-on-chrome-active"
                        : "text-chrome-muted hover:bg-chrome-line/50 hover:text-chrome-ink"
                    }`}
                  >
                    <span>{item.label}</span>
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                      className={`h-4 w-4 transition-transform duration-150 ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>

                  <div
                    id={`nav-dropdown-${item.label}`}
                    aria-hidden={!isOpen}
                    className={`absolute left-0 top-full z-40 pt-1.5 transition-all duration-200 ease-out ${
                      isOpen
                        ? "visible translate-y-0 opacity-100 scale-100 pointer-events-auto"
                        : "invisible -translate-y-1.5 opacity-0 scale-95 pointer-events-none"
                    }`}
                  >
                    <div className="w-48 rounded-xl border border-chrome-line bg-chrome p-1.5 shadow-xl ring-1 ring-black/20 focus:outline-none">
                      {item.children.map((child) => {
                        const active = pathname.startsWith(child.href);
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            tabIndex={isOpen ? undefined : -1}
                            onClick={() => setOpenDropdown(null)}
                            className={`group/item flex flex-col rounded-lg px-3 py-2 text-left transition-all duration-150 ${
                              active
                                ? "bg-chrome-active text-on-chrome-active font-medium"
                                : "text-chrome-ink hover:bg-chrome-line/50 hover:translate-x-0.5"
                            }`}
                          >
                            <span className="text-sm transition-transform duration-150">
                              {child.label}
                            </span>
                            {child.desc && (
                              <span
                                className={`text-xs transition-colors duration-150 ${
                                  active
                                    ? "text-on-chrome-active/80"
                                    : "text-chrome-muted group-hover/item:text-chrome-ink/90"
                                }`}
                              >
                                {child.desc}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右侧操作区 */}
        <div className="flex items-center gap-2">
          {/* 桌面端搜索按钮 */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="全局搜索"
            aria-keyshortcuts="Control+K"
            className="hidden sm:flex shrink-0 items-center gap-2 rounded-lg border border-chrome-line px-3 py-1.5 text-sm text-chrome-muted transition-colors hover:bg-chrome-line/50 hover:text-chrome-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chrome-dot"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span>搜索</span>
            <kbd className="rounded border border-chrome-line px-1 font-mono text-[10px]">
              Ctrl K
            </kbd>
          </button>

          {/* 移动端紧凑搜索图标按钮 */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="全局搜索"
            className="flex sm:hidden h-10 w-10 items-center justify-center rounded-lg border border-chrome-line/60 text-chrome-muted transition-colors hover:bg-chrome-line/50 hover:text-chrome-ink"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>

          {/* 退出登录 */}
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label="退出登录"
            title="退出登录"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-chrome-line/60 text-chrome-muted transition-colors hover:bg-chrome-line/50 hover:text-chrome-ink disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden
            >
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
          </button>

          {/* 移动端汉堡菜单按钮 */}
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={drawerOpen ? "关闭导航菜单" : "打开导航菜单"}
            aria-expanded={drawerOpen}
            className="flex md:hidden h-10 w-10 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-chrome-line/60 text-chrome-ink transition-colors hover:bg-chrome-line/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-chrome-dot"
          >
            {drawerOpen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            )}
          </button>
        </div>
      </nav>
      {logoutError && !logoutChoiceOpen && (
        <div role="alert" className="mx-auto flex max-w-[1600px] items-center gap-3 border-t border-danger/30 bg-danger-wash px-4 py-3 text-sm text-danger sm:px-6">
          <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{logoutError}</p>
          <button type="button" onClick={handleLogout} disabled={loggingOut} className="shrink-0 rounded-lg border border-danger/30 px-3 py-1.5 disabled:opacity-60">
            重试退出
          </button>
        </div>
      )}

      {/* 移动端抽屉 (Drawer) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          {/* 遮罩背景 */}
          <div
            className="overlay-in fixed inset-0 bg-overlay/80 backdrop-blur-xs"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />

          {/* 侧滑抽屉面板 */}
          <div
            ref={drawerRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            className="dialog-in fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col border-l border-chrome-line bg-chrome text-chrome-ink shadow-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            {/* 抽屉顶栏 */}
            <div className="flex h-14 items-center justify-between border-b border-chrome-line px-4">
              <span className="font-serif text-base font-bold text-chrome-ink flex items-center gap-1.5">
                <span>导航菜单</span>
                <span className="h-1.5 w-1.5 rounded-full bg-chrome-dot" aria-hidden />
              </span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-chrome-muted hover:bg-chrome-line/50 hover:text-chrome-ink"
                aria-label="关闭菜单"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* 抽屉导航链接列表 */}
            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              {/* 首页直达 */}
              <Link
                href="/"
                onClick={() => setDrawerOpen(false)}
                className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
                  pathname === "/"
                    ? "bg-chrome-active text-on-chrome-active font-semibold shadow-xs"
                    : "text-chrome-ink hover:bg-chrome-line/40"
                }`}
              >
                <span>首页</span>
              </Link>

              {/* 分组列表 */}
              {NAV_ITEMS.filter((it) => it.type === "dropdown").map((group) => {
                if (group.type !== "dropdown") return null;
                return (
                  <div key={group.label} className="space-y-1">
                    <div className="px-3 pt-2 text-[11px] font-semibold tracking-wider text-chrome-muted/80 uppercase">
                      {group.label}
                    </div>
                    <div className="space-y-0.5">
                      {group.children.map((child) => {
                        const active = pathname.startsWith(child.href);
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            onClick={() => setDrawerOpen(false)}
                            className={`flex flex-col rounded-xl px-3.5 py-2 transition-colors ${
                              active
                                ? "bg-chrome-active text-on-chrome-active font-semibold shadow-xs"
                                : "text-chrome-ink hover:bg-chrome-line/40"
                            }`}
                          >
                            <span className="text-sm leading-tight">{child.label}</span>
                            {child.desc && (
                              <span
                                className={`text-xs mt-0.5 ${
                                  active ? "text-on-chrome-active/80" : "text-chrome-muted"
                                }`}
                              >
                                {child.desc}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* 工具与设置 */}
              <div className="pt-2 border-t border-chrome-line/60 space-y-0.5">
                {NAV_ITEMS.filter((it) => it.type === "link" && it.href !== "/").map((link) => {
                  if (link.type !== "link") return null;
                  const active = pathname.startsWith(link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setDrawerOpen(false)}
                      className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-chrome-active text-on-chrome-active font-semibold shadow-xs"
                          : "text-chrome-ink hover:bg-chrome-line/40"
                      }`}
                    >
                      <span>{link.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
      <Modal open={logoutChoiceOpen} title="退出前处理未保存草稿" onClose={() => { if (!loggingOut) setLogoutChoiceOpen(false); }} escapeDisabled={loggingOut} closeOnBackdrop={!loggingOut}>
        <p className="text-sm text-muted">当前浏览器有未保存的简历草稿。清除后无法恢复；保留的草稿仍可在此标签页重新登录后恢复。脱敏规则中的敏感原词会随退出清除。</p>
        {logoutError && <p role="alert" className="mt-3 text-sm text-danger">{logoutError}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className={btnGhost} disabled={loggingOut} onClick={() => setLogoutChoiceOpen(false)}>取消</button>
          <button type="button" className={btnGhost} disabled={loggingOut} onClick={() => void finishLogout(true)}>保留草稿并退出</button>
          <button type="button" className={btnPrimary} disabled={loggingOut} onClick={() => void finishLogout(false)}>清除草稿并退出</button>
        </div>
      </Modal>
    </header>
  );
}
