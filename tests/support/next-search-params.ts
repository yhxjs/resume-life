import { useSyncExternalStore } from "react";
import { vi } from "vitest";

const subscribe = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};
const readSearch = () => window.location.search;

/** jsdom 没有 App Router；模拟 Next 文档约定的原生 history → useSearchParams 同步。 */
export function useTestSearchParams() {
  return new URLSearchParams(useSyncExternalStore(subscribe, readSearch, () => ""));
}

export function mockSearchParamNavigation() {
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    vi.spyOn(window.history, method).mockImplementation((...args) => {
      original(...args);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  }
}
