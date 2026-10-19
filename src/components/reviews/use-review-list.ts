"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import type { ReviewList, ReviewSource } from "@/lib/spaced-repetition-card-types";

export function useReviewList({ scope, source, limit = 50 }: { scope: "due" | "all"; source: "all" | ReviewSource; limit?: number }) {
  const [data, setData] = useState<ReviewList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const pagination = useRef<AbortController | null>(null);
  const loadedPages = useRef({ key: "", count: 1 });
  const filterKey = `${scope}:${source}:${limit}`;
  const reload = useCallback(() => setVersion(value => value + 1), []);

  function url(cursor?: string) {
    const search = new URLSearchParams({ scope, source, limit: String(limit), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (cursor) search.set("cursor", cursor);
    return `/api/reviews?${search}`;
  }
  useDebouncedSearch({
    queryKey: `${filterKey}:${version}`, delay: 0,
    load: async signal => {
      const count = loadedPages.current.key === filterKey ? loadedPages.current.count : 1;
      let page = await jsonFetch<ReviewList>(url(), { signal });
      const cards = new Map(page.items.map(card => [card.id, card] as const));
      for (let index = 1; index < count && page.nextCursor; index++) {
        page = await jsonFetch<ReviewList>(url(page.nextCursor), { signal });
        for (const card of page.items) cards.set(card.id, card);
      }
      return { ...page, items: Array.from(cards.values()) };
    },
    onStart: () => {
      generation.current++;
      pagination.current?.abort(); pagination.current = null;
      setLoading(true); setLoadingMore(false); setError("");
    },
    onSuccess: page => {
      loadedPages.current = { key: filterKey, count: Math.max(loadedPages.current.key === filterKey ? loadedPages.current.count : 1, Math.ceil(page.items.length / limit)) };
      setData(page); setLoading(false);
    },
    onError: reason => { setError(errorMessage(reason)); setLoading(false); },
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
    if (!data?.nextCursor || pagination.current || loading) return;
    const controller = new AbortController();
    const currentGeneration = generation.current;
    pagination.current = controller; setLoadingMore(true); setError("");
    try {
      const page = await jsonFetch<ReviewList>(url(data.nextCursor), { signal: controller.signal });
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      loadedPages.current.count++;
      setData(previous => previous ? { ...page, items: [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.id === item.id))] } : page);
    } catch (reason) {
      if (!controller.signal.aborted && currentGeneration === generation.current) setError(errorMessage(reason));
    } finally {
      if (pagination.current === controller) { pagination.current = null; setLoadingMore(false); }
    }
  }
  return { data, loading, loadingMore, error, reload, loadMore };
}
