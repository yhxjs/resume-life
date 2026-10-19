import { beforeEach, describe, expect, it, vi } from "vitest";

let slots: unknown[] = [];
let cursor = 0;
let effects: Array<() => void | (() => void)> = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useRef: (initialValue: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initialValue };
      return slots[index];
    },
    useCallback: (fn: (...args: unknown[]) => unknown) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effects.push(effect);
    },
  };
});

// 在 mock 之后引入
import { useAutoScroll } from "../use-auto-scroll";

describe("useAutoScroll", () => {
  beforeEach(() => {
    slots = [];
    cursor = 0;
    effects = [];
  });

  function createMockElement(initial = { scrollHeight: 200, scrollTop: 100, clientHeight: 100 }) {
    let { scrollHeight, scrollTop, clientHeight } = initial;
    const listeners: Record<string, ((e?: unknown) => void)[]> = {};

    return {
      get scrollHeight() { return scrollHeight; },
      set scrollHeight(val: number) { scrollHeight = val; },
      get scrollTop() { return scrollTop; },
      set scrollTop(val: number) { scrollTop = val; },
      get clientHeight() { return clientHeight; },
      set clientHeight(val: number) { clientHeight = val; },
      addEventListener: (evt: string, cb: (e?: unknown) => void) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(cb);
      },
      removeEventListener: (evt: string, cb: (e?: unknown) => void) => {
        if (listeners[evt]) {
          listeners[evt] = listeners[evt].filter((l) => l !== cb);
        }
      },
      triggerScroll: () => {
        const cbs = listeners["scroll"] || [];
        cbs.forEach((cb) => cb());
      },
    };
  }

  it("当处于最下方时，文本更新自动将滚动条滚动到最下方", () => {
    const el = createMockElement({ scrollHeight: 100, scrollTop: 0, clientHeight: 100 });

    // 第一次执行 Hook
    cursor = 0;
    effects = [];
    const hook1 = useAutoScroll("第一行");
    hook1.containerRef(el as unknown as HTMLDivElement);
    // 执行当前 effect
    effects.forEach((eff) => eff());

    // 此时文本增长，scrollHeight 从 100 变成 300
    el.scrollHeight = 300;

    // 第二次执行 Hook（模拟组件重渲染，传入新文本）
    cursor = 0;
    effects = [];
    useAutoScroll("第一行\n第二行\n第三行");
    effects.forEach((eff) => eff());

    // 处于底部，应该自动滚动到最下方
    expect(el.scrollTop).toBe(300);
  });

  it("当用户向上滚动离开底部时，后续文本输出不自动滚动", () => {
    const el = createMockElement({ scrollHeight: 400, scrollTop: 300, clientHeight: 100 });

    cursor = 0;
    effects = [];
    const hook1 = useAutoScroll("初始内容");
    hook1.containerRef(el as unknown as HTMLDivElement);
    effects.forEach((eff) => eff());

    // 模拟用户向上滚动：scrollTop 变为 100，距底部 400 - 100 - 100 = 200 > 30
    el.scrollTop = 100;
    el.triggerScroll();

    // 随后文本继续输出，scrollHeight 变成 600
    el.scrollHeight = 600;

    cursor = 0;
    effects = [];
    useAutoScroll("初始内容\n新增内容");
    effects.forEach((eff) => eff());

    // 用户的滚动位置应该被保护，保持 100，不会被强行滚到 600
    expect(el.scrollTop).toBe(100);
  });

  it("当用户重新滚回最下方附近时，后续文本更新恢复自动滚动", () => {
    const el = createMockElement({ scrollHeight: 400, scrollTop: 100, clientHeight: 100 });

    cursor = 0;
    effects = [];
    const hook1 = useAutoScroll("内容");
    hook1.containerRef(el as unknown as HTMLDivElement);
    effects.forEach((eff) => eff());

    // 用户在上方
    el.triggerScroll();

    // 用户滚动回底部附近：scrollTop 变成 285，距底部 400 - 285 - 100 = 15 <= 30
    el.scrollTop = 285;
    el.triggerScroll();

    // 新文字到来
    el.scrollHeight = 550;

    cursor = 0;
    effects = [];
    useAutoScroll("内容\n最新流式段落");
    effects.forEach((eff) => eff());

    // 恢复自动吸底
    expect(el.scrollTop).toBe(550);
  });

  it("调用 scrollToBottom 会强制滚到底部并恢复吸底状态", () => {
    const el = createMockElement({ scrollHeight: 500, scrollTop: 50, clientHeight: 100 });

    cursor = 0;
    effects = [];
    const hook1 = useAutoScroll("内容");
    hook1.containerRef(el as unknown as HTMLDivElement);
    effects.forEach((eff) => eff());

    // 用户滑上去了
    el.triggerScroll();

    // 手动调用 scrollToBottom
    hook1.scrollToBottom();
    expect(el.scrollTop).toBe(500);

    // 之后又有新文字到来
    el.scrollHeight = 700;
    cursor = 0;
    effects = [];
    useAutoScroll("内容\n后续段落");
    effects.forEach((eff) => eff());

    // 吸底已恢复，继续自动吸底
    expect(el.scrollTop).toBe(700);
  });
});
