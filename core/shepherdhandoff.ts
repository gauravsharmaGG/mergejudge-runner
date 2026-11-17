import { escapeMd } from "./render.js";
import { RULE, RULE_STATUS, RULE_TITLE, type RuleId } from "./shepherdrules.js";
import { isShepherdCommitMessage, type AttemptRecord, type Fingerprint } from "./shepherdfail.js";
import { newFindings, type Finding } from "./triage.js";
import { redact } from "./redact.js";

export const HANDOFF_MARKER = "<!-- mergejudge:shepherd-handoff -->";
export const NEEDS_HUMAN_LABEL = "needs-human";

export interface HandoffInput {
  rule: RuleId;
  reason: string;
  /** The single question for the human. */
  question: string;
  repoUrl: string;
  failures?: Pick<Fingerprint, "job" | "hash" | "raw">[];
  /** Shepherd's own fix commits on the PR, with the CI run each one was triggered by when known. */
  attempts: (AttemptRecord & { run?: string })[];
  /** Files or paths a human should look at (protected paths, oversize files, conflicted files). */
  paths?: string[];
  /** Conflict hunks that need a human. */
  hunks?: { path: string; line: number; ours: string; theirs: string }[];
  /** Branch names, to label the two sides of a hunk (`main (base)`, `<head> (this PR)`). */
  baseRef?: string;
  headRef?: string;
  /** URL of the CI run that started this, when there is one. */
  run?: string;
  /** Full sha of the base commit being merged (conflict work); shown as a commit link. */
  baseCommit?: string;
}

const MAX_CHARS = 280;
const text = (s: string) => escapeMd(redact(String(s).slice(0, 2000)).replace(/\s+/g, " ").trim().slice(0, MAX_CHARS)).replace(/@(?=[A-Za-z0-9])/g, "@​");
const code = (s: string) => "`" + redact(String(s).slice(0, 2000)).replace(/[`\r\n]+/g, " ").trim().slice(0, MAX_CHARS) + "`";

/** The one hand-off comment: what failed, what was tried, which rule stopped it, and the single decision needed. */
export function renderHandoff(h: HandoffInput): string {
  const out = [
    HANDOFF_MARKER,
    "### 🐑 MergeJudge Shepherd stopped and needs a human",
    "",
    `**Stopped by:** ${RULE_TITLE[h.rule]}`,
    `**Why:** ${text(h.reason)}`,
  ];
  if (h.run && /^https:\/\/[^\s<>()]+$/.test(h.run)) out.push(`**CI run:** [run](${h.run})`);
  if (h.baseCommit && /^[0-9a-f]{7,40}$/i.test(h.baseCommit)) out.push(`**Base commit being merged:** [${h.baseCommit.slice(0, 7)}](${h.repoUrl}/commit/${h.baseCommit})`);
  out.push("");
  if (h.failures?.length) {
    out.push("**What failed:**");
    for (const f of h.failures.slice(0, 5)) out.push(`- ${code(f.job)}: ${code(f.raw || "(no error line found)")} (fingerprint ${code(f.hash)})`);
    out.push("");
  }
  out.push("**What it tried:**");
  if (h.attempts.length) {
    for (const a of h.attempts) {
      const links = [`[fix commit ${a.sha.slice(0, 7)}](${h.repoUrl}/commit/${a.sha})`, a.run ? `[CI run](${a.run})` : ""].filter(Boolean).join(", ");
      out.push(`${a.attempt}. ${a.kind === "conflict" ? "Conflict resolution" : "CI fix"}: ${links}`);
    }
  } else out.push("Nothing was pushed.");
  out.push("");
  if (h.paths?.length || h.hunks?.length) {
    out.push("**What to look at:**");
    for (const p of (h.paths ?? []).slice(0, 10)) out.push(`- ${code(p)}`);
    const ours = `${text(h.headRef || "head")} (this PR):`, theirs = `${text(h.baseRef || "base")} (base):`;
    for (const x of (h.hunks ?? []).slice(0, 10)) out.push(`- ${code(`${x.path}:${x.line}`)} ${ours} ${code(x.ours)} / ${theirs} ${code(x.theirs)}`);
    out.push("");
  }
  out.push(
    `**The one decision needed from you:** ${text(h.question)}`,
    "",
    "Shepherd pushes nothing else on this PR until a human removes the `needs-human` label or comments `/mergejudge shepherd`. It never merges.",
  );
  return out.join("\n");
}

export const handoffStatus = (rule: RuleId) => RULE_STATUS[rule];

// ---------------- review path (L5, L3) ----------------

export interface ReviewGuard {
  /** No suggested changes on this head (L5). */
  suggestions: boolean;
  /** Post new inline findings for this head. False on a Shepherd commit: it is never re-reviewed for new findings (L5). */
  syncInline: boolean;
  /** Findings on files the Shepherd commit touched: ping-pong, stop and hand off (L3). */
  pingPong: Finding[];
}

/**
 * L5 and the review half of L3. On a head commit authored by Shepherd: no suggestions, no new inline findings, and any finding
 * on a file that commit touched is a ping-pong signal. Otherwise the review is unchanged.
 */
export function reviewGuard(headCommitMessage: string | null | undefined, touchedFiles: readonly string[], findings: readonly Finding[]): ReviewGuard {
  if (!isShepherdCommitMessage(headCommitMessage)) return { suggestions: true, syncInline: true, pingPong: [] };
  const touched = new Set(touchedFiles);
  return { suggestions: false, syncInline: false, pingPong: newFindings(findings).filter((f) => touched.has(f.path)) };
}

export const PING_PONG_RULE = RULE.L3;
