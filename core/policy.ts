import { minimatch } from "minimatch";
export const DEFAULT_POLICY_FILES = ["REVIEW_POLICY.md", "REVIEW.md", "APPROVAL_POLICY.md", "AGENTS.md", "CLAUDE.md"];
export const POLICY_MAX_EACH = 8 * 1024;
export const POLICY_MAX_TOTAL = 8 * 1024;

export interface PolicyUse { path: string; truncated: boolean }
export interface Policies { text: string; used: PolicyUse[]; /** Listed paths that were missing or empty. */ skipped: string[] }

/** Max-min fair split of `total` over `sizes`: small files get all they need, the rest share what is left evenly. */
export function fairShares(sizes: number[], total: number): number[] {
  const out = sizes.map(() => 0);
  let left = Math.max(0, total);
  let pending = sizes.map((_, i) => i).sort((x, y) => sizes[x]! - sizes[y]!);
  while (pending.length) {
    const share = Math.floor(left / pending.length);
    const i = pending[0]!;
    if (sizes[i]! <= share) { out[i] = sizes[i]!; left -= sizes[i]!; pending = pending.slice(1); continue; }
    for (const j of pending) out[j] = share;
    break;
  }
  return out;
}

/**
 * Load repo policy files (caller must fetch from the base branch, never the PR head).
 * Caps each file and the total, sharing the total fairly so a big file cannot starve later ones.
 * Truncation is noted in the text and in `used`. A fetcher may pre-truncate to `caps.each + 1`
 * chars (that still reads as truncated here); text longer than `caps.each` counts as cut.
 */
export async function loadPolicies(
  paths: string[],
  fetchFile: (path: string) => Promise<string | null>,
  caps = { each: POLICY_MAX_EACH, total: POLICY_MAX_TOTAL },
): Promise<Policies> {
  const found: { path: string; t: string }[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    let t: string | null;
    try { t = await fetchFile(path); } catch { t = null; }
    if (!t || !t.trim()) skipped.push(path);
    else found.push({ path, t });
  }
  const shares = fairShares(found.map((f) => Math.min(f.t.length, caps.each)), caps.total);
  const parts: string[] = [];
  const used: PolicyUse[] = [];
  found.forEach(({ path, t }, i) => {
    const budget = shares[i]!;
    const truncated = t.length > budget;
    parts.push(`--- ${path} ---\n${truncated ? t.slice(0, budget) + "\n[... truncated by MergeJudge ...]" : t}`);
    used.push({ path, truncated });
  });
  return { text: parts.join("\n\n"), used, skipped };
}
export function filterPolicyPaths(paths: string[], exclude: string[]): string[] {
  if (!exclude.length) return paths;
  return paths.filter((p) => !exclude.some((g) => minimatch(p, g, { dot: true })));
}

