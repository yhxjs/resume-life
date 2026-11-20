"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { clearSensitiveBrowserData } from "@/lib/browser-sensitive-data";
import { errorMessage } from "@/lib/error-message";
import { btnGhost } from "@/lib/ui";

export function LocalDataCleanup() {
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const command = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; command.current?.abort(); command.current = null; };
  }, []);
  async function clear() {
    if (!mounted.current || command.current) return;
    const controller = new AbortController(); command.current = controller;
    const confirmed = await confirmDialog({ title: "清除本机敏感副本", message: "将清除当前浏览器的脱敏规则、项目源码路径、自定义 CLI 客户端配置和此标签页未保存的简历草稿，清除后无法恢复。已保存的简历和下载文件不受影响。", confirmText: "清除副本", danger: true, signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || command.current !== controller) return;
    if (!confirmed) { command.current = null; return; }
    try {
      clearSensitiveBrowserData();
      setFailed(false);
      setMessage("已清除本机脱敏规则、项目源码路径、自定义 CLI 客户端配置和当前标签页草稿。其他打开的标签页请分别清理或关闭。");
    } catch (reason) {
      setFailed(true);
      setMessage(`清除未完成：${errorMessage(reason)}。请检查浏览器存储权限后重试。`);
    } finally {
      command.current = null;
    }
  }
  return <section className="rounded-2xl border border-line bg-card p-6 space-y-3">
    <h2 className="font-serif text-lg font-bold text-ink">本机敏感副本</h2>
    <p className="text-sm text-muted">浏览器会保留脱敏规则、项目源码路径、自定义 CLI 客户端配置和未保存草稿，便于再次使用。共享电脑或需要彻底删除时，请清除这些副本。</p>
    <button type="button" className={btnGhost} onClick={() => void clear()}>清除本机敏感副本</button>
    {message && <p role={failed ? "alert" : "status"} className="text-sm text-muted">{message}</p>}
  </section>;
}
