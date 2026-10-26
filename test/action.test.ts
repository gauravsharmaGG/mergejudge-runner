import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..");

describe("GitHub Action", () => {
  const manifest = parse(readFileSync(join(root, "action.yml"), "utf8")) as { runs: { using: string; main: string } };

  it("action.yml runs on node24 and its main file exists", () => {
    expect(manifest.runs.using).toBe("node24");
    expect(existsSync(join(root, manifest.runs.main))).toBe(true);
  });

  it("action.yml exposes review_mode for the fast or deep second pass", () => {
    const text = readFileSync(join(root, "action.yml"), "utf8");
    expect(text).toContain("review_mode:");
    expect(text).toContain("MERGEJUDGE_MODE");
    expect(text).toContain("INPUT_REVIEW_MODE");
    expect(text).not.toMatch(/[—–→]/);
  });

  it("the committed bundle matches a fresh build (run `npm run build:action` and commit action/)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mj-action-"));
    try {
      const out = join(dir, "index.cjs");
      // Later flags win, so this is the exact `build:action` command writing to a temp file.
      execFileSync("npm", ["run", "--silent", "build:action", "--", `--outfile=${out}`], { cwd: root, stdio: "pipe" });
      const fresh = readFileSync(out, "utf8");
      const committed = readFileSync(join(root, manifest.runs.main), "utf8");
      expect(fresh === committed, "action/index.cjs is stale: run `npm run build:action` and commit the result").toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
