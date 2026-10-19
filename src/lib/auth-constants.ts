/**
 * 鉴权相关的纯常量：不含任何依赖，供 src/proxy.ts（其 bundle 不允许引入数据库模块，
 * 否则构建期 NFT 分析会把数据目录卷进 middleware 追踪）与 src/lib/auth.ts 共用。
 */

export const SESSION_COOKIE_NAME = "resume_life_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** 忘记密码时的逃生门：置为 true 后允许通过 /api/auth/init 覆写用户名和密码 */
export const REINIT_ENV_KEY = "RESUME_LIFE_AUTH_REINIT";
