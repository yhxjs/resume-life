"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { appendReviewList, readReviewList } from "@/lib/review-records";
import { getReviewDate } from "@/lib/spaced-repetition";
import type { ReviewList, ReviewSource } from "@/lib/spaced-repetition-card-types";

export function useReviewList({ scope, source, limit = 50 }: { scope: "due" | "all"; source: "all" | ReviewSource; limit?: number }) {
  const [state, setState] = useState<{ key: string; data: ReviewList | null; loading: boolean; loadingMore: boolean; error: string }>({ key: "", data: null, loading: true, loadingMore: false, error: "" });
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const pagination = useRef<AbortController | null>(null);
  const confirmed = useRef<{ key: string; data: ReviewList } | null>(null);
  const activeKey = useRef<string | null>(null);
  const loadedPages = useRef({ key: "", count: 1 });
  const refreshing = useRef(false);
  const filterKey = `${scope}:${source}:${limit}`;
  const current = state.key === filterKey;
  const data = current ? state.data : null;
  const loading = !current || state.loading;
  const loadingMore = current && state.loadingMore;
  const error = current ? state.error : "";
  const cancelPagination = useCallback(() => {
    generation.current++;
    pagination.current?.abort(); pagination.current = null;
  }, []);
  const reload = useCallback(() => {
    cancelPagination();
    refreshing.current = true;
    setState(previous => ({ ...previous, loading: true, loadingMore: false, error: "" }));
    setVersion(value => value + 1);
  }, [cancelPagination]);

  useEffect(() => {
    activeKey.current = filterKey;
    return () => {
      activeKey.current = null;
      cancelPagination();
    };
  }, [filterKey, cancelPagination]);

  function url(cursor?: string) {
    const search = new URLSearchParams({ scope, source, limit: String(limit), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (cursor) search.set("cursor", cursor);
    return `/api/reviews?${search}`;
  }
  async function fetchPage(signal: AbortSignal, cursor?: string) {
    const value = await jsonFetch<unknown>(url(cursor), { signal, cache: "no-store" });
    return readReviewList(value, { scope, source, limit, cursor, date: getReviewDate() });
  }
  useDebouncedSearch({
    queryKey: `${filterKey}:${version}`, delay: 0,
    load: async signal => {
      const count = loadedPages.current.key === filterKey ? loadedPages.current.count : 1;
      let page = await fetchPage(signal);
      let pages = 1;
      for (; pages < count && page.nextCursor; pages++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        page = appendReviewList(page, await fetchPage(signal, page.nextCursor));
      }
      return { page, pages };
    },
    onStart: () => {
      cancelPagination();
      refreshing.current = true;
      setState(previous => ({ key: filterKey, data: previous.key === filterKey ? previous.data : null, loading: true, loadingMore: false, error: "" }));
    },
    onSuccess: ({ page, pages }) => {
      loadedPages.current = { key: filterKey, count: pages };
      confirmed.current = { key: filterKey, data: page };
      refreshing.current = false;
      setState({ key: filterKey, data: page, loading: false, loadingMore: false, error: "" });
    },
    onError: reason => {
      refreshing.current = false;
      setState(previous => ({ key: filterKey, data: previous.key === filterKey ? previous.data : null, loading: false, loadingMore: false, error: errorMessage(reason) }));
    },
  });

  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState === "visible") reload(); };
    // 在跨日、标签页重新打开和其他复习面板保存后更新当天队列。
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("reviews-updated", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("reviews-updated", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      pagination.current?.abort();
    };
  }, [reload]);

  async function loadMore() {
    const snapshot = confirmed.current;
    if (activeKey.current !== filterKey || snapshot?.key !== filterKey || !snapshot.data.nextCursor || pagination.current || loading || refreshing.current) return;
    const controller = new AbortController();
    const currentGeneration = generation.current;
    pagination.current = controller;
    setState(previous => ({ ...previous, loadingMore: true, error: "" }));
    try {
      const page = await fetchPage(controller.signal, snapshot.data.nextCursor);
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      const merged = appendReviewList(snapshot.data, page);
      loadedPages.current.count++;
      confirmed.current = { key: filterKey, data: merged };
      setState(previous => ({ ...previous, data: merged }));
    } catch (reason) {
      if (!controller.signal.aborted && currentGeneration === generation.current) setState(previous => ({ ...previous, error: errorMessage(reason) }));
    } finally {
      if (pagination.current === controller) { pagination.current = null; setState(previous => ({ ...previous, loadingMore: false })); }
    }
  }
  return { data, loading, loadingMore, error, reload, loadMore };
}
