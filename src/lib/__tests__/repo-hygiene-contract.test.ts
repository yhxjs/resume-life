import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const gitignoreSource = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");

/** 逐行读取规则，去掉注释与空行，便于精确匹配整条规则而非子串 */
function rules(source: string): string[] {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("版本库卫生契约", () => {
  it("上传目录被忽略：用户真实照片不得进入版本库", () => {
    // 头像文件落在 public/uploads/，库里只存指针；一次 git add -A 就会把
    // 证件照写进提交历史，而 git 历史中的文件极难彻底清除。
    expect(rules(gitignoreSource)).toContain("public/uploads/");
  });

  it("本地工具目录被忽略：截图含真实简历内容", () => {
    const ignored = rules(gitignoreSource);
    expect(ignored).toContain(".impeccable/");
    expect(ignored).toContain(".claude/");
  });

  it("数据目录与运行时日志被忽略", () => {
    const ignored = rules(gitignoreSource);
    expect(ignored).toContain("/data/");
    expect(ignored).toContain("*.log");
  });

  it("离线 OCR 字典不会进入版本库", () => {
    const ignored = rules(gitignoreSource);
    expect(ignored).toContain("*.traineddata");
  });
});
