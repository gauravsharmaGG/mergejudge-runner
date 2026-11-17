/**
 * AI review depth (`ai.mode`: fast | deep) and the evidence check for second-pass findings. Lives in core/ so the
 * published engine has no dependency on runner-only code; src/deep.ts re-exports it.
 */
import { quoteInPatch } from "./rubrics.js";
import { diffLines, type Finding, type FindingSeverity } from "./triage.js";
import type { PrFile } from "./types.js";

export const REVIEW_MODES = ["fast", "deep"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** `deep` only when the config (or a job payload) says so. Anything else, including a missing `ai` block, is fast. */
export function aiModeOf(cfg: { ai?: { mode?: string | null } | null } | null | undefined): ReviewMode {
  return cfg?.ai?.mode === "deep" ? "deep" : "fast";
}

/**
 * A second-pass finding is kept only when `quote` appears in that file's diff and `line` is a new-file
 * line of a hunk. Anything else is dropped (it is not posted, and it does not raise a lane).
 */
export function verifyFindingEvidence(
  finding: { path?: string; line?: number; quote?: string; message?: string; severity?: FindingSeverity; pre_existing?: boolean },
  files: readonly PrFile[],
): Finding | null {
  const path = finding.path?.trim() ?? "";
  const message = finding.message?.trim().slice(0, 300) ?? "";
  if (!path || !message) return null;
  const file = files.find((f) => f.path === path);
  if (!file) return null;
  const quote = finding.quote?.trim().slice(0, 200);
  if (!quote || !quoteInPatch(quote, file.patch)) return null;
  const line = finding.line;
  if (line === undefined || !Number.isInteger(line) || line <= 0 || !diffLines(file.patch).has(line)) return null;
  const preExisting = finding.pre_existing === true;
  return { path: file.path, line, quote, message, ...(finding.severity ? { severity: finding.severity } : {}), ...(preExisting ? { preExisting: true } : {}) };
}
