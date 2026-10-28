import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const round1 = (n: number) => Math.round(n * 1000) / 10;

describe("Martian 50-PR summary", () => {
  const doc = JSON.parse(read("benchmark/martian-50pr-summary.json"));

  it("records v0.6.1, the judge model, both modes, and the five languages", () => {
    expect(doc.version).toBe("0.6.1");
    expect(doc.model).toBe("claude-sonnet-4-20250514");
    expect(doc.modes.default.tp).toBe(45);
    expect(doc.modes.default.fp).toBe(15);
    expect(doc.modes.default.fn).toBe(113);
    expect(doc.modes.deep.tp).toBe(60);
    expect(doc.modes.deep.fp).toBe(19);
    expect(doc.modes.deep.fn).toBe(98);
    expect(doc.benchmark.languages.map((row: { language: string }) => row.language)).toEqual([
      "Python", "Go", "TypeScript", "Ruby", "Java",
    ]);
    expect(doc.benchmark.languages.reduce((n: number, row: { pull_requests: number }) => n + row.pull_requests, 0)).toBe(50);
    expect(doc.benchmark.golden_comments_core).toBe(158);
  });

  it("uses counts that reproduce the published precision, recall, and F1", () => {
    for (const [name, pct] of [
      ["default", [75.0, 28.5, 41.3]],
      ["deep", [75.9, 38.0, 50.6]],
    ] as const) {
      const mode = doc.modes[name];
      const { tp, fp, fn } = mode;
      expect(round1(tp / (tp + fp))).toBe(pct[0]);
      expect(round1(tp / (tp + fn))).toBe(pct[1]);
      expect(round1((2 * tp) / (2 * tp + fp + fn))).toBe(pct[2]);
      expect(round1(mode.precision)).toBe(pct[0]);
      expect(round1(mode.recall)).toBe(pct[1]);
      expect(round1(mode.f1)).toBe(pct[2]);
      expect(tp + fn).toBe(158);
    }
  });
});

describe("docs copy", () => {
  const files = [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "benchmark/README.md",
    "benchmark/martian-50pr-summary.json",
    "benchmark/reproduce.sh",
  ];

  it("has no em dashes or en dashes in the docs this change owns", () => {
    for (const path of files) {
      expect(read(path), path).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it("opens the README on the recommendation and keeps the bench section strings", () => {
    const readme = read("README.md");
    expect(readme.startsWith("# MergeJudge: Open-Source AI Code Review for GitHub\n")).toBe(true);
    expect(readme).toContain("Risk-aware AI pull request reviews, with deterministic rules and merge gates you control.");
    expect(readme).toContain("low risk, not a guarantee");
    expect(readme).not.toContain("safe to merge");
    expect(readme).not.toContain("no code leaves your machine");
    const start = readme.indexOf("## Martian Code-Review-Bench");
    const end = readme.indexOf("## Quiet by default");
    const section = readme.slice(start, end);
    expect(section).toContain("75.9%");
    expect(section).toContain("60");
    expect(section).toContain("98");
    expect(section).not.toMatch(/[\u2014\u2013\u2192]/);
  });
});
