import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { inspectPicomatchCopies } from "./patch-picomatch.mjs";

/**
 * @typedef {{pattern: string, input: string, expected: boolean, options?: {
 * windows?: boolean, noextglob?: boolean, bash?: boolean, capture?: boolean,
 * dot?: boolean, maxExtglobRecursion?: boolean | number
 * }}} MatchCase
 */
/** @type {MatchCase[]} */
export const SECURITY_CASES = [
  ...["+(*)", "*(*)", "+(*a)", "*(*a)", "+(a*)", "+(@(*a))", "+([ab]*)", "*(*a|b)"].map(pattern => ({
    pattern, input: "a".repeat(64) + "c", expected: false,
  })),
  { pattern: "+(*a)", input: "a".repeat(64) + "c", options: { maxExtglobRecursion: false }, expected: false },
  { pattern: "+(*a)", input: "+(*a)", expected: true },
  { pattern: "+([ab])", input: "a".repeat(2048), expected: true },
  { pattern: "+(a)", input: "aaa", expected: true },
  { pattern: "+(*(a)|*(b))", input: "abba", expected: true },
  { pattern: String.raw`+(\*a)`, input: "*a*a", expected: true },
  { pattern: "+([*]a)", input: "*a*a", expected: true },
  { pattern: "+([[:alpha:]*]a)", input: "*a*a", expected: true },
  { pattern: "+([]*]a)", input: "*a*a", expected: true },
  { pattern: "+([[]a)", input: "[a[a", expected: true },
  { pattern: '+("*a")', input: "*a*a", expected: true },
  { pattern: "src/**/*.{ts,tsx}", input: "src/lib/test.ts", expected: true },
  { pattern: "**/node_modules/**", input: "src/node_modules/a/index.js", expected: true },
  { pattern: "!*.js", input: "test.ts", expected: true },
  { pattern: "!(*.test).ts", input: "index.ts", expected: true },
  { pattern: "file?.[jt]s", input: "file1.js", expected: true },
  { pattern: "@(src|tests)/**", input: "tests/a.ts", expected: true },
];

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const match = createRequire(workerData.packageFile)('./');
parentPort.postMessage({ ready: true });
const results = workerData.cases.map(test => {
  const start = performance.now();
  const actual = match(test.pattern, test.options)(test.input);
  return { ...test, actual, elapsedMs: performance.now() - start };
});
parentPort.postMessage({ results });
`;

// Start-up and matching have separate bounds. Termination prevents a vulnerable
// regular expression from freezing a test runner or a release check.
/**
 * @param {string} packageFile
 * @param {MatchCase[]} cases
 * @returns {Promise<Array<MatchCase & {actual: boolean, elapsedMs: number}>>}
 */
export function runPicomatchCases(packageFile, cases = SECURITY_CASES) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { packageFile, cases } });
    let settled = false;
    let timer = setTimeout(() => finish(new Error("picomatch worker start-up timed out")), 10000);
    function finish(error, results) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(results);
    }
    worker.on("message", message => {
      if (message.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("picomatch matching exceeded the 1500 ms deadline")), 1500);
      } else if (message.results) {
        const failed = message.results.find(result => result.actual !== result.expected);
        finish(failed ? new Error(`picomatch compatibility check failed: ${failed.pattern}`) : null, message.results);
      }
    });
    worker.on("error", error => finish(error));
    worker.on("exit", code => {
      if (!settled) finish(new Error(`picomatch worker exited without results (${code})`));
    });
  });
}

export async function checkPicomatchSecurity(projectRoot) {
  const copies = inspectPicomatchCopies(projectRoot);
  const evidence = [];
  for (const copy of copies) evidence.push({ ...copy, results: await runPicomatchCases(copy.packageFile) });
  return { advisory: "GHSA-fc5q-39xc-vjpf", scope: "reviewed wildcard-in-repeated-extglob regression", copies: evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--root")) throw new Error("Usage: check-picomatch-security.mjs [--root directory]");
    console.log(JSON.stringify(await checkPicomatchSecurity(args[1] ?? process.cwd()), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
