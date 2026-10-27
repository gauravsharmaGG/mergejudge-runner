/**
 * Deterministic semantic bundling for large PRs (no LLM). A big diff is split into bundles of related
 * files (impl + test/type pairs, same directory, local imports) so each triage call sees coherent code,
 * then the per-bundle triages are merged back into one result.
 */
import type { ContextPiece } from "./context.js";
import type { RubricResult } from "./rubrics.js";
import { LANE_ORDER, maxLane, type Lane, type PrFile } from "./types.js";
import { MAX_FINDINGS, type Finding, type LlmTriage, type TokenBreakdown, type TriageResult } from "./triage.js";

const MAX_FILES_WITH_PATCH = 8;
const MAX_TOTAL_PATCH_CHARS = 25_000;
const SUMMARY_CAP = 600;

const patchLen = (f: PrFile): number => f.patch?.length ?? 0;
const hasPatch = (f: PrFile): boolean => patchLen(f) > 0;

/** True when the PR is big enough that a single triage call is better split. */
export function shouldBundle(files: readonly PrFile[]): boolean {
  let n = 0, chars = 0;
  for (const f of files) if (hasPatch(f)) { n++; chars += patchLen(f); }
  return n > MAX_FILES_WITH_PATCH || chars > MAX_TOTAL_PATCH_CHARS;
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Basename without extension and without test/spec/type markers. */
function stemOf(path: string): { stem: string; variant: boolean } {
  let b = baseOf(path);
  const dot = b.lastIndexOf(".");
  if (dot > 0) b = b.slice(0, dot);
  let variant = false;
  const strip = (re: RegExp) => { const n = b.replace(re, ""); if (n !== b && n) { b = n; variant = true; } };
  strip(/\.(test|spec)$/i);
  strip(/\.d$/i);
  strip(/^test_/i);
  strip(/_test$/i);
  return { stem: b.toLowerCase(), variant };
}

const IMPORT_RES = [/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g, /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g, /^\+?\s*#include\s+"([^"]+)"/gm];

function resolveRel(dir: string, rel: string): string {
  const out = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

const stripExt = (p: string): string => p.replace(/\.[A-Za-z0-9]+$/, "");

/**
 * Group files into bundles. Small PRs come back as one bundle with every file (unchanged behaviour).
 * Order is stable for the same input order.
 */
export function bundleFiles(files: readonly PrFile[], maxFilesPerBundle = 6, maxPatchCharsPerBundle = 25_000): PrFile[][] {
  if (!shouldBundle(files)) return [Array.from(files)];
  const patched = files.filter(hasPatch);
  const patchless = files.filter((f) => !hasPatch(f));

  // Union-find over indexes of patched files; the smaller index is always the root (first-seen order).
  const parent = patched.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };

  // 1. Stem pairing: only stems that have a test/spec/type variant are joined, so unrelated "index.ts" files stay apart.
  const byStem = new Map<string, { idx: number[]; variant: boolean }>();
  patched.forEach((f, i) => {
    const { stem, variant } = stemOf(f.path);
    const g = byStem.get(stem) ?? { idx: [], variant: false };
    g.idx.push(i);
    g.variant ||= variant;
    byStem.set(stem, g);
  });
  for (const g of byStem.values()) if (g.variant) for (const i of g.idx.slice(1)) union(g.idx[0]!, i);

  // 2a. Local import affinity.
  const byNoExt = new Map<string, number>();
  patched.forEach((f, i) => { const k = stripExt(f.path); if (!byNoExt.has(k)) byNoExt.set(k, i); });
  patched.forEach((f, i) => {
    const dir = dirOf(f.path);
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      for (let m = re.exec(f.patch ?? ""); m; m = re.exec(f.patch ?? "")) {
        const target = resolveRel(dir, m[1]!);
        const hit = byNoExt.get(stripExt(target)) ?? byNoExt.get(`${target}/index`);
        if (hit !== undefined) union(i, hit);
      }
    }
  });

  // 2b. Remaining singletons share a directory.
  const sizes = new Map<number, number>();
  patched.forEach((_, i) => sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1));
  const byDir = new Map<string, number>();
  patched.forEach((f, i) => {
    if (sizes.get(find(i)) !== 1) return;
    const d = dirOf(f.path);
    const first = byDir.get(d);
    if (first === undefined) byDir.set(d, i); else union(first, i);
  });

  // Clusters in first-seen order.
  const clusters = new Map<number, PrFile[]>();
  patched.forEach((f, i) => { const r = find(i); const c = clusters.get(r) ?? []; c.push(f); clusters.set(r, c); });

  // 3. Next-fit packing; an oversized cluster is split in input order.
  const bundles: PrFile[][] = [];
  let cur: PrFile[] = [];
  let curChars = 0;
  const flush = () => { if (cur.length) bundles.push(cur); cur = []; curChars = 0; };
  for (const cluster of [...clusters.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
    const clusterChars = cluster.reduce((n, f) => n + patchLen(f), 0);
    if (cur.length && (cur.length + cluster.length > maxFilesPerBundle || curChars + clusterChars > maxPatchCharsPerBundle)) flush();
    for (const f of cluster) {
      if (cur.length && (cur.length >= maxFilesPerBundle || curChars + patchLen(f) > maxPatchCharsPerBundle)) flush();
      cur.push(f);
      curChars += patchLen(f);
    }
  }
  flush();
  if (patchless.length) bundles[0]!.push(...patchless);
  return bundles;
}

const laneOf = (m: Map<string, { lane: Lane }>, path: string): Lane => m.get(path)?.lane ?? "auto";

const VERDICT_RANK: Record<string, number> = { fail: 3, pass: 2, unverified: 1, "n/a": 0 };
const SEVERITY_RANK: Record<string, number> = { block: 3, high: 3, review: 2, medium: 2, low: 1 };

function mergeRubric(parts: readonly LlmTriage[]): RubricResult[] {
  const byId = new Map<string, RubricResult>();
  for (const r of parts.flatMap((p) => p.rubric)) {
    const prev = byId.get(r.id);
    if (!prev) { byId.set(r.id, r); continue; }
    const a = VERDICT_RANK[r.verdict] ?? 0, b = VERDICT_RANK[prev.verdict] ?? 0;
    if (a > b) byId.set(r.id, r);
    else if (a === b && a > 0 && (SEVERITY_RANK[String(r.severity)] ?? 0) > (SEVERITY_RANK[String(prev.severity)] ?? 0)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/**
 * Merge per-bundle triages. File lanes: max on collision. Findings: first occurrence per path:line wins,
 * ordered by file lane (block > review > auto) then line, capped at MAX_FINDINGS. Rubric: any fail wins.
 */
export function mergeBundleTriages(parts: readonly LlmTriage[], opts: { findingsCap?: number } = {}): LlmTriage {
  const files = new Map<string, { lane: Lane; reason: string }>();
  for (const p of parts) {
    for (const [path, v] of p.files) {
      const prev = files.get(path);
      if (!prev) files.set(path, v);
      else files.set(path, LANE_ORDER[v.lane] > LANE_ORDER[prev.lane] ? { lane: maxLane(prev.lane, v.lane), reason: v.reason } : prev);
    }
  }
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const f of parts.flatMap((p) => p.findings)) {
    const key = `${f.path}:${f.line ?? "file"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }
  const order = new Map(findings.map((f, i) => [f, i]));
  findings.sort((a, b) =>
    LANE_ORDER[laneOf(files, b.path)] - LANE_ORDER[laneOf(files, a.path)]
    || (a.line ?? Infinity) - (b.line ?? Infinity)
    || order.get(a)! - order.get(b)!);
  const summary = parts.map((p) => p.summary.trim()).filter(Boolean).join(" · ").slice(0, SUMMARY_CAP);
  return { summary, files, findings: findings.slice(0, opts.findingsCap ?? MAX_FINDINGS), rubric: mergeRubric(parts) };
}

const sum = (xs: (number | undefined)[]): number => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
const sumOpt = (xs: (number | undefined)[]): number | undefined => (xs.some((x) => x !== undefined) ? sum(xs) : undefined);

/** Merge per-bundle results: merged LLM, summed tokens, unioned skipped files. */
export function mergeBundleResults(results: readonly TriageResult[]): TriageResult {
  const llms = results.map((r) => r.llm).filter((l): l is LlmTriage => l !== null);
  const bs = results.map((r) => r.breakdown);
  const breakdown: TokenBreakdown = {
    system: sum(bs.map((b) => b.system)),
    policy: sum(bs.map((b) => b.policy)),
    rubric: sum(bs.map((b) => b.rubric)),
    diff: sum(bs.map((b) => b.diff)),
    output: sum(bs.map((b) => b.output)),
    total: sum(bs.map((b) => b.total)),
    skipped_diff_files: [...new Set(bs.flatMap((b) => b.skipped_diff_files))],
  };
  for (const k of ["context", "tools", "tool_calls", "second_pass"] as const) {
    const v = sumOpt(bs.map((b) => b[k]));
    if (v !== undefined) breakdown[k] = v;
  }
  const error = llms.length ? undefined : results.find((r) => r.error)?.error;
  const limit = results.find((r) => r.outputLimit !== undefined)?.outputLimit;
  return {
    llm: llms.length ? mergeBundleTriages(llms) : null,
    ...(error ? { error } : {}),
    tokensEstimate: sum(results.map((r) => r.tokensEstimate)),
    breakdown,
    retried: results.some((r) => r.retried),
    ...(results.some((r) => r.truncated) ? { truncated: true } : {}),
    ...(limit !== undefined ? { outputLimit: limit } : {}),
  };
}

/** Context relevant to one bundle: same file, same directory, or mentioning a bundle basename. Falls back to all context. */
export function filterContext(context: ContextPiece[] | undefined, files: readonly PrFile[]): ContextPiece[] | undefined {
  if (!context?.length) return context;
  const paths = new Set(files.map((f) => f.path));
  const dirs = new Set(files.map((f) => dirOf(f.path)));
  const bases = files.map((f) => baseOf(f.path));
  const kept = context.filter((c) => paths.has(c.path) || dirs.has(dirOf(c.path)) || bases.some((b) => c.why.includes(b)));
  return kept.length ? kept : context;
}
