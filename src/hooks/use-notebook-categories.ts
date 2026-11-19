"use client";

import { useEffect, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { readNotebookCategories, type NotebookCategory } from "@/lib/notebook-records";

export function useNotebookCategories() {
  const [categories, setCategories] = useState<NotebookCategory[] | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<unknown>("/api/notebook/categories", { signal: controller.signal, cache: "no-store" })
      .then(value => {
        if (controller.signal.aborted) return;
        const list = readNotebookCategories(value);
        setCategories(list); setError("");
      })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [version]);
  return { categories, error, reload: () => { setError(""); setVersion(previous => previous + 1); } };
}
