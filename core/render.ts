import { explainLane, type Aggregate } from "./aggregate.js";
import { renderFeedback } from "./feedback.js";
import { renderLaneMap } from "./lanemap.js";
import type { Lane } from "./types.js";

export const MARKER = "<!-- mergejudge:summary -->";
export const EMOJI: Record<Lane, string> = { auto: "🟢", review: "🟡", block: "🔴" };

/** Make untrusted text safe inside a single markdown line / table cell. */
export function escapeMd(s: string): string {
  return s
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/[\\`*_{}\[\]()<>#+!|~]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/@/g, "@\u200b")
    .trim();
}

/** GitHub rejects comment bodies over 65,536 chars (check summaries: 65,535). Stay well under. */
export const MAX_COMMENT_CHARS = 60_000;
/** Rows listed per section before "N more" (a 500-file PR otherwise gives a 100 KB comment). */
export const MAX_LIST_ROWS = 100;
const moreNote = (shown: number, total: number) => (total > shown ? [`_…and ${total - shown} more not shown (${total} in total)._`] : []);

/**
 * Last-resort size guard: cut `head` at a line end so that head + `tail` fit in `max`, close any `<details>` the cut
 * left open and say so. `tail` (feedback block, footer) is always kept, so the sticky-comment markers survive.
 */
export function capBody(head: string, tail: string, max = MAX_COMMENT_CHARS): string {
  if (head.length + tail.length <= max) return head + tail;
  const note = "\n\n> ⚠️ This comment was shortened to fit GitHub's size limit.\n";
  let cut = head.slice(0, Math.max(0, max - tail.length - note.length - 64));
  cut = cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0));
  const open = (cut.match(/<details/g) ?? []).length - (cut.match(/<\/details>/g) ?? []).length;
  return cut + "\n" + "</details>\n".repeat(Math.max(open, 0)) + note + tail;
}

export interface RenderInput {
  agg: Aggregate;
  mode: string; // "rules-only" or model name
  tokensEstimate: number;
  notes: string[];
  /** File-level LLM findings (no valid diff line). */
  fileFindings?: { path: string; message: string }[];
  policyFiles?: { path: string; truncated: boolean }[];
  breakdown?: { system: number; policy: number; rubric: number; diff: number; context?: number; tools?: number; tool_calls?: number; output: number; total: number };
  /** The repo config's approval settings; the footer mentions auto-merge only when enabled with mode auto-merge-only. */
  approval?: { enabled?: boolean; mode?: string } | null;
  /** review.lane_map (default off): add the lane-choice map section. Explanatory only; never changes the lane. */
  laneMap?: boolean;
  /** Optional https URL of a hosted `buildLaneMapGif` image; embedded with a caption above the markdown map when laneMap is on. */
  laneMapImageUrl?: string;
  /** Optional MergeJudge panel URL; adds one link line to the lane map. The sticky stands alone without it. */
  panelUrl?: string;
}

/** The AI's per-file reason, escaped and capped, unless the rule reasons already say it. */
export function aiReasonNote(f: { reasons: string[]; llmReason?: string }): string {
  const raw = f.llmReason?.replace(/\s+/g, " ").trim();
  if (!raw || f.reasons.some((r) => r.includes(raw))) return "";
  const capped = raw.length > 200 ? raw.slice(0, 199).trimEnd() + "…" : raw;
  return `AI: ${escapeMd(capped)}`;
}

export function renderLaneExplanation(agg: Aggregate): string {
  const explanation = explainLane(agg);
  const head = `Why this lane? ${escapeMd(explanation.summary)}`;
  // With a single reason the details list repeats the summary line.
  if (explanation.reasons.length <= 1) return head;
  return [
    head,
    "", "<details><summary>Why this lane? Details</summary>", "",
    ...explanation.reasons.slice(0, MAX_LIST_ROWS).map((r) => `- ${r.path ? escapeMd(r.path) + ": " : ""}${escapeMd(r.messages.join("; "))}${r.source ? ` (source: ${escapeMd(r.source)})` : ""}`),
    ...moreNote(MAX_LIST_ROWS, explanation.reasons.length),
    "", "</details>",
  ].join("\n");
}

/** Footer note. MergeJudge never calls a merge API; approval.mode auto-merge-only only asks GitHub to auto-merge. */
export const MERGE_NOTE = "MergeJudge doesn't merge PRs itself.";
export const AUTO_MERGE_NOTE = "With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs.";

/** The footer's merge note: the second sentence only when the repo's config turns on approval with mode auto-merge-only. */
export function mergeNote(approval?: { enabled?: boolean; mode?: string } | null): string {
  return approval?.enabled === true && approval.mode === "auto-merge-only" ? `${MERGE_NOTE} ${AUTO_MERGE_NOTE}` : MERGE_NOTE;
}

/** Compact coaching lines: what the lanes mean for the `mergejudge/lane` check, and how to make `block` stop merges. */
export function renderLaneCoach(unverified = 0): string[] {
  return [
    `> \`review\` is advisory: the \`${CHECK_NAME}\` check concludes \`neutral\`; only \`block\` fails it.`,
    `> To make \`block\` stop merges, require the check \`${CHECK_NAME}\` in branch protection or rulesets.`,
    ...(unverified ? [`> ${unverified} finding${unverified === 1 ? "" : "s"} below need${unverified === 1 ? "s" : ""} human validation (no verified diff quote).`] : []),
  ];
}

