import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { bundleFiles, filterContext, mergeBundleResults, mergeBundleTriages, shouldBundle } from "../core/bundling.js";
import type { LlmProvider } from "../core/llm/provider.js";
import { runTriage, type LlmTriage, type TriageResult } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const f = (path: string, patch: string | undefined = "@@ -1 +1 @@\n-a\n+b", status = "modified"): PrFile =>
  ({ path, status, additions: 1, deletions: 1, ...(patch === undefined ? {} : { patch }) });
const many = (n: number, mk = (i: number) => `src/m${i}/file${i}.ts`) => Array.from({ length: n }, (_, i) => f(mk(i)));
const big = (n: number) => `@@ -1 +1 @@\n+${"x".repeat(n)}`;
const indexOf = (bundles: PrFile[][], p: string) => bundles.findIndex((b) => b.some((x) => x.path === p));

describe("shouldBundle", () => {
  it("is false for <= 8 small files, true for 9", () => {
    expect(shouldBundle(many(8))).toBe(false);
    expect(shouldBundle(many(9))).toBe(true);
  });
  it("is true for large total patch chars with few files", () => {
    expect(shouldBundle([f("a.ts", big(13_000)), f("b.ts", big(13_000))])).toBe(true);
  });
  it("is false when patches are empty", () => {
    expect(shouldBundle(many(20).map((x) => ({ ...x, patch: "" })))).toBe(false);
    expect(shouldBundle(many(20).map((x) => ({ ...x, patch: undefined })))).toBe(false);
  });
});

describe("bundleFiles", () => {
  it("returns one bundle with all files for a small PR", () => {
    const files = many(3);
    expect(bundleFiles(files)).toEqual([files]);
  });

  it("pairs impl with test/spec/type files across directories", () => {
    const files = [
      f("src/foo.ts"), ...many(7, (i) => `lib/z${i}/x${i}.ts`), f("test/foo.test.ts"), f("pkg/a.py"), f("tests/test_a.py"),
      f("go/b.go"), f("go/b_test.go"), f("types/foo.d.ts"),
    ];
    const bundles = bundleFiles(files, 4);
    expect(indexOf(bundles, "src/foo.ts")).toBe(indexOf(bundles, "test/foo.test.ts"));
    expect(indexOf(bundles, "src/foo.ts")).toBe(indexOf(bundles, "types/foo.d.ts"));
    expect(indexOf(bundles, "pkg/a.py")).toBe(indexOf(bundles, "tests/test_a.py"));
    expect(indexOf(bundles, "go/b.go")).toBe(indexOf(bundles, "go/b_test.go"));
  });

  it("pairs spec files and follows local imports", () => {
    const files = [f("a/util.ts"), ...many(8, (i) => `q${i}/w${i}.ts`), f("b/util.spec.ts"),
      f("c/main.ts", `@@ -1 +1 @@\n+import { h } from "../d/helper";`), f("d/helper.ts")];
    const bundles = bundleFiles(files, 4);
    expect(indexOf(bundles, "a/util.ts")).toBe(indexOf(bundles, "b/util.spec.ts"));
    expect(indexOf(bundles, "c/main.ts")).toBe(indexOf(bundles, "d/helper.ts"));
  });

  it("puts an oversized file alone and keeps bundles within limits", () => {
    const files = [f("a.ts"), f("huge.ts", big(30_000)), ...many(10, (i) => `d${i % 2}/f${i}.ts`)];
    const bundles = bundleFiles(files, 6, 25_000);
    expect(bundles.find((b) => b.some((x) => x.path === "huge.ts"))!.length).toBe(1);
    for (const b of bundles) {
      expect(b.filter((x) => x.patch).length).toBeLessThanOrEqual(6);
      if (b.length > 1) expect(b.reduce((n, x) => n + (x.patch?.length ?? 0), 0)).toBeLessThanOrEqual(25_000);
    }
    expect(bundles.flat().map((x) => x.path).sort()).toEqual(files.map((x) => x.path).sort());
  });

  it("attaches patchless files to the first bundle", () => {
    const files = [...many(10), f("gone.ts", "", "removed"), f("img.png", "")];
    const bundles = bundleFiles(files);
    expect(bundles[0]!.map((x) => x.path)).toEqual(expect.arrayContaining(["gone.ts", "img.png"]));
    expect(bundles.flat()).toHaveLength(files.length);
  });

  it("caps patched files per bundle at 6 and is deterministic", () => {
    const files = many(20, (i) => `same/f${i}.ts`);
    const a = bundleFiles(files);
    expect(a.every((b) => b.length <= 6)).toBe(true);
    expect(bundleFiles(files)).toEqual(a);
  });
});

