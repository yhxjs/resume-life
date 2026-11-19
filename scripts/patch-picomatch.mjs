import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// GHSA-fc5q-39xc-vjpf: upstream 4.0.7 misses an unbounded wildcard
// inside a repeated extglob. Use its existing risky-pattern literal fallback.
// Keep the package name, version and license intact. Unknown sources fail closed.
export const PICOMATCH_VERSION = "4.0.7";
export const UPSTREAM_SHA256 = "4e1e05447668aa1e94366c5516a2bcd8f5fff800cc92b1d0cd7d77703b8618c4";
export const PATCHED_SHA256 = "56ccaed8ecb6614dd22648a01c81f23ee77529cba7a55d1f32c1dbd6fa25c5bb";
export const PATCH_HELPER = String.raw`// resume-life: GHSA-fc5q-39xc-vjpf wildcard guard
const hasUnboundedWildcard = body => {
  let escaped = false;
  let quoted = false;
  let bracket = 0;
  let bracketStart = -1;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (bracket > 0) {
      // POSIX classes may nest inside a bracket; an initial ] is literal.
      if (ch === '[' && body[i + 1] === ':') bracket++;
      if (ch === ']' && i !== bracketStart + 1 &&
          !(i === bracketStart + 2 && /[!^]/.test(body[bracketStart + 1]))) bracket--;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === '[') {
      bracket++;
      bracketStart = i;
      continue;
    }
    // *(...) is an extglob, handled by upstream's recursion/flattening logic.
    if (ch === '*' && body[i + 1] !== '(') return true;
  }
  return false;
};

`;
export const PATCH_GUARD = `  if (hasUnboundedWildcard(body)) {
    return { risky: true };
  }

`;
const ANCHOR = "const analyzeRepeatedExtglob = (body, options) => {\n";

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function createPatchedSource(source) {
  if (sha256(source) === PATCHED_SHA256) return source;
  if (sha256(source) !== UPSTREAM_SHA256) {
    throw new Error("picomatch source hash differs from the reviewed upstream file");
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const anchor = ANCHOR.replaceAll("\n", newline);
  if (source.split(anchor).length !== 2) throw new Error("picomatch patch anchor is not unique");
  return source.replace(anchor, (PATCH_HELPER + ANCHOR + PATCH_GUARD).replaceAll("\n", newline));
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Cover both lockfile locations and the paths actually resolved by consumers.
// Old, unreachable package-manager cache entries are not installed dependencies.
export function locatePicomatchCopies(projectRoot, { omitDev = false } = {}) {
  const root = fs.realpathSync(projectRoot);
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (!lock.packages || lock.lockfileVersion !== 3) throw new Error("Expected an npm v3 lockfile");
  const copies = new Map();
  const add = (packageFile, consumer) => {
    const actualFile = fs.realpathSync(packageFile);
    if (!inside(root, actualFile)) throw new Error("picomatch resolves outside the project");
    const metadata = JSON.parse(fs.readFileSync(actualFile, "utf8"));
    if (metadata.name !== "picomatch" || metadata.version !== PICOMATCH_VERSION) {
      throw new Error(`Unreviewed picomatch version: ${metadata.version}`);
    }
    const parseFile = fs.realpathSync(path.join(path.dirname(actualFile), "lib/parse.js"));
    if (!inside(root, parseFile)) throw new Error("picomatch parser resolves outside the project");
    const copy = copies.get(parseFile) ?? {
      packageFile: actualFile, parseFile, version: metadata.version, consumers: [],
    };
    copy.consumers.push(consumer);
    copies.set(parseFile, copy);
  };
  const packages = Object.entries(lock.packages);
  // A local dependency's source directory can exist even when npm omitted its link.
  const installedLinkTargets = new Set(packages.filter(([location, metadata]) =>
    metadata.link && fs.existsSync(path.join(root, location, "package.json")),
  ).map(([, metadata]) => metadata.resolved));
  for (const [location, metadata] of packages) {
    const absolute = path.resolve(root, location);
    if (!inside(root, absolute)) throw new Error("Lockfile location escapes the project");
    if (/(?:^|\/)node_modules\/picomatch$/.test(location)) {
      if (metadata.version !== PICOMATCH_VERSION) throw new Error("Unreviewed picomatch lockfile version");
      if (omitDev && metadata.dev && !fs.lstatSync(absolute, { throwIfNoEntry: false })) continue;
      add(path.join(absolute, "package.json"), `lock:${location}`);
    }
    if (metadata.dependencies?.picomatch || metadata.optionalDependencies?.picomatch) {
      const parentFile = path.join(absolute, "package.json");
      if (omitDev && metadata.dev) {
        if (!fs.lstatSync(absolute, { throwIfNoEntry: false })) continue;
        if (location && !location.startsWith("node_modules/") && !installedLinkTargets.has(location)) continue;
      }
      // Platform-specific optional parents may not be installed.
      if (!fs.existsSync(parentFile) && metadata.optional) continue;
      if (!fs.existsSync(parentFile)) throw new Error(`Missing picomatch consumer: ${location}`);
      const parentRequire = createRequire(parentFile);
      add(parentRequire.resolve("picomatch/package.json"), `resolve:${location || "."}`);
    }
  }
  if (!omitDev || fs.lstatSync(path.join(root, "node_modules/picomatch"), { throwIfNoEntry: false })) {
    const projectRequire = createRequire(path.join(root, "package.json"));
    add(projectRequire.resolve("picomatch/package.json"), "resolve:project");
  }
  return [...copies.values()];
}

export function inspectPicomatchCopies(projectRoot, options = {}) {
  return locatePicomatchCopies(projectRoot, options).map(copy => {
    const hash = sha256(fs.readFileSync(copy.parseFile));
    if (hash !== PATCHED_SHA256) throw new Error(`Unpatched or changed picomatch parser: ${copy.parseFile}`);
    return { ...copy, sha256: hash };
  });
}

export function patchPicomatch(projectRoot, options = {}) {
  // Validate every target before writing any target.
  const targets = locatePicomatchCopies(projectRoot, options).map(copy => {
    const source = fs.readFileSync(copy.parseFile, "utf8");
    const patched = createPatchedSource(source);
    if (sha256(patched) !== PATCHED_SHA256) throw new Error("Generated picomatch patch hash mismatch");
    return { ...copy, source, patched };
  });
  for (const target of targets) {
    if (target.source !== target.patched) fs.writeFileSync(target.parseFile, target.patched);
  }
  return inspectPicomatchCopies(projectRoot, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--root")) throw new Error("Usage: patch-picomatch.mjs [--root directory]");
    const includes = (process.env.npm_config_include ?? "").split(/[\s,]+/);
    const omits = (process.env.npm_config_omit ?? (process.env.NODE_ENV === "production" ? "dev" : "")).split(/[\s,]+/);
    const omitDev = process.env.npm_lifecycle_event === "postinstall" && omits.includes("dev") && !includes.includes("dev");
    const copies = patchPicomatch(args[1] ?? process.cwd(), { omitDev });
    console.log(JSON.stringify({ advisory: "GHSA-fc5q-39xc-vjpf", copies }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
