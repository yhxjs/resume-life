/** 预检识别、源码采集与预算排序共用的工程清单名称。 */
export const REPO_MANIFEST_FILES = [
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "composer.json",
  "Gemfile",
  "CMakeLists.txt",
  "Makefile",
  "solution.sln",
  "tsconfig.json",
] as const;

export const REPO_MANIFEST_NAMES = new Set(REPO_MANIFEST_FILES.map(name => name.toLowerCase()));
export const REPO_MARKERS = [".git", ...REPO_MANIFEST_FILES, "README.md", "readme.md"] as const;