type L = "auto" | "review" | "block";
const tri = (o: { summary?: string; findings?: LlmTriage["findings"]; rubric?: LlmTriage["rubric"]; files?: [string, L][] }): LlmTriage => ({
  summary: o.summary ?? "", findings: o.findings ?? [], rubric: o.rubric ?? [],
  files: new Map((o.files ?? []).map(([p, lane]) => [p, { lane, reason: "r" }])),
});

describe("mergeBundleTriages", () => {
  it("uses maxLane on collision", () => {
    const m = mergeBundleTriages([tri({ files: [["a", "auto"]] }), tri({ files: [["a", "block"], ["b", "review"]] })]);
    expect(m.files.get("a")!.lane).toBe("block");
    expect(m.files.get("b")!.lane).toBe("review");
  });
  it("dedupes by path:line, orders by lane then line, caps", () => {
    const m = mergeBundleTriages([
      tri({ files: [["a", "auto"], ["b", "block"]], findings: [{ path: "a", line: 1, message: "first" }, { path: "b", line: 9, message: "x" }] }),
      tri({ findings: [{ path: "a", line: 1, message: "dup" }, { path: "b", line: 2, message: "y" }, { path: "a", message: "file-level" }] }),
    ]);
    expect(m.findings.map((x) => x.message)).toEqual(["y", "x", "first", "file-level"]);
    const lots = tri({ findings: Array.from({ length: 30 }, (_, i) => ({ path: "a", line: i + 1, message: "m" })) });
    expect(mergeBundleTriages([lots]).findings).toHaveLength(20);
  });
  it("lets a rubric fail win and caps the summary", () => {
    const r = (verdict: "pass" | "fail") => ({ id: "c1", severity: "review" as never, verdict, justification: verdict });
    const m = mergeBundleTriages([tri({ rubric: [r("pass")], summary: "s".repeat(500) }), tri({ rubric: [r("fail")], summary: "t".repeat(500) })]);
    expect(m.rubric).toHaveLength(1);
    expect(m.rubric[0]!.verdict).toBe("fail");
    expect(m.summary.length).toBe(600);
  });
});

describe("mergeBundleResults", () => {
  const bd = (n: number, extra = {}) => ({ system: n, policy: n, rubric: n, diff: n, output: n, total: n, skipped_diff_files: [`s${n}`], ...extra });
  it("sums tokens, unions skipped, ORs flags", () => {
    const m = mergeBundleResults([
      { llm: tri({}), tokensEstimate: 10, breakdown: bd(1, { context: 2 }), retried: true },
      { llm: null, error: "parse", tokensEstimate: 5, breakdown: bd(2), truncated: true },
    ]);
    expect(m.tokensEstimate).toBe(15);
    expect(m.breakdown).toMatchObject({ system: 3, total: 3, context: 2, skipped_diff_files: ["s1", "s2"] });
    expect(m.retried).toBe(true);
    expect(m.truncated).toBe(true);
    expect(m.llm).not.toBeNull();
  });
  it("keeps an error when every bundle failed", () => {
    const fail: TriageResult = { llm: null, error: "timeout", tokensEstimate: 1, breakdown: bd(1) };
    const m = mergeBundleResults([fail, fail]);
    expect(m.llm).toBeNull();
    expect(m.error).toBe("timeout");
  });
});

describe("filterContext", () => {
  const piece = (path: string, why = "x") => ({ path, kind: "import" as const, why, content: "c", truncated: false });
  it("keeps relevant pieces and falls back to all when nothing matches", () => {
    const ctx = [piece("src/a.ts"), piece("other/z.ts", "caller of b.ts"), piece("far/q.ts")];
    expect(filterContext(ctx, [f("src/b.ts")])!.map((c) => c.path)).toEqual(["src/a.ts", "other/z.ts"]);
    expect(filterContext(ctx, [f("nowhere/n.ts")])).toEqual(ctx);
  });
});

describe("runTriage bundling", () => {
  it("makes several provider calls for a large PR and merges lanes", async () => {
    let calls = 0;
    const files = many(13);
    const p: LlmProvider = {
      label: "t", providerId: "openai",
      complete: async (req) => {
        calls++;
        const paths = files.map((x) => x.path).filter((x) => req.user.includes(x));
        return JSON.stringify({ summary: "ok", files: paths.map((path) => ({ path, lane: "auto", reason: "fine", findings: [] })) });
      },
    };
    const res = await runTriage(p, { title: "t", body: "", files }, parseConfig(""));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(res.llm!.files.size).toBe(13);
  });
});
