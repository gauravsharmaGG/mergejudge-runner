import { minimatch } from "minimatch";
import type { Lane } from "../../core/types.js";

/**
 * Which pull requests get proof tests. Reuses what the review already decided: the PR lane (`block` is the red lane) and
 * the paths REVIEW.md marks sensitive. A PR in neither group is never touched.
 *
 * REVIEW.md convention (new, optional): a heading containing "sensitive" (for example `## Sensitive paths`), followed by
 * bullets whose globs are in backticks:
 *
 *     ## Sensitive paths
 *     - `src/auth/**`
 *     - `billing/`
 */

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const MAX_GLOBS = 50;

const isReviewMd = (path: string) => /(^|\/)review\.md$/i.test(path);

/** Globs from the "sensitive" section(s) of a REVIEW.md text. A trailing slash means the whole directory. */
export function parseSensitivePaths(text: string): string[] {
  const out: string[] = [];
  let inSection = false;
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = HEADING_RE.exec(line);
    if (h) { inSection = /\bsensitive\b/i.test(h[1]!); continue; }
    if (!inSection || !/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      let g = m[1]!.trim().replace(/^\.\//, "");
      if (!g || g.startsWith("/") || g.startsWith("!") || g.includes("..")) continue;
      if (g.endsWith("/")) g += "**";
      out.push(g);
      if (out.length >= MAX_GLOBS) return out;
    }
  }
  return out;
}

/** Sensitive globs from the policy files the review already read (the base commit's REVIEW.md); other policy files are not scanned. */
export function sensitiveFromPolicyFiles(policyFiles: Record<string, string>): string[] {
  return Object.entries(policyFiles).filter(([p]) => isReviewMd(p)).flatMap(([, t]) => parseSensitivePaths(t)).slice(0, MAX_GLOBS);
}

export interface GateInput {
  lane: Lane;
  /** Every path the PR touches (previous paths of renames included). */
  paths: string[];
  sensitive: string[];
}

export type GateDecision = { run: true; reason: string; sensitivePaths: string[] } | { run: false; reason: string };

export function proofGate(i: GateInput): GateDecision {
  const hits = i.paths.filter((p) => i.sensitive.some((g) => minimatch(p, g, { dot: true })));
  if (i.lane === "block") return { run: true, reason: "red lane (block)", sensitivePaths: [...new Set(hits)] };
  if (hits.length) return { run: true, reason: `touches sensitive paths from REVIEW.md (${[...new Set(hits)].slice(0, 3).join(", ")})`, sensitivePaths: [...new Set(hits)] };
  return { run: false, reason: `lane ${i.lane} and no REVIEW.md sensitive paths touched` };
}
