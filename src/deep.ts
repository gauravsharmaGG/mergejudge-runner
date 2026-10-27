/**
 * AI review depth: `fast` (one pass, the default) or `deep` (a second pass).
 * Separate from `review.mode` (diff | context | deep), which chooses how much surrounding code is attached.
 * Second-pass findings are kept only when `verifyFindingEvidence` matches `quote` to that file's diff.
 * Deterministic base-branch rules stay the floor. auto means low risk, not a guarantee.
 */
import type { Config } from "../core/config.js";
import { quoteInPatch, relocateQuoteAcrossFiles, resolveLineFromQuote } from "../core/rubrics.js";
import { diffLines, type Finding } from "../core/triage.js";
import type { PrFile } from "../core/types.js";
import { ConfigError } from "./config.js";

export const REVIEW_MODES = ["fast", "deep"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** `deep` only when the config (or a job payload) says so. Anything else, including a missing `ai` block, is fast. */
export function aiModeOf(cfg: { ai?: { mode?: string | null } | null } | null | undefined): ReviewMode {
  return cfg?.ai?.mode === "deep" ? "deep" : "fast";
}

/** Copy `mode` onto a config. A missing `ai` block (older job payloads) is filled in. */
export function withAiMode<T extends { ai?: { mode?: ReviewMode | string | null } | null }>(cfg: T, mode: ReviewMode): T {
  if (cfg.ai?.mode === mode) return cfg;
  return { ...cfg, ai: { ...(cfg.ai ?? {}), mode } };
}

export function parseReviewMode(raw: string | undefined | null, label = "review mode"): ReviewMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "fast" || v === "deep") return v;
  throw new ConfigError(`${label} must be fast or deep (got ${JSON.stringify(raw.trim().slice(0, 40))})`);
}

export interface ReviewModeSources {
  /** CLI `--mode`. */
  flag?: string | null;
  /** CLI `--deep` (same as `--mode deep`). */
  deepFlag?: boolean;
  /** Action input `review_mode`. GitHub Actions also exposes this as `INPUT_REVIEW_MODE`. */
  reviewMode?: string | null;
  /** Read for `MERGEJUDGE_MODE` and, when the input above is empty, `INPUT_REVIEW_MODE`. */
  env?: Record<string, string | undefined>;
}

/**
 * An explicit override, or undefined to keep `ai.mode` from `.mergejudge.yml` (default fast).
 * Precedence: `--deep` / `--mode`, then `review_mode`, then `MERGEJUDGE_MODE`, then `INPUT_REVIEW_MODE`.
 */
export function explicitReviewMode(s: ReviewModeSources = {}): ReviewMode | undefined {
  const flag = parseReviewMode(s.flag, "--mode");
  if (s.deepFlag && flag === "fast") throw new ConfigError("--deep conflicts with --mode fast");
  if (s.deepFlag) return "deep";
  if (flag) return flag;
  const input = parseReviewMode(s.reviewMode, "review_mode");
  if (input) return input;
  const env = s.env ?? {};
  const fromMerge = parseReviewMode(env.MERGEJUDGE_MODE, "MERGEJUDGE_MODE");
  if (fromMerge) return fromMerge;
  const fromInputEnv = parseReviewMode(env.INPUT_REVIEW_MODE, "INPUT_REVIEW_MODE");
  if (fromInputEnv) return fromInputEnv;
  return undefined;
}

/** The mode a review should run: an explicit override, otherwise the config, otherwise fast. */
export function effectiveReviewMode(explicit: ReviewMode | undefined, cfg: Pick<Config, "ai"> | { ai?: { mode?: string | null } | null } | null | undefined): ReviewMode {
  return explicit ?? aiModeOf(cfg);
}

/**
 * A second-pass finding is kept only when `quote` appears in that file's diff and `line` is a new-file
 * line of a hunk. Anything else is dropped (it is not posted, and it does not raise a lane).
 */
export function verifyFindingEvidence(
  finding: { path?: string; line?: number; quote?: string; message?: string },
  files: readonly PrFile[],
): Finding | null {
  const path = finding.path?.trim() ?? "";
  const message = finding.message?.trim().slice(0, 300) ?? "";
  if (!path || !message) return null;
  const file = files.find((f) => f.path === path);
  const quote = finding.quote?.trim().slice(0, 200);
  if (!quote) return null;
  const hint = finding.line !== undefined && Number.isInteger(finding.line) && finding.line > 0 ? finding.line : undefined;
  if (file && quoteInPatch(quote, file.patch)) {
    const resolved = resolveLineFromQuote(quote, file.patch, hint);
    if (resolved !== null) return { path: file.path, line: resolved, quote, message };
    if (hint !== undefined && diffLines(file.patch).has(hint)) return { path: file.path, line: hint, quote, message };
    return null;
  }
  const moved = relocateQuoteAcrossFiles(quote, files, hint);
  return moved ? { path: moved.path, line: moved.line, quote, message } : null;
}