export function renderComment(r: RenderInput): string {
  const { agg } = r;
  const safe = agg.files.filter((f) => f.lane === "auto");
  const out: string[] = [MARKER, "## ⚖️ MergeJudge", "",
    `**Overall lane:** ${EMOJI[agg.lane]} \`${agg.lane}\``, "",
    `Why this lane? ${escapeMd(explainLane(agg).summary)}`, "", "### Findings", ""];
  // Group across sources before capping: a late rubric blocker must precede any review finding.
  for (const lane of ["block", "review", "auto"] as const) {
    const rows: string[] = [];
    if (agg.lane === lane) rows.push(...agg.labelReasons.map((reason) => `- 🏷️ ${escapeMd(reason)}`));
    for (const f of agg.files.filter((f) => f.lane === lane && lane !== "auto")) {
      const reason = [escapeMd(f.reasons.join("; ")), aiReasonNote(f)].filter(Boolean).join("; ") || "-";
      rows.push(`- ${escapeMd(f.path)} (${escapeMd(f.source ?? "rule")}): ${reason}`);
    }
    for (const x of agg.rubric ?? []) {
      if (x.verdict !== "fail" || (x.raiseTo ?? "auto") !== lane) continue;
      const where = x.evidence ? ` (${escapeMd(x.evidence.path)}${x.evidence.line ? ":" + x.evidence.line : ""})` : "";
      rows.push(`- ❌ \`${escapeMd(x.id)}\` ${x.severity}${where}: ${escapeMd(x.justification)}${x.raiseTo ? ` → raised to ${x.raiseTo}` : ""}`);
    }
    if (rows.length) out.push(`#### ${lane === "auto" ? "Informational" : lane === "block" ? "Block" : "Review"}`, "", ...rows.slice(0, MAX_LIST_ROWS), ...moreNote(MAX_LIST_ROWS, rows.length), "");
  }
  if (!agg.files.some((f) => f.lane !== "auto") && !agg.labelReasons.length && !agg.rubric?.some((x) => x.verdict === "fail")) out.push("No lane-raising findings.", "");
  out.push(escapeMd(agg.summary), "");
  if (r.laneMap === true) {
    out.push(...renderLaneMap(agg, { emoji: EMOJI, escape: escapeMd, maxRows: MAX_LIST_ROWS, more: moreNote, checkName: CHECK_NAME, reason: (f) => [escapeMd(f.reasons.join("; ")), aiReasonNote(f)].filter(Boolean).join("; ") }, { imageUrl: r.laneMapImageUrl, panelUrl: r.panelUrl, omitOutcome: true }));
  } else {
    const explanation = renderLaneExplanation(agg).split("\n").slice(1).join("\n");
    if (explanation) out.push(explanation, "");
    if (safe.length) {
      out.push(`<details><summary>Safe files (${safe.length})</summary>`, "",
        ...safe.slice(0, MAX_LIST_ROWS).map((f) => `- ${escapeMd(f.path)}${f.codeAuto ? " (code, auto via code_auto opt-in)" : ""}`),
        ...moreNote(MAX_LIST_ROWS, safe.length), "", "</details>", "");
    }
  }
  out.push(...renderLaneCoach(), "");
  if (safe.length && safe.length < agg.files.length) {
    out.push("### Split suggestion", "", "These auto-mergeable files could go in a separate PR:", "",
      ...safe.slice(0, MAX_LIST_ROWS).map((f) => `- ${escapeMd(f.path)}`), ...moreNote(MAX_LIST_ROWS, safe.length), "");
  }
  if (agg.rubric?.length) {
    out.push("<details><summary>All criteria</summary>", "");
    for (const x of agg.rubric.slice(0, MAX_LIST_ROWS)) out.push(`- \`${escapeMd(x.id)}\` (${x.verdict})${x.score !== undefined ? ` ${x.score}/5` : ""}: ${escapeMd(x.justification) || "-"}`);
    out.push(...moreNote(MAX_LIST_ROWS, agg.rubric.length), "", "</details>", "");
  }
  const head = out.join("\n");
  const coverage: string[] = ["### Coverage gaps", ""];
  const gaps = [...r.notes];
  if (r.mode === "rules-only") gaps.unshift("AI review was not performed; only deterministic rules were checked.");
  for (const p of r.policyFiles ?? []) if (p.truncated) gaps.push(`Policy file truncated: ${p.path}`);
  for (const x of agg.rubric ?? []) if (x.verdict === "unverified") gaps.push(`Unverified criterion ${x.id}: ${x.justification}`);
  for (const n of gaps.slice(0, MAX_LIST_ROWS)) coverage.push(`- ${escapeMd(n)}`);
  coverage.push(...moreNote(MAX_LIST_ROWS, gaps.length));
  if (r.fileFindings?.length) {
    const n = r.fileFindings.length;
    coverage.push(`#### ❔ Needs human (${n})`, "", `${n} finding${n === 1 ? " needs" : "s need"} human validation (no verified diff quote), so ${n === 1 ? "it was" : "they were"} not posted as line comments.`, "");
    for (const f of r.fileFindings.slice(0, MAX_LIST_ROWS)) coverage.push(`- ${escapeMd(f.path)}: ${escapeMd(f.message)}`);
    coverage.push(...moreNote(MAX_LIST_ROWS, r.fileFindings.length), "");
  } else if (!gaps.length) coverage.push("No coverage gaps reported.", "");
  const tail: string[] = ["---", "", renderFeedback(agg.rubric ?? []), ""];
  tail.push(
    `<sub>Mode: ${escapeMd(r.mode)} · ~${r.tokensEstimate} tokens (estimate)` +
      (r.policyFiles?.length
        ? ` · Policy: ${r.policyFiles.map((p) => escapeMd(p.path) + (p.truncated ? " (truncated)" : "")).join(", ")}`
        : "") +
      (r.breakdown
        ? ` · tokens system ${r.breakdown.system}/policy ${r.breakdown.policy}/rubric ${r.breakdown.rubric}/diff ${r.breakdown.diff}${r.breakdown.context ? `/context ${r.breakdown.context}` : ""}${r.breakdown.tools ? `/tools ${r.breakdown.tools} (${r.breakdown.tool_calls ?? 0} calls)` : ""}/out ${r.breakdown.output}`
        : "") +
      ` · ${mergeNote(r.approval)}</sub>`,
  );
  const closing = capBody(coverage.join("\n"), "\n" + tail.join("\n"), MAX_COMMENT_CHARS / 2);
  return capBody(head, "\n" + closing);
}

export const CHECK_NAME = "mergejudge/lane";
export const CHECK_CONCLUSION: Record<Lane, "success" | "neutral" | "failure"> = {
  auto: "success",
  review: "neutral",
  block: "failure",
};

export function checkSummary(agg: Aggregate): { title: string; summary: string } {
  const n = (l: Lane) => agg.files.filter((f) => f.lane === l).length;
  return {
    title: `Lane: ${agg.lane}`,
    summary: capBody(renderLaneExplanation(agg), `\n\n${EMOJI[agg.lane]} Overall lane **${agg.lane}** — ${n("auto")} auto, ${n("review")} review, ${n("block")} block file(s).`),
  };
}
