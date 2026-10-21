import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitError, runGit } from "../src/git.js";

describe("git stderr", () => {
  it("keeps stderr for classification and leaves it out of the logged message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mj-git-"));
    const err = await runGit(["status"], { cwd: dir }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(GitError);
    const git = err as GitError;
    expect(git.message).toMatch(/^git status failed \(\d+\)$/);
    expect(git.message).not.toMatch(/fatal|repository|\.ts|function /);
    expect(git.stderr.length).toBeGreaterThan(0);
    expect(git.stderr).not.toBe(git.message);
  });
});
