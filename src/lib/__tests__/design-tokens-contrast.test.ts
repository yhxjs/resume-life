import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = path.join(process.cwd(), "src", "app", "globals.css");

type Oklch = readonly [number, number, number];

/** 从 CSS 块中提取 `--name: oklch(L C H)` 形式的令牌 */
function parseTokens(block: string): Map<string, Oklch> {
  const tokens = new Map<string, Oklch>();
  const re = /--([a-z0-9-]+)\s*:\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block)) !== null) {
    tokens.set(match[1]!, [Number(match[2]), Number(match[3]), Number(match[4])]);
  }
  return tokens;
}

/** OKLCH -> 线性 sRGB -> WCAG 相对亮度 */
function luminance([L, C, hDeg]: Oklch): number {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return (
    0.2126 * (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
    0.7152 * (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
    0.0722 * (-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

function contrast(fg: Oklch, bg: Oklch): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 会被当作文本使用的令牌，及其可能落在的背景令牌 */
const TEXT_ON_BACKGROUND: ReadonlyArray<readonly [string, string]> = [
  ...["ink", "muted", "faint", "primary", "accent", "danger"].flatMap((text) =>
    ["bg", "card", "surface", "surface-2"].map((background) => [text, background] as const)
  ),
  ["primary", "primary-soft"],
  ["accent", "accent-wash"],
  ["danger", "danger-wash"],
  ["on-primary", "primary"],
  ["on-danger", "danger"],
  ["chrome-ink", "chrome"],
  ["chrome-muted", "chrome"],
];

const AA_NORMAL_TEXT = 4.5;

describe("设计令牌对比度（WCAG AA）", () => {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const darkIndex = css.indexOf("@media (prefers-color-scheme: dark)");
  const themes = [
    { name: "亮色", tokens: parseTokens(css.slice(0, darkIndex)) },
    { name: "暗色", tokens: parseTokens(css.slice(darkIndex)) },
  ];

  it("globals.css 能被解析出明暗两套令牌", () => {
    for (const { name, tokens } of themes) {
      expect(tokens.size, `${name}主题令牌数量异常`).toBeGreaterThan(20);
    }
  });

  for (const { name, tokens } of themes) {
    for (const [textToken, backgroundToken] of TEXT_ON_BACKGROUND) {
      it(`${name}主题 ${textToken} 在 ${backgroundToken} 上达到 ${AA_NORMAL_TEXT}:1`, () => {
        const fg = tokens.get(textToken);
        const bg = tokens.get(backgroundToken);
        expect(fg, `缺少令牌 --${textToken}`).toBeDefined();
        expect(bg, `缺少令牌 --${backgroundToken}`).toBeDefined();
        const ratio = contrast(fg as Oklch, bg as Oklch);
        expect(
          ratio,
          `--${textToken} 在 --${backgroundToken} 上仅 ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }
});
