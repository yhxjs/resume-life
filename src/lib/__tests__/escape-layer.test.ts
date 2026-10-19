import { describe, expect, it } from "vitest";
import { hasOpenEscapeLayer, registerEscapeLayer } from "../escape-layer";

describe("分层 Escape 协议", () => {
  it("没有内层消费者时，模态照常处理 Escape", () => {
    expect(hasOpenEscapeLayer()).toBe(false);
  });

  it("登记后视为有内层消费者，注销后恢复", () => {
    const unregister = registerEscapeLayer();
    expect(hasOpenEscapeLayer()).toBe(true);
    unregister();
    expect(hasOpenEscapeLayer()).toBe(false);
  });

  it("多个内层同时登记时，全部注销后才恢复", () => {
    const first = registerEscapeLayer();
    const second = registerEscapeLayer();

    first();
    expect(hasOpenEscapeLayer()).toBe(true);
    second();
    expect(hasOpenEscapeLayer()).toBe(false);
  });

  it("注销函数可重复调用", () => {
    const unregister = registerEscapeLayer();
    unregister();
    unregister();
    expect(hasOpenEscapeLayer()).toBe(false);
  });
});
