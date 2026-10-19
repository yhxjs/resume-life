"use client";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 读取系统「减少动效」偏好。
 * 每次调用都实时求值，因此用户在会话中切换系统设置也能立即生效；
 * 非浏览器环境返回 false。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 供 scrollIntoView / scrollTo 使用：减少动效时退化为即时跳转 */
export function motionSafeScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
