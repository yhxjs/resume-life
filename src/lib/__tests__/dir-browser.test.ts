import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listDirectory, MAX_DIRECTORY_ENTRIES } from "../repo-scanner/dir-browser";

const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-browser-")) {
      throw new Error("Unsafe cleanup path");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("repo-scanner directory browser", () => {
  it("caps entries and reports truncation for very large directories", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    for (let index = 0; index < MAX_DIRECTORY_ENTRIES + 20; index += 1) {
      fs.mkdirSync(path.join(directory, `child-${index}`));
    }
    const result = listDirectory(directory);
    expect(result.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(result.truncated).toBe(true);
  });
});
