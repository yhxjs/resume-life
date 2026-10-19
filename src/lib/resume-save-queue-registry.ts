import { jsonFetch } from "@/lib/fetcher";

import { ResumeSaveQueue } from "@/lib/resume-save-queue-core";

import type { ResumeDocument } from "@/lib/resume-save-queue-draft";

const queues = new Map<string, ResumeSaveQueue>();
let unloadGuardInstalled = false;
let logoutPrepared = false;

export function hasPendingResumeDrafts(): boolean {
  return [...queues.values()].some((queue) => queue.hasPending);
}

export function clearResumeDrafts(): void {
  for (const queue of queues.values()) {
    if (!queue.clearLocalDraft()) throw new Error("无法清除本机草稿，请检查浏览器存储权限");
  }
}

/** 用户已明确决定退出时如何处理草稿，停止后台写入和重复的离页询问。 */
export function prepareResumeQueuesForLogout(): void {
  for (const queue of queues.values()) queue.disposeAutoWork();
  logoutPrepared = true;
}

/**
 * 队列已无待保存内容、无订阅者且无在途工作时回收，避免长会话中 Map 单调增长。
 * 有待保存草稿的队列必须保留，否则会失去 beforeunload 保护。
 */
function releaseIdleQueue(queue: ResumeSaveQueue): void {
  if (queue.hasPending || queue.hasSubscribers || queue.hasActiveWork) return;
  for (const [id, candidate] of queues) {
    if (candidate !== queue) continue;
    queue.disposeAutoWork();
    queues.delete(id);
    return;
  }
}

export function getResumeSaveQueue(id: string) {
  // 队列会在站内导航后继续存在，关闭保护必须覆盖离开编辑器后的待保存草稿。
  if (!unloadGuardInstalled && typeof window !== "undefined") {
    window.addEventListener("beforeunload", (event) => {
      if (logoutPrepared || ![...queues.values()].some((queue) => queue.needsUnloadWarning)) return;
      // 现代浏览器以 preventDefault() 作为「需要确认离开」的信号；
      // 已废弃的 event.returnValue 赋值在非 BeforeUnloadEvent 上会抛 TypeError。
      event.preventDefault();
    });
    unloadGuardInstalled = true;
  }
  let queue = queues.get(id);
  if (!queue) {
    const key = `resume-life:draft:${id}`;
    queue = new ResumeSaveQueue(
      (body, signal) => {
        const serialized = JSON.stringify(body);
        return jsonFetch<ResumeDocument>(`/api/resumes/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: serialized,
          signal,
          // keepalive 有约 64 KiB 的限制；大草稿用普通请求并保留本地恢复副本。
          keepalive: new TextEncoder().encode(serialized).byteLength <= 60 * 1024,
        });
      },
      {
        read: () => sessionStorage.getItem(key) ?? "",
        write: (value) => value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key),
      },
      {},
      releaseIdleQueue,
    );
    queues.set(id, queue);
  }
  return queue;
}
