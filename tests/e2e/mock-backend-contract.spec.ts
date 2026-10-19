import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./synthetic-api";

/**
 * mock 后端 vs 真实后端的形状契约：
 * 20+ 个 e2e spec 跑在 synthetic-api.ts 的手写 mock 上，mock 与真实响应的
 * 形状漂移只会在合成用例里「自洽」地通过。本 spec 用同一批只读 GET 端点分别打
 * 真实后端（webServer 启动的生产服务，request fixture 不做任何 mock）与
 * synthetic-api 的浏览器侧 mock（page.route 拦截），逐端点对比：
 *   1. 顶层键集合一致；
 *   2. 每个顶层键的数组/对象/可空性一致；
 *   3. {items,nextCursor} 游标分页端点的结构（items 为数组、nextCursor 为 string|null）。
 * 端点清单取 synthetic-api mockApi 实际拦截的只读 GET 端点；
 * 需要写入或 LLM 的端点不在本 spec 范围内。
 */

type EndpointSpec = {
  path: string;
  /** {items, nextCursor} 游标分页端点：额外做结构断言 */
  paginated?: boolean;
  /** 需要比对键集合的嵌套对象（如 stats.counts / reviews.summary） */
  nestedKeys?: string[];
};

const ENDPOINTS: EndpointSpec[] = [
  { path: "/api/applications/stats", nestedKeys: ["counts", "rates"] },
  { path: "/api/applications?limit=50", paginated: true },
  { path: "/api/reviews?scope=all&limit=50", paginated: true, nestedKeys: ["summary"] },
  { path: "/api/settings/configured" },
  { path: "/api/templates" },
  { path: "/api/resumes" },
  { path: "/api/projects" },
  { path: "/api/bank?limit=50", paginated: true },
  { path: "/api/bank/directions" },
  { path: "/api/interviews?limit=50", paginated: true },
  { path: "/api/interviews/series?limit=50", paginated: true },
];

/** 顶层值形状：数组 / 对象 / 可空性漂移都会在这里现形 */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sortedKeys(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

async function fetchThroughMock(page: Page, path: string): Promise<unknown> {
  // 页面里发起 fetch 才会经过 page.route 拦截；先 goto 让相对路径可解析
  return page.evaluate(async (target) => (await fetch(target)).json(), path);
}

test.describe("synthetic mock 与真实后端的响应形状契约", () => {
  for (const { path, paginated = false, nestedKeys = [] } of ENDPOINTS) {
    test(`${path}：mock 与真实响应形状一致`, async ({ page, request }) => {
      await mockApi(page);
      await page.goto("/");

      const realResponse = await request.get(path);
      expect(realResponse.status(), `${path}：真实后端应返回 200`).toBe(200);
      const real: unknown = await realResponse.json();
      const mocked = await fetchThroughMock(page, path);

      // 数组端点（/api/resumes、/api/projects、/api/bank/directions）：
      // 顶层键即索引，只断言两侧同为数组
      if (Array.isArray(real) || Array.isArray(mocked)) {
        expect(Array.isArray(real), `${path}：真实后端应返回数组，实际为 ${shapeOf(real)}`).toBe(true);
        expect(Array.isArray(mocked), `${path}：mock 应返回数组，实际为 ${shapeOf(mocked)}`).toBe(true);
        return;
      }

      expect(shapeOf(real), `${path}：真实后端应返回对象，实际为 ${shapeOf(real)}`).toBe("object");
      expect(shapeOf(mocked), `${path}：mock 应返回对象，实际为 ${shapeOf(mocked)}`).toBe("object");

      const realRecord = real as Record<string, unknown>;
      const mockRecord = mocked as Record<string, unknown>;
      const realKeys = sortedKeys(realRecord);
      const mockKeys = sortedKeys(mockRecord);
      const onlyInReal = realKeys.filter((key) => !mockKeys.includes(key));
      const onlyInMock = mockKeys.filter((key) => !realKeys.includes(key));
      expect(onlyInReal, `${path}：仅真实后端存在的顶层键（mock 漂移）`).toEqual([]);
      expect(onlyInMock, `${path}：仅 mock 存在的顶层键（mock 漂移）`).toEqual([]);

      for (const key of realKeys) {
        const realShape = shapeOf(realRecord[key]);
        const mockShape = shapeOf(mockRecord[key]);
        expect(
          realShape,
          `${path}：顶层键 ${key} 类型/可空性漂移（真实=${realShape}，mock=${mockShape}）`
        ).toBe(mockShape);
      }

      for (const key of nestedKeys) {
        expect(shapeOf(realRecord[key]), `${path}：真实后端的嵌套对象 ${key} 应为对象`).toBe("object");
        expect(shapeOf(mockRecord[key]), `${path}：mock 的嵌套对象 ${key} 应为对象`).toBe("object");
        expect(
          sortedKeys(realRecord[key]),
          `${path}：嵌套对象 ${key} 的键集合漂移`
        ).toEqual(sortedKeys(mockRecord[key]));
      }

      if (paginated) {
        for (const [side, payload] of [
          ["真实", realRecord],
          ["mock", mockRecord],
        ] as const) {
          expect(Array.isArray(payload.items), `${path}：${side}的 items 应为数组，实际为 ${shapeOf(payload.items)}`).toBe(true);
          expect(
            payload.nextCursor === null || typeof payload.nextCursor === "string",
            `${path}：${side}的 nextCursor 应为 string | null，实际为 ${shapeOf(payload.nextCursor)}`
          ).toBe(true);
        }
      }
    });
  }
});
