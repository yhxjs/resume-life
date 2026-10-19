// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getProjectRepoPathsStorageKey,
  loadStoredRepoPaths,
  saveStoredRepoPaths,
} from "../use-project-repo-paths";

function useDocument(generation: string | null) {
  const next = document.implementation.createHTMLDocument();
  if (generation !== null) {
    const meta = next.createElement("meta");
    meta.name = "resume-life-data-generation";
    meta.content = generation;
    next.head.append(meta);
  }
  vi.stubGlobal("document", next);
}
afterEach(() => vi.unstubAllGlobals());

describe("use-project-repo-paths storage utilities", () => {
  beforeEach(() => {
    localStorage.clear();
    useDocument("initial");
  });

  it("正确生成隔离的项目存储键", () => {
    expect(getProjectRepoPathsStorageKey(1)).toBe("resume_life_project_repo_paths_initial:1");
    expect(getProjectRepoPathsStorageKey("abc")).toBe("resume_life_project_repo_paths_initial:abc");
  });

  it("恢复后同 ID 项目不加载旧世代或未绑定世代的路径", () => {
    localStorage.setItem("resume_life_project_repo_paths_1", '["C:/synthetic/legacy"]');
    expect(loadStoredRepoPaths(1)).toEqual([]);
    saveStoredRepoPaths(1, ["C:/synthetic/old"]);
    useDocument("restored");
    expect(loadStoredRepoPaths(1)).toEqual([]);
    saveStoredRepoPaths(1, ["C:/synthetic/new"]);
    expect(loadStoredRepoPaths(1)).toEqual(["C:/synthetic/new"]);
    useDocument("initial");
    expect(loadStoredRepoPaths(1)).toEqual(["C:/synthetic/old"]);
  });

  it("文档世代缺失时不读取或持久化路径", () => {
    useDocument(null);
    saveStoredRepoPaths(1, ["C:/synthetic/unbound"]);
    expect(loadStoredRepoPaths(1)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it("旧文档不因后台更新 meta 而把旧路径写入新世代", () => {
    saveStoredRepoPaths(1, ["C:/synthetic/old"]);
    document.querySelector<HTMLMetaElement>("meta")!.content = "restored";
    saveStoredRepoPaths(1, ["C:/synthetic/still-old"]);
    useDocument("restored");
    expect(loadStoredRepoPaths(1)).toEqual([]);
  });

  it("在没有任何数据时返回空数组", () => {
    expect(loadStoredRepoPaths(1)).toEqual([]);
  });

  it("正确保存与读取路径列表，并自动 trim 和去重", () => {
    const paths = [" D:\\projects\\app-frontend  ", "D:\\projects\\app-backend", "D:\\projects\\app-frontend"];
    saveStoredRepoPaths(1, paths);

    const loaded = loadStoredRepoPaths(1);
    expect(loaded).toEqual(["D:\\projects\\app-frontend", "D:\\projects\\app-backend"]);
  });

  it("不同项目之间的路径记录相互隔离", () => {
    saveStoredRepoPaths(1, ["D:\\project1"]);
    saveStoredRepoPaths(2, ["D:\\project2"]);

    expect(loadStoredRepoPaths(1)).toEqual(["D:\\project1"]);
    expect(loadStoredRepoPaths(2)).toEqual(["D:\\project2"]);
  });

  it("保存空数组时自动清除 localStorage 键", () => {
    saveStoredRepoPaths(1, ["D:\\project1"]);
    expect(loadStoredRepoPaths(1).length).toBe(1);

    saveStoredRepoPaths(1, []);
    expect(loadStoredRepoPaths(1)).toEqual([]);
    expect(localStorage.getItem(getProjectRepoPathsStorageKey(1)!)).toBeNull();
  });

  it("损坏或异常的 JSON 数据优雅降级为空数组", () => {
    localStorage.setItem(getProjectRepoPathsStorageKey(1)!, "{not-valid-json");
    expect(loadStoredRepoPaths(1)).toEqual([]);

    localStorage.setItem(getProjectRepoPathsStorageKey(1)!, JSON.stringify({ not: "an array" }));
    expect(loadStoredRepoPaths(1)).toEqual([]);
  });
});
