import fs from "node:fs";
import path from "node:path";

const directory = path.join(process.cwd(), "public", "uploads");
const count = fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
if (count) {
  console.error(`public/uploads 中仍有 ${count} 项私有上传文件，请从发布集合排除`);
  process.exitCode = 1;
} else {
  console.log("公开资产目录不含私有上传文件");
}
