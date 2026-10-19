/* eslint-disable @typescript-eslint/no-require-imports -- Next's plugin requires this CommonJS adapter synchronously. */
const { globSync, isDynamicPattern } = require("tinyglobby");
const picomatch = require("picomatch");
const { statSync } = require("node:fs");
const path = require("node:path");

// Next's sole fast-glob call uses globSync to find root directories.
// Keep explicit directories unexpanded, as in the upstream tinyglobby migration:
// https://github.com/vercel/next.js/pull/89531
exports.globSync = (pattern, options) => {
  pattern = pattern.replace(/(?!^)\/{2,}/g, "/");
  if (!isDynamicPattern(pattern)) {
    return statSync(pattern, { throwIfNoEntry: false })?.isDirectory() ? [pattern] : [];
  }
  let patterns = [pattern];
  const recursiveSuffix = /(?:\/\*\*)+\/?$/;
  if (recursiveSuffix.test(pattern)) {
    const prefix = pattern.replace(recursiveSuffix, "");
    patterns = [`${prefix}/**/*`];
    if (picomatch.scan(prefix, { tokens: true }).tokens.some((token) => token.isGlob && !token.isBrace)) {
      patterns.push(prefix);
    }
  }
  const directories = globSync(patterns, {
    ...options,
    expandDirectories: false,
    absolute: path.isAbsolute(pattern),
  });
  const scanned = picomatch.scan(pattern);
  const matchPattern = scanned.base && scanned.glob
    ? `${path.posix.normalize(scanned.base).replace(/\/$/, "")}/${scanned.glob}`
    : pattern;
  const matches = picomatch.makeRe(matchPattern.replace(/^\.\//, ""), { posix: true, strictSlashes: false });
  const results = directories.map((directory) => {
    const result = directory === path.parse(directory).root ? directory : directory.replace(/\/$/, "");
    return pattern.startsWith("./") && !result.startsWith("./") ? `./${result}` : result;
  }).filter((directory) => matches.test(directory.replace(/^\.\//, "")) || matches.test(`${directory.replace(/^\.\//, "")}/`));
  if (scanned.isBrace && !recursiveSuffix.test(pattern)) {
    const base = path.posix.normalize(scanned.base);
    const candidate = base.endsWith("/") ? base : `${base}/`;
    if (matches.test(candidate) && statSync(base, { throwIfNoEntry: false })?.isDirectory()) {
      results.push(pattern.startsWith("./") ? `./${candidate}` : candidate);
    }
  }
  return [...new Set(results)];
};
