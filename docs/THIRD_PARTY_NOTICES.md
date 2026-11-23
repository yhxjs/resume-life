# 第三方说明

本项目的 MIT 许可只适用于本项目自身代码，不自动改变依赖、字体、模型或系统组件的许可。发布前应以锁文件、依赖包内许可证和实际模型包说明为准。

## 运行时依赖

以下条目于 2026-11-18 按当前锁文件、Windows 安装包元数据和包内许可文件重新核对；不是全部传递依赖的许可清单：

| 依赖 | 已核对版本 | 包内声明 | 许可文件 |
| --- | --- | --- | --- |
| `@fontsource-variable/geist` | `5.3.0` | `OFL-1.1` | `LICENSE` |
| `@fontsource-variable/geist-mono` | `5.3.0` | `OFL-1.1` | `LICENSE` |
| `sharp` | `0.35.5` | `Apache-2.0` | `LICENSE` |
| `@img/sharp-win32-x64` | `0.35.5` | `Apache-2.0 AND LGPL-3.0-or-later` | `LICENSE` |
| `tesseract.js` / `tesseract.js-core` | `5.1.1` | `Apache-2.0` | `LICENSE.md` / `LICENSE` |
| `mammoth` | `1.13.0` | `BSD-2-Clause` | `LICENSE` |
| `pdf-parse` | `2.4.5` | `Apache-2.0` | `LICENSE` |
| `pdfjs-dist` | `5.4.296` | `Apache-2.0` | `LICENSE` |
| `docx` | `9.7.2` | `MIT` | `LICENSE` |
| `@napi-rs/canvas` | `0.1.80` | `MIT` | `LICENSE` |
| `@modelcontextprotocol/server` / `@modelcontextprotocol/core` | `2.4.0` | `Apache-2.0` | `LICENSE` |
| `tsx` | `4.23.15` | `MIT` | `LICENSE` |
| `zod` | `4.6.7` | `MIT` | `LICENSE` |

2026-11-23 补充核对 MCP 相关包：以上三项按安装包元数据和许可文件记录；测试使用的 `@modelcontextprotocol/client@2.4.0` 同样声明 Apache-2.0。MCP SDK 的 LICENSE 说明许可迁移中尚未取得重新许可同意的历史贡献仍受原 MIT 许可约束，分发时须保留完整 LICENSE。

两个字体包的许可文件包含 Geist Project Authors 的版权声明及 SIL Open Font License 1.1 完整文本。字体许可不因主项目采用 MIT 而改变。

Windows 的 Sharp 预编译包包含 libvips 及其他组件，当前 `package.json` 声明 `Apache-2.0 AND LGPL-3.0-or-later`，包级 `LICENSE` 提供 Apache-2.0 文本；仍须保留并核对原生组件各自的许可与通知，不能用 `sharp` 主包的 Apache-2.0 标签替代它们。Linux 和其他平台会解析不同的原生包，应检查对应包的 `package.json` 和 `LICENSE`，不能将本次 Windows 核对当作其他平台已验证。

Next.js、React、TypeScript、Vitest、Playwright 及其余依赖的最终版本以 `package.json` 和 `package-lock.json` 为准。其他传递依赖可能包含 MIT、ISC、Apache-2.0、BSD 或其他许可，不能仅凭包名推断。

## OCR 语言包

`npm run setup:ocr` 获取 `@tesseract.js-data/eng@1.0.0` 和 `@tesseract.js-data/chi_sim@1.0.0` 的 `4.0.0_best_int` 数据文件，并写入本地 OCR 目录。来源、版本、文件大小和 SHA-256 固定在 `scripts/prepare-ocr.mjs` 中：

- `eng.traineddata`：5,199,098 bytes，SHA-256 `5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747`；
- `chi_sim.traineddata`：2,471,033 bytes，SHA-256 `9784f7c917c546424b690fcde708ce1f604a4393d08bb51ddab146d7d7c794e6`。

两个 `@tesseract.js-data` npm 包的 `package.json` 将包级许可标为 MIT，但包内未提供独立的 `LICENSE` 文件。数据上游 [naptha/tessdata 的许可文件](https://github.com/naptha/tessdata/blob/gh-pages/LICENSE) 和 [Tesseract 数据仓库的许可文件](https://github.com/tesseract-ocr/tessdata/blob/main/LICENSE) 均提供 Apache License 2.0 文本。应区分 npm 包元数据和模型数据的上游声明，不能仅依据 npm 的 MIT 标签将下载的模型视为主项目 MIT 代码。

语言包属于独立的数据资产。若另行分发 OCR 模型、字体或原生二进制，应一并核对并保留对应版权、许可和通知文件；本仓库不提交下载的模型。脚本只在用户或 CI 显式执行时联网，运行时 OCR 不会自动下载模型。

## picomatch 开发依赖补丁

当前 picomatch 为 `4.0.7`，包内声明 MIT，原 `LICENSE` 保留。原始源文件及许可来自同名上游包；本项目的安装期改动只涉及 `lib/parse.js` 的无界 wildcard 风险检测，脚本为 `scripts/patch-picomatch.mjs`。这不是上游正式发布的修复版。

- 原始 parser SHA-256：`4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4`。
- 已修补 parser SHA-256：`56ccaed8ecb6614dd22648a01c81f23ee77529cba7a55d1f32c1dbd6fa25c5bb`。
- 公告、行为差异、限时审计政策与替换条件见 [SECURITY.md](../SECURITY.md)。SBOM 继续标识上游 4.0.7；应结合 CI 留存的补丁脚本、政策、哈希与行为证据理解原始审计条目。

## 仓库内的第三方测试样本

`src/lib/__tests__/fixtures/single-paragraph.docx` 与 [Mammoth 上游的同名测试样本](https://github.com/mwilliamson/mammoth.js/blob/master/test/test-data/single-paragraph.docx) 逐字节一致，SHA-256 为 `7d89bf44b4d6940234efb6973d24706c881aa875bb794bfbe54efd92f9c6cf3e`。它只包含一段测试文本，不是真实简历；DOCX 作者元数据是上游作者归属，予以保留。该样本不属于主项目 MIT 代码，原 BSD-2-Clause 通知如下：

```text
Copyright (c) 2013, Michael Williamson
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 核对方式

```bash
npm ci
npm run setup:ocr
npm run audit:dependencies
npm ls --all
```

若依赖或模型来源发生变化，应更新本文件和锁文件对应说明，并重新执行发布检查。
