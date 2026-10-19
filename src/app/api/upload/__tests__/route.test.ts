import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_PREFIX = "resume-life-upload-route-test-";

let dataDirectory = "";
let uploadDirectory = "";
let db: DatabaseSync | undefined;
let POST: (request: Request) => Promise<Response>;

function createMockImageFile(name: string, type: string, buffer: Buffer): File {
  return new File([new Uint8Array(buffer)], name, { type });
}

function multipartRequest(file: File): Request {
  const formData = new FormData();
  formData.append("file", file);
  return new Request("http://localhost/api/upload", { method: "POST", body: formData });
}

beforeEach(async () => {
  dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  uploadDirectory = path.join(dataDirectory, "uploads");
  vi.stubEnv("RESUME_LIFE_DATA_DIR", dataDirectory);
  // DATA_DIR 在模块加载期求值，必须先设好环境变量再导入
  vi.resetModules();
  // 与 route 拿到同一个 db 单例，afterEach 才能关掉句柄
  db = (await import("@/lib/db")).getDb();
  ({ POST } = await import("../route"));
});

afterEach(() => {
  // 上传成功后 route 会顺手清理孤儿文件，因此数据库已被打开；
  // Windows 上删除仍被 SQLite 持有的文件会 EPERM，必须先关句柄。
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  const resolved = path.resolve(dataDirectory);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Unsafe upload directory cleanup target: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("POST /api/upload 头像上传接口", () => {
  it.each([
    ["缺失 boundary", "multipart/form-data", "invalid body"],
    ["错误 Content-Type", "application/json", "{}"],
    ["截断 multipart", "multipart/form-data; boundary=audit", '--audit\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\npartial'],
  ])("%s 返回 400", async (_name, contentType, body) => {
    const response = await POST(new Request("http://localhost/api/upload", {
      method: "POST", headers: { "Content-Type": contentType }, body,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "请求格式无效" });
    expect(fs.existsSync(uploadDirectory) ? fs.readdirSync(uploadDirectory) : []).toEqual([]);
  });

  it("无文件请求返回 400", async () => {
    const formData = new FormData();
    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("请选择需要上传的头像图片");
  });

  it("非法非图片文件被魔数检测拦截返回 400", async () => {
    const fakeBuffer = Buffer.from("this is not an image but a plain text");
    const res = await POST(multipartRequest(createMockImageFile("fake.png", "image/png", fakeBuffer)));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("不支持的图片格式");
  });

  it("合法 PNG 图片上传成功，返回正确的 /api/uploads/ 路径并落在数据目录内", async () => {
    // 必须用真实 PNG 夹具：服务端会经 sharp 降采样，假的魔数字节现在会被正确拒绝
    const pngBuffer = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const res = await POST(multipartRequest(createMockImageFile("avatar.png", "image/png", pngBuffer)));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url: string };
    expect(data.url).toMatch(/^\/api\/uploads\/[a-f0-9-]+\.png$/);

    const written = path.join(uploadDirectory, path.basename(data.url));
    expect(fs.existsSync(written)).toBe(true);
    // 服务端兜底降采样：1200×1600 的输入被压到 ≤600×800，且保持 PNG 格式
    const metadata = await sharp(written).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width ?? 0).toBeLessThanOrEqual(600);
    expect(metadata.height ?? 0).toBeLessThanOrEqual(800);
  });

  it("合法 JPEG 图片上传成功，小图不放大", async () => {
    const jpgBuffer = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 30, g: 200, b: 30 } } }).jpeg().toBuffer();
    const res = await POST(multipartRequest(createMockImageFile("avatar.jpg", "image/jpeg", jpgBuffer)));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url: string };
    expect(data.url).toMatch(/^\/api\/uploads\/[a-f0-9-]+\.jpg$/);
    const metadata = await sharp(path.join(uploadDirectory, path.basename(data.url))).metadata();
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(300);
  });

  it("PNG 魔数但内容损坏时返回 400，而不是落盘坏图", async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 0x5a),
    ]);
    const res = await POST(multipartRequest(createMockImageFile("broken.png", "image/png", corrupt)));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("图片解析失败");
  });

  it("超出 5MB 大小限制返回 413", async () => {
    // 构造 > 5MB 的伪文件
    const largeBlob = new Blob([new Uint8Array(5 * 1024 * 1024 + 100)], { type: "image/png" });
    const formData = new FormData();
    formData.append("file", largeBlob, "large.png");

    const req = new Request("http://localhost/api/upload", {
      method: "POST",
      body: formData,
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("不能超过 5MB");
  });

  it("超过请求体上限时返回 413，而不是被截断后兜成 500", async () => {
    // 请求体被 Next 静默截断、multipart 解析失败，最终报 500「服务器内部错误」。
    const oversized = Buffer.alloc(13 * 1024 * 1024, 0x61);
    const file = createMockImageFile("huge.png", "image/png", oversized);
    const res = await POST(multipartRequest(file));
    expect(res.status).toBe(413);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("请求体过大");
  });
});
