"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CursorPage } from "@/lib/cursor-pagination";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";

export type CursorListOptions<T = unknown> = {
  /** 不含刷新版本号的基础查询键；hook 内部自行追加刷新版本 */
  queryKey: string;
  /** 按游标构造请求 URL；不传 cursor 表示取首页 */
  buildUrl: (cursor?: string) => string;
  /** 防抖延迟，默认 350ms */
  delay?: number;
  /** 应用整页前校验领域条目及请求边界；抛错沿用当前页的失败/重试路径。 */
  validatePage?: (page: CursorPage<T>, cursor?: string) => void;
};

export type CursorListResult<T> = {
  items: T[] | null;
  total: number | null;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  listError: string;
  /** 失败时对应的游标：null=首页失败，string=该页失败，undefined=无失败 */
  failedCursor: string | null | undefined;
  hasMore: boolean;
  loadMore: () => void;
  /** 重新拉取首页（递增内部刷新版本） */
  reload: () => void;
};

/** 这里只校验分页外壳；条目领域结构仍由各页面/接口负责。 */
function readCursorPage<T>(value: unknown): CursorPage<T> {
  if (!value || typeof value !== "object") throw new Error("分页响应不完整，请重试加载");
  const page = value as CursorPage<T>;
  if (!Array.isArray(page.items) ||
    (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor.trim())) ||
    (page.total !== undefined && (!Number.isSafeInteger(page.total) || page.total < 0))) {
    throw new Error("分页响应不完整，请重试加载");
  }
  return page;
}

/**
 * 列表页游标分页状态机：请求版本号 + AbortController + 加载更多互斥锁 + 查询键重置。
 * 而分页竞态是最容易「修一处漏三处」的地方，故收口到此处。
 */
export function useCursorList<T>({ queryKey, buildUrl, delay = 350, validatePage }: CursorListOptions<T>): CursorListResult<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");
  const [failedCursor, setFailedCursor] = useState<string | null | undefined>(undefined);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const requestVersion = useRef(0);
  const loadingMoreRef = useRef(false);
  const paginationAbortRef = useRef<AbortController | null>(null);
  const consumedCursors = useRef(new Set<string>());
  const activeQueryKey = useRef<string | null>(null);
  const confirmedPage = useRef<{ key: string; nextCursor: string | null } | null>(null);

  const effectiveKey = `${queryKey}:${refreshVersion}`;
  const [resultKey, setResultKey] = useState(effectiveKey);
  const queryIsCurrent = resultKey === effectiveKey;

  /** 取数前的统一重置：首屏与「加载更多」共用，避免两条路径的加载态各写一遍 */
  const beginLoad = useCallback((append: boolean) => {
    requestVersion.current += 1;
    loadingMoreRef.current = append;
    setLoadingMore(append);
    setListError("");
    setFailedCursor(undefined);
    if (!append) {
      confirmedPage.current = null;
      setResultKey(effectiveKey);
      setItems(null);
      setLoading(true);
      setTotal(null);
      setNextCursor(null);
      paginationAbortRef.current?.abort();
      paginationAbortRef.current = null;
      consumedCursors.current.clear();
    }
    return requestVersion.current;
  }, [effectiveKey]);

  const applyPage = useCallback((value: unknown, append: boolean, cursor?: string) => {
    const page = readCursorPage<T>(value);
    validatePage?.(page, cursor);
    if (page.nextCursor !== null && (page.nextCursor === cursor || consumedCursors.current.has(page.nextCursor))) {
      throw new Error("分页响应游标未前进，请重试加载或刷新列表");
    }
    if (cursor !== undefined) consumedCursors.current.add(cursor);
    // React 提交新渲染前，连续触发的命令也必须使用已确认的新边界。
    confirmedPage.current = { key: effectiveKey, nextCursor: page.nextCursor };
    setItems((current) => (append && current ? [...current, ...page.items] : page.items));
    if (!append) setTotal(page.total ?? null);
    setNextCursor(page.nextCursor);
    setLoading(false);
    setListError("");
    setFailedCursor(undefined);
  }, [effectiveKey, validatePage]);

  const failLoad = useCallback((err: unknown, cursor: string | null) => {
    setListError(errorMessage(err));
    setFailedCursor(cursor);
    setLoading(false);
  }, []);

  useDebouncedSearch<CursorPage<T>>({
    queryKey: effectiveKey,
    delay,
    load: (signal) => jsonFetch<unknown>(buildUrl(), { signal, cache: "no-store" }).then(readCursorPage<T>),
    onStart: () => beginLoad(false),
    onSuccess: (page) => applyPage(page, false),
    onError: (err) => failLoad(err, null),
  });

  // 查询键变化或卸载时作废在途分页，包括未遵循 AbortSignal 的迟到响应。
  useEffect(() => {
    activeQueryKey.current = effectiveKey;
    requestVersion.current += 1;
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = null;
    loadingMoreRef.current = false;
    return () => {
      activeQueryKey.current = null;
      requestVersion.current += 1;
      paginationAbortRef.current?.abort();
      paginationAbortRef.current = null;
    };
  }, [effectiveKey]);

  const loadMore = useCallback(() => {
    const page = confirmedPage.current;
    if (activeQueryKey.current !== effectiveKey || page?.key !== effectiveKey) return;
    const cursor = page.nextCursor;
    if (cursor === null || loadingMoreRef.current) return;
    paginationAbortRef.current?.abort();
    // 必须在创建 controller 之前完成重置：beginLoad 在首屏路径里会中止当前分页请求，
    // 若先安装新 controller，它会中止掉自己刚发起的这一次请求。
    const version = beginLoad(true);
    const controller = new AbortController();
    paginationAbortRef.current = controller;
    void (async () => {
      try {
        const page = await jsonFetch<unknown>(buildUrl(cursor), { signal: controller.signal, cache: "no-store" });
        if (controller.signal.aborted || version !== requestVersion.current) return;
        applyPage(page, true, cursor);
      } catch (err) {
        if (
          !controller.signal.aborted &&
          !(err instanceof Error && err.name === "AbortError") &&
          version === requestVersion.current
        ) {
          failLoad(err, cursor);
        }
      } finally {
        if (paginationAbortRef.current === controller) {
          paginationAbortRef.current = null;
        }
        if (version === requestVersion.current) {
          loadingMoreRef.current = false;
          setLoadingMore(false);
        }
      }
    })();
  }, [applyPage, beginLoad, buildUrl, effectiveKey, failLoad]);

  const reload = useCallback(() => {
    // 同一事件里旧的 loadMore 闭包也必须立即失效，不能等下一次渲染。
    requestVersion.current += 1;
    paginationAbortRef.current?.abort();
    loadingMoreRef.current = true;
    setRefreshVersion((v) => v + 1);
  }, []);

  return {
    items: queryIsCurrent ? items : null,
    total: queryIsCurrent ? total : null,
    nextCursor: queryIsCurrent ? nextCursor : null,
    loading: loading || !queryIsCurrent,
    loadingMore: queryIsCurrent && loadingMore,
    listError: queryIsCurrent ? listError : "",
    failedCursor: queryIsCurrent ? failedCursor : undefined,
    hasMore: queryIsCurrent && nextCursor !== null,
    loadMore,
    reload,
  };
}
