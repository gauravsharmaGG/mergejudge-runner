import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { allocatePatchBudgets, buildUserPrompt, chunkPatchAtHunks, numberPatch, SYSTEM_PROMPT } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

describe("allocatePatchBudgets", () => {
  it("gives small files their full length and shares the rest", () => {
    expect(allocatePatchBudgets([10, 1000, 1000], 1010)).toEqual([10, 500, 500]);
  });
  it("handles everything fitting, empty and zero budget", () => {
    expect(allocatePatchBudgets([5, 6], 100)).toEqual([5, 6]);
    expect(allocatePatchBudgets([], 100)).toEqual([]);
    expect(allocatePatchBudgets([50, 50], 0)).toEqual([0, 0]);
  });
});

const hunk = (start: number, n: number) => `@@ -${start},${n} +${start},${n} @@\n` + Array.from({ length: n }, (_, i) => `+line ${start + i}`).join("\n");
const patch3 = [hunk(1, 3), hunk(20, 3), hunk(40, 3)].join("\n");

describe("chunkPatchAtHunks", () => {
  it("returns small patches unchanged", () => expect(chunkPatchAtHunks(patch3, 10_000)).toBe(patch3));
  it("keeps whole hunks and notes omitted ones", () => {
    const out = chunkPatchAtHunks(patch3, hunk(1, 3).length + hunk(20, 3).length + 6);
    expect(out).toContain("@@ -1,3");
    expect(out).toContain("@@ -20,3");
    expect(out).not.toContain("@@ -40,3");
    expect(out).toContain("[... 1 hunk(s) omitted due to token budget ...]");
  });
  it("cuts an oversized first hunk at a newline", () => {
    const out = chunkPatchAtHunks(hunk(1, 200), 300);
    const body = out.slice(0, out.indexOf("\n[... "));
    expect(body.length).toBeLessThanOrEqual(300);
    for (const l of body.split("\n").slice(1)) expect(l).toMatch(/^\+line \d+$/);
    expect(out).toContain("omitted due to token budget");
  });
});

describe("buildUserPrompt water-filling", () => {
  it("keeps a small file whole when a large sibling would starve an equal slice", () => {
    const cfg = parseConfig("budget:\n  max_tokens_per_pr: 3000\n");
    const small: PrFile = { path: "small.ts", status: "modified", additions: 1, deletions: 0, patch: hunk(1, 3) };
    const large: PrFile = { path: "large.ts", status: "modified", additions: 900, deletions: 0, patch: hunk(1, 900) };
    const { prompt } = buildUserPrompt({ title: "t", body: "", files: [small, large] }, cfg);
    expect(prompt).toContain(numberPatch(small.patch!));
    expect(prompt).toContain("omitted due to token budget");
  });
  it("system prompt carries the partial-hunk rule", () => expect(SYSTEM_PROMPT).toContain("partial views"));
});
