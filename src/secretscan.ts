/**
 * Deep-local secret scan (runner 0.4.2+): the Worker only sees GitHub's patches, which are missing or cut for large, excluded or
 * generated files. With a clone at the job head the runner computes the real diff and runs the SAME shared scan (src/rules.ts
 * scanSecrets, placeholder skips included) over it. A hit raises the file and the PR to block; a runner can only raise.
 */
import { explainLane } from "../core/aggregate.js";
import { lineFindingsOf, renderComment } from "../core/render.js";
import { scanSecrets } from "../core/rules.js";
import type { ReviewResult } from "../core/review.js";
import { RUNNER_SECRET_PREFIX } from "../core/engines.js";
import { runGit, splitPatches } from "./git.js";

export const SCAN_LIMITS = {
  /** Files scanned per job. */
  maxFiles: 2000,
  /** Bytes of one file's diff that are scanned (the rest is skipped). */
  maxBytesPerFile: 1_000_000,
  /** Output cap of the single whole-PR diff; over it the scan falls back to one diff per file. */
  maxDiffBytes: 48 * 1024 * 1024,
  /** Output cap of one per-file diff in the fallback. */
  maxFileDiffBytes: 4 * 1024 * 1024,
  /** Wall-clock budget for the whole scan. */
  maxMs: 90_000,
};

export interface SecretScanResult {
  /** path -> names of the secret patterns found (never the values). */
  hits: Map<string, string[]>;
  /** Why the scan did not run or was partial; for the log. */
  skipped?: string;
  scanned: number;
}

type Env = Record<string, string | undefined>;

/** Added-line scan of every changed file of baseSha...headSha in the clone at `dir`. Never throws on git trouble. */
export async function scanLocalDiff(
  dir: string, baseSha: string, headSha: string, expectedHeadSha: string, env: Env, log: (m: string) => void, signal?: AbortSignal,
  limits = SCAN_LIMITS,
): Promise<SecretScanResult> {
  const none = (why: string): SecretScanResult => { log(`local secret scan skipped: ${why}`); return { hits: new Map(), skipped: why, scanned: 0 }; };
  const t0 = Date.now();
  const g = { cwd: dir, env, signal };
  try {
    const resolved = (await runGit(["rev-parse", "--verify", "--quiet", `${headSha}^{commit}`], { ...g, allowFail: true })).stdout.trim();
    if (!resolved || resolved !== expectedHeadSha) return none("local head does not match the job head");
    const range = `${baseSha}...${headSha}`;
    const num = await runGit(["diff", "-M", "--numstat", "-z", range], g);
    const text = new Set<string>();
    const parts = num.stdout.split("\0");
    for (let i = 0; i < parts.length;) {
      const head = parts[i++];
      if (!head) continue;
      const [a, , p] = head.split("\t");
      let path = p ?? "";
      if (path === "") { i++; path = parts[i++] ?? ""; }
      if (a !== "-" && path) text.add(path); // "-" = binary
    }
    let paths = [...text];
    let note: string | undefined;
    if (paths.length > limits.maxFiles) { paths = paths.slice(0, limits.maxFiles); note = `only the first ${limits.maxFiles} files were scanned`; }

    const patches = new Map<string, string>();
    let all: Map<string, string> | null = null;
    try {
      all = splitPatches((await runGit(["diff", "-M", "-U0", "--no-color", "--no-ext-diff", range], { ...g, maxBytes: limits.maxDiffBytes })).stdout);
    } catch (e) {
      if (signal?.aborted) throw e;
      all = null; // too big (or one odd path): per-file below
    }
    if (all) for (const p of paths) { const x = all.get(p); if (x !== undefined) patches.set(p, x); }
    else {
      for (const p of paths) {
        if (signal?.aborted || Date.now() - t0 > limits.maxMs) { note = "time budget reached; remaining files were not scanned"; break; }
        try {
          const out = (await runGit(["diff", "-U0", "--no-color", "--no-ext-diff", range, "--", `:(literal)${p}`], { ...g, maxBytes: limits.maxFileDiffBytes })).stdout;
          patches.set(p, out.slice(out.indexOf("\n@@ ") + 1));
        } catch (e) { if (signal?.aborted) throw e; note = "some files were too large to scan"; }
      }
    }
    const hits = new Map<string, string[]>();
    for (const [path, patch] of patches) {
      const found = scanSecrets(patch.length > limits.maxBytesPerFile ? patch.slice(0, limits.maxBytesPerFile) : patch, path).blocked;
      if (found.length) hits.set(path, found);
      if (patch.length > limits.maxBytesPerFile) note = note ?? `files over ${limits.maxBytesPerFile} bytes were scanned only in part`;
    }
    if (note) log(`local secret scan partial: ${note}`);
    return { hits, scanned: patches.size, ...(note ? { skipped: note } : {}) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return none(`git error (${(e as Error).message.slice(0, 120)})`);
  }
}

const SCAN_NOTE = "The runner's scan of the full local diff found a possible secret in files GitHub's patch did not show; those files are blocked.";

/**
 * Raises files with hits (and the PR) to block, in place, and re-renders the comment body (keeping the original notes and adding the scan note). Files whose rules verdict already
 * blocks on the same finding are left alone. Returns the number of files raised.
 */
export function applyRunnerSecretHits(result: ReviewResult, hits: Map<string, string[]>, ctx: { policyFiles?: { path: string; truncated: boolean }[]; notes?: string[]; approval?: { enabled?: boolean; mode?: string } | null; laneMap?: boolean; prUrl?: string } = {}): number {
  let raised = 0;
  const agg = result.agg;
  for (const [path, names] of hits) {
    const reason = `${RUNNER_SECRET_PREFIX}${names.join(", ")}`;
    const v = agg.files.find((f) => f.path === path);
    if (v) {
      if (v.lane === "block" && v.reasons.some((r) => r.startsWith("possible secret in added lines"))) continue;
      v.lane = "block";
      v.reasons = [...v.reasons, reason].slice(-50);
      delete v.codeAuto;
      delete v.autoCandidate;
    } else agg.files.push({ path, lane: "block", reasons: [reason], source: "rule" });
    raised++;
  }
  if (!raised) return 0;
  agg.lane = "block";
  result.lane = "block";
  result.usage.lane = "block";
  agg.explanation = explainLane(agg);
  result.body = renderComment({
    story: result.story, storyStyle: result.storyStyle, storyAnimate: result.storyAnimate, storyImageUrl: result.storyImageUrl,
    ...(result.whereItSits ? { whereItSits: result.whereItSits } : {}),
    agg, mode: result.usage.model ?? "runner", tokensEstimate: result.usage.tokens,
    notes: [...(ctx.notes ?? []), SCAN_NOTE],
    policyFiles: ctx.policyFiles, fileFindings: result.findings.filter((f) => f.line === undefined),
    breakdown: result.usage.breakdown ?? undefined, approval: ctx.approval,
    laneMap: ctx.laneMap, prUrl: ctx.prUrl, lineFindings: lineFindingsOf(result.findings),
  });
  return raised;
}
