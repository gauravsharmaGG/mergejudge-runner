import { createHash } from "node:crypto";
import { explainLane, type Aggregate } from "./aggregate.js";
import { renderFeedback } from "./feedback.js";
import { renderLaneMap } from "./lanemap.js";
import { renderWhereItSits, type WhereItSits } from "./whereitsits.js";
import { renderStorySection, type Story } from "./story.js";
import type { RubricResult } from "./rubrics.js";
import { LANE_ORDER, type FileVerdict, type Lane } from "./types.js";

export const MARKER = "<!-- mergejudge:summary -->";
export const EMOJI: Record<Lane, string> = { auto: "🟢", review: "🟡", block: "🔴" };

/** Make untrusted text safe inside a single markdown line / table cell. */
export function escapeMd(s: string): string {
  return s
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/[\\`*_{}\[\]()<>#+!|~]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/@/g, "@​")
    .trim();
}

/** GitHub rejects comment bodies over 65,536 chars (check summaries: 65,535). Stay well under. */
export const MAX_COMMENT_CHARS = 60_000;
/** Rows listed per section before "N more" (a 500-file PR otherwise gives a 100 KB comment). */
export const MAX_LIST_ROWS = 100;
/** Files named per rule in "Why this lane?" before "+N more". */
const MAX_FILES_PER_REASON = 10;
/** Above this many files the Files section adds the folder table (when lane_map is on). */
const BUCKET_TABLE_MIN_FILES = 15;
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
  /** Tokens of the separate PR story call; shown in the footer as `(story N)` and added to the total. Not part of the review estimate. */
  storyTokens?: number;
  notes: string[];
  /** File-level LLM findings (no valid diff line). */
  fileFindings?: { path: string; message: string }[];
  /** Findings with a verified diff line; they become inline comments right after the sticky is posted. */
  lineFindings?: { path: string; line: number; message: string }[];
  /** The PR's web URL (html_url). Enables links to diff lines; without it locations are plain `path:line` text. */
  prUrl?: string;
  policyFiles?: { path: string; truncated: boolean }[];
  breakdown?: { system: number; policy: number; rubric: number; diff: number; context?: number; tools?: number; tool_calls?: number; second_pass?: number; output: number; total: number };
  /** The repo config's approval settings; the footer mentions auto-merge only when enabled with mode auto-merge-only. */
  approval?: { enabled?: boolean; mode?: string } | null;
  /** review.lane_map (default off): add the folder table (big PRs) and image/panel link to the Files section. Explanatory only; never changes the lane. */
  laneMap?: boolean;
  /** Optional https URL of a hosted `buildLaneMapGif` image; embedded with a caption in the Files section when laneMap is on. */
  laneMapImageUrl?: string;
  /** Optional MergeJudge panel URL; adds one link line to the Files section. The sticky stands alone without it. */
  panelUrl?: string;
  /** comment.flow_chart: the validated PR story, drawn as a collapsed SVG image or Mermaid chart after "What to check". Dropped first when the comment is over the size cap. */
  story?: Story | null;
  /** comment.flow_chart_animate (default true): animate edges on new or changed paths. */
  storyAnimate?: boolean;
  storyStyle?: "svg" | "mermaid";
  storyImageUrl?: string | null;
  /** comment.where_it_sits: import neighbours of the changed files, shown after the story. Dropped with the story when the comment is over the size cap. */
  whereItSits?: WhereItSits | null;
}

/** The findings that carry a verified diff line (the ones that become inline comments). */
export function lineFindingsOf(findings: { path: string; line?: number; message: string }[]): { path: string; line: number; message: string }[] {
  return findings.flatMap((f) => (f.line === undefined ? [] : [{ path: f.path, line: f.line, message: f.message }]));
}

/* ---------- small helpers ---------- */

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const cap = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);
const upFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A path as a code span; paths that cannot sit in one (backtick, newline) fall back to escaped text. */
const code = (s: string) => (/[`\r\n]/.test(s) ? escapeMd(s) : `\`${s}\``);

const CRITERION_LABELS: Record<string, string> = {
  "sec.no-secrets": "Security: secrets",
  "sec.no-exfiltration": "Security: data exfiltration",
  "sec.no-unsafe-exec": "Security: unsafe execution",
  "sec.input-handling": "Security: input handling",
  "cor.logic": "Logic",
  "cor.errors": "Error handling",
  "cor.tests": "Tests",
  "mnt.readable": "Readability",
  "mnt.scoped": "Scope",
};

/** Plain-words name of a rubric criterion for the main view; custom criteria fall back to their id. */
export function criterionLabel(id: string): string {
  return CRITERION_LABELS[id] ?? id;
}

const plainHttps = (u?: string) => (u && /^https:\/\/[^\s()<>"'`]+$/.test(u) ? u.replace(/\/+$/, "") : undefined);

/** GitHub's diff anchor: `#diff-` + sha256 of the file path, `R<line>` for a line on the new side. */
export function diffLink(prUrl: string, path: string, line?: number): string {
  return `${prUrl}/files#diff-${createHash("sha256").update(path).digest("hex")}${line ? `R${line}` : ""}`;
}

/** Hosts whose links stay clickable in notes: MergeJudge's own pages and GitHub. */
function trustedLinkHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === "mergejudge.si" || h.endsWith(".mergejudge.si") || h === "github.com" || h === "docs.github.com";
  } catch {
    return false;
  }
}

/**
 * A note as one markdown line. The text is escaped (notes can carry attacker-chosen file paths), then only two shapes are
 * restored: well-formed `[label](https://url)` links with a conservative label and URL, and bare https URLs (so they
 * stay clickable; escaping `_` or `&` inside them would break the link), and only for MergeJudge or GitHub hosts.
 */
export function renderNote(note: string): string {
  const flat = note.replace(/\s*[\r\n]+\s*/g, " ");
  const URL_CHARS = "[^\\s()<>\"'`\\\\\\[\\]@*|~{}]+";
  const re = new RegExp(`\\[([A-Za-z0-9 ._,'-]{1,80})\\]\\((https://${URL_CHARS})\\)|https://${URL_CHARS}`, "g");
  // Escape a stretch of text but keep the single spaces at its ends (escapeMd trims).
  const text = (s: string) => {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return (m[1] ? " " : "") + escapeMd(m[2]!) + (m[3] ? " " : "");
  };
  let out = "", last = 0;
  for (const m of flat.matchAll(re)) {
    // Only links to MergeJudge or GitHub come back; a link to any other host (e.g. from a file name) stays escaped text.
    if (!trustedLinkHost(m[2] ?? m[0].replace(/[.,;:!?]+$/, ""))) continue;
    out += text(flat.slice(last, m.index));
    if (m[1] !== undefined) {
      out += `[${m[1]}](${m[2]})`;
      last = m.index + m[0].length;
    } else {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      out += url;
      last = m.index + url.length;
    }
  }
  return (out + text(flat.slice(last))).trim();
}

/* ---------- AI notes and rule reasons ---------- */

function aiNoteText(f: { reasons: string[]; llmReason?: string }): string {
  const raw = f.llmReason?.replace(/\s+/g, " ").trim();
  // The raising reason is stored as "LLM: <raw>" and shown here as an AI note, so only another rule's wording counts as a repeat.
  if (!raw || f.reasons.some((r) => r.includes(raw) && !r.startsWith("LLM: "))) return "";
  return escapeMd(cap(raw, 200));
}

/** The AI's per-file reason, escaped and capped, unless the rule reasons already say it. */
export function aiReasonNote(f: { reasons: string[]; llmReason?: string }): string {
  const t = aiNoteText(f);
  return t ? `AI: ${t}` : "";
}

/** A rule reason in plain words, or null for AI reasons (shown as AI notes instead). */
function cleanReason(r: string): string | null {
  if (r.startsWith("LLM: ")) return null;
  if (r === "LLM flagged this file") return "AI flagged this file";
  const rubric = r.match(/^rubric (\S+) failed$/);
  if (rubric) return `Check failed: ${criterionLabel(rubric[1]!)}`;
  const wasAuto = r.match(/^rule: auto \((.*)\)$/);
  if (wasAuto) return `Rules said auto (${wasAuto[1]})`;
  const t = r.replace(/\s*\(always needs human review\)/i, "").replace(/:\s*always needs human review/i, "").trim();
  return t ? upFirst(t) : null;
}

function fileReasonHeads(f: FileVerdict): string[] {
  const heads = [...new Set(f.reasons.map(cleanReason).filter((x): x is string => !!x))];
  return heads.length ? heads : f.llmReason ? ["AI flagged this file"] : [];
}

/* ---------- lane explanation (check-run summary) ---------- */

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

/* ---------- sticky sections ---------- */

const isOpen = (x: RubricResult) => x.verdict === "fail" || x.verdict === "unverified";

function outcomeLines(agg: Aggregate, flagged: number, problems: number, lineComments: number): string[] {
  const total = agg.files.length;
  const parts = [`**Overall lane:** ${EMOJI[agg.lane]} \`${agg.lane}\``];
  if (agg.lane === "auto") parts.push(total ? `all ${plural(total, "file")} look${total === 1 ? "s" : ""} safe to auto-merge` : "no files to review");
  else if (flagged) parts.push(`${flagged} of ${plural(total, "file")} need${flagged === 1 ? "s" : ""} a human look`);
  else parts.push("held by PR labels or PR-level checks");
  if (problems) parts.push(`${plural(problems, "problem")} found`);
  if (lineComments) parts.push(plural(lineComments, "line comment"));
  // Italic, not a blockquote or plain line: learnflow takes the first plain line as the PR summary.
  const advisory =
    agg.lane === "review" ? [`*\`review\` is advisory: the \`${CHECK_NAME}\` check stays neutral; only \`block\` fails it.*`]
    : agg.lane === "block" ? [`*\`block\` fails the \`${CHECK_NAME}\` check.*`]
    : [];
  return [parts.join(" · "), "", ...advisory, ...(advisory.length ? [""] : [])];
}

function whatToCheck(r: RenderInput, rubricOpen: RubricResult[]): string[] {
  const { agg } = r;
  const base = plainHttps(r.prUrl);
  const laneOf = (path: string): Lane => agg.files.find((f) => f.path === path)?.lane ?? "review";
  const loc = (path: string, line?: number) =>
    base ? (line ? `[L${line}](${diffLink(base, path, line)})` : `[diff](${diffLink(base, path)})`) : line ? `${escapeMd(path)}:${line}` : "";
  const key = (path: string, line: number) => `${path}:${line}`;
  const lineKeys = new Set((r.lineFindings ?? []).map((l) => key(l.path, l.line)));
  const rubricKeys = new Set<string>();

  interface Group { title: string; lane: Lane; fixed?: "pr" | "labels"; bullets: string[] }
  const groups = new Map<string, Group>();
  const group = (path: string): Group => {
    let g = groups.get(path);
    if (!g) groups.set(path, (g = path ? { title: escapeMd(path), lane: laneOf(path), bullets: [] } : { title: "Whole PR", lane: "review", fixed: "pr", bullets: [] }));
    return g;
  };

  for (const x of rubricOpen) {
    const detail = [x.severity, ...(x.verdict === "unverified" ? ["needs a human check"] : []), ...(x.score !== undefined ? [`${x.score}/5`] : [])].join(", ");
    const ev = x.evidence;
    const onLine = ev?.line !== undefined && lineKeys.has(key(ev.path, ev.line));
    if (ev?.line !== undefined) rubricKeys.add(key(ev.path, ev.line));
    const where = ev ? loc(ev.path, ev.line) : "";
    group(ev?.path ?? "").bullets.push(`**${escapeMd(criterionLabel(x.id))} (${detail}):** ${escapeMd(x.justification) || "-"}${where ? ` ${where}` : ""}${onLine ? " · line comment" : ""}`);
  }
  const seen = new Set<string>();
  for (const l of r.lineFindings ?? []) {
    const k = key(l.path, l.line);
    if (rubricKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    group(l.path).bullets.push(`${loc(l.path, l.line)} ${escapeMd(l.message)}`);
  }
  for (const f of r.fileFindings ?? []) group(f.path).bullets.push(`${escapeMd(f.message)} · _needs a human check (no verified line)_`);
  if (agg.labelReasons.length) groups.set("\0labels", { title: "PR labels / holds", lane: agg.lane, fixed: "labels", bullets: agg.labelReasons.map(escapeMd) });

  const rank = (g: Group) => (g.fixed === "labels" ? -2 : g.fixed === "pr" ? -1 : LANE_ORDER[g.lane]);
  const ordered = [...groups.values()].sort((a, b) => rank(b) - rank(a));
  const total = ordered.reduce((n, g) => n + g.bullets.length, 0);
  if (!total) return ["### What to check", "", "Nothing specific flagged.", ""];
  const out = ["### What to check", ""];
  let shown = 0;
  for (const g of ordered) {
    const room = MAX_LIST_ROWS - shown;
    if (room <= 0) break;
    const bullets = g.bullets.slice(0, room);
    shown += bullets.length;
    out.push(`**${g.title}**`, ...bullets.map((b) => `- ${b}`), "");
  }
  out.push(...moreNote(shown, total).flatMap((m) => [m, ""]));
  return out;
}

function whyThisLane(r: RenderInput, flagged: FileVerdict[]): string[] {
  const { agg } = r;
  const subject = agg.lane === "auto" ? agg.files : flagged;
  const byReason = new Map<string, string[]>();
  for (const f of subject) for (const head of fileReasonHeads(f)) (byReason.get(head) ?? byReason.set(head, []).get(head)!).push(f.path);
  let short: string;
  if (agg.lane === "auto") short = escapeMd(explainLane(agg).summary.replace(/^auto: /, ""));
  else if (flagged.length && byReason.size) short = `${plural(flagged.length, "file")} matched ${plural(byReason.size, "rule")}`;
  else if (flagged.length) short = `AI flagged ${plural(flagged.length, "file")}`;
  else short = `held by ${plural(agg.labelReasons.length, "PR label or check", "PR labels or checks")}`;
  const out = [`<details><summary><b>Why this lane?</b> ${short}</summary>`, ""];
  const reasons = [...byReason].slice(0, MAX_LIST_ROWS);
  for (const [head, paths] of reasons) {
    const list = paths.slice(0, MAX_FILES_PER_REASON).map(code).join(", ");
    out.push(`- **${escapeMd(head)}:** ${list}${paths.length > MAX_FILES_PER_REASON ? ` +${paths.length - MAX_FILES_PER_REASON} more` : ""}`);
  }
  out.push(...moreNote(MAX_LIST_ROWS, byReason.size));
  const aiNotes = flagged.flatMap((f) => {
    const t = aiNoteText(f);
    return t ? [`- ${code(f.path)}: ${t}`] : [];
  });
  if (aiNotes.length) out.push("", "AI notes:", "", ...aiNotes.slice(0, MAX_LIST_ROWS), ...moreNote(MAX_LIST_ROWS, aiNotes.length));
  if (agg.labelReasons.length) out.push("", "PR labels / holds:", "", ...agg.labelReasons.slice(0, MAX_LIST_ROWS).map((l) => `- ${escapeMd(l)}`));
  if (!reasons.length && !aiNotes.length && !agg.labelReasons.length) out.push("No rule reasons were recorded.");
  out.push("", "</details>", "");
  return out;
}

function filesSection(r: RenderInput, flagged: FileVerdict[], safe: FileVerdict[]): string[] {
  const { agg } = r;
  if (!agg.files.length) return [];
  const n = (l: Lane) => agg.files.filter((f) => f.lane === l).length;
  const counts = (["block", "review", "auto"] as const).filter((l) => n(l)).map((l) => `${n(l)} ${l}`).join(" · ");
  const out = [`<details><summary><b>Files (${agg.files.length}):</b> ${counts}</summary>`, ""];
  if (r.laneMap === true) {
    out.push(...renderLaneMap(agg, { emoji: EMOJI, escape: escapeMd, maxRows: MAX_LIST_ROWS, more: moreNote },
      { imageUrl: r.laneMapImageUrl, panelUrl: r.panelUrl, buckets: agg.files.length > BUCKET_TABLE_MIN_FILES }));
  }
  // Sort a copy before capping so late files that raise the lane are never displaced by auto files.
  const files = [...agg.files].sort((a, b) => LANE_ORDER[b.lane] - LANE_ORDER[a.lane]);
  for (const f of files.slice(0, MAX_LIST_ROWS)) {
    const why = f.codeAuto ? "small code file, auto via code_auto opt-in" : fileReasonHeads(f).slice(0, 2).join(", ");
    out.push(`- ${EMOJI[f.lane]} ${code(f.path)}${why ? ` — ${escapeMd(cap(why, 80))}` : ""}`);
  }
  out.push(...moreNote(MAX_LIST_ROWS, files.length), "");
  if (safe.length && flagged.length) out.push(`The ${plural(safe.length, "auto file")} could go in a separate auto-mergeable PR.`, "");
  out.push("</details>", "");
  return out;
}

function allChecks(rubric: RubricResult[]): string[] {
  if (!rubric.length) return [];
  const icon = { pass: "✅", fail: "❌", "n/a": "➖", unverified: "❔" } as const;
  const n = (v: RubricResult["verdict"]) => rubric.filter((x) => x.verdict === v).length;
  const counts = ([["pass", "pass"], ["fail", "fail"], ["unverified", "unverified"], ["n/a", "n/a"]] as const)
    .filter(([v]) => n(v)).map(([v, word]) => `${n(v)} ${word}`).join(" · ");
  const out = [`<details><summary><b>All checks</b> (${counts})</summary>`, ""];
  // Ids stay here, in the "- ❌ `id`" shape the learning flow reads back; the text for failed items lives in "What to check".
  for (const x of rubric.slice(0, MAX_LIST_ROWS))
    out.push(`- ${icon[x.verdict]} \`${escapeMd(x.id)}\`${x.score !== undefined ? ` ${x.score}/5` : ""}: ${isOpen(x) ? "see What to check" : escapeMd(x.justification) || "-"}`);
  out.push(...moreNote(MAX_LIST_ROWS, rubric.length), "", "</details>", "");
  return out;
}

function notChecked(r: RenderInput): string {
  const out: string[] = [];
  // A note that already says why AI did not run (skipped, unavailable, rules-only) replaces the generic line.
  if (r.mode === "rules-only" && !r.notes.some((x) => /rules-only|AI review (?:unavailable|skipped)/i.test(x))) out.push("- AI review was not performed; deterministic rules only.");
  for (const p of r.policyFiles ?? []) if (p.truncated) out.push(`- Policy truncated: ${escapeMd(p.path)}`);
  for (const x of r.agg.rubric ?? []) if (x.verdict === "unverified") out.push(`- Unverified check: ${escapeMd(criterionLabel(x.id))}`);
  // "Policy file missing or empty: X" notes (one per optional policy file) collapse into one line.
  const MISSING = /^Policy file missing or empty: (.+)$/;
  const missing = r.notes.map((n) => n.match(MISSING)?.[1]).filter((p): p is string => !!p);
  for (const n of r.notes) if (!MISSING.test(n)) out.push(`- ${renderNote(n)}`);
  if (missing.length) out.push(`- Policy ${missing.length === 1 ? "file" : "files"} missing or empty: ${missing.map(escapeMd).join(", ")}`);
  if (!out.length) return "";
  out.push("");
  return capBody(["### Not checked", "", ...out].join("\n"), "", 12_000);
}

export function renderComment(r: RenderInput): string {
  const { agg } = r;
  const flagged = agg.files.filter((f) => f.lane !== "auto");
  const safe = agg.files.filter((f) => f.lane === "auto");
  const rubric = agg.rubric ?? [];
  const rubricOpen = rubric.filter(isOpen);
  const problems = rubricOpen.length + (r.fileFindings?.length ?? 0);
  const out: string[] = [MARKER, "## ⚖️ MergeJudge", ""];
  out.push(...outcomeLines(agg, flagged.length, problems, r.lineFindings?.length ?? 0));
  out.push(escapeMd(agg.summary), "");
  const checks = whatToCheck(r, rubricOpen);
  const rest = [...whyThisLane(r, flagged), ...filesSection(r, flagged, safe), ...allChecks(rubric)];
  const chart = r.story ? renderStorySection(r.story, r.storyAnimate !== false, r.storyStyle, r.storyImageUrl) : [];
  const list = r.story ? renderStorySection(r.story, false, r.storyStyle, null, false) : [];
  const sits = r.whereItSits ? renderWhereItSits(r.whereItSits) : [];
  const headOf = (section: string[], extra: string[] = []) => [...out, ...checks, ...section, ...extra, ...rest].join("\n");
  // The tail is never cut by the size cap: what was not checked, the feedback block and the footer.
  const unchecked = notChecked(r);
  const tail: string[] = [...(unchecked ? [unchecked] : []), "---", "", renderFeedback(rubric), ""];
  tail.push(
    `<sub>${r.mode === "rules-only" ? "rules-only · " : ""}~${r.tokensEstimate + (r.storyTokens ?? 0)} tokens${r.storyTokens ? ` (story ${r.storyTokens})` : ""} · ${mergeNote(r.approval)} · To make <code>block</code> stop merges, require <code>${CHECK_NAME}</code> in branch protection.</sub>`,
    "",
    "<details><summary><sub>Run details</sub></summary>",
    "",
    `<sub>Mode: ${escapeMd(r.mode)}` +
      (r.policyFiles?.length ? ` · Policy: ${r.policyFiles.map((p) => escapeMd(p.path) + (p.truncated ? " (truncated)" : "")).join(", ")}` : "") +
      (r.breakdown
        ? ` · tokens system ${r.breakdown.system}/policy ${r.breakdown.policy}/rubric ${r.breakdown.rubric}/diff ${r.breakdown.diff}${r.breakdown.context ? `/context ${r.breakdown.context}` : ""}${r.breakdown.tools ? `/tools ${r.breakdown.tools} (${r.breakdown.tool_calls ?? 0} calls)` : ""}${r.breakdown.second_pass ? `/second ${r.breakdown.second_pass}` : ""}/out ${r.breakdown.output}`
        : "") +
      "</sub>",
    "",
    "</details>",
  );
  const tailText = "\n" + tail.join("\n");
  // The chart is the first thing to go when the comment is over the cap, then the where-it-sits table, then the story list.
  let head = headOf(chart, sits);
  if (head.length + tailText.length > MAX_COMMENT_CHARS) head = headOf(list, sits);
  if (head.length + tailText.length > MAX_COMMENT_CHARS) head = headOf(list);
  if (head.length + tailText.length > MAX_COMMENT_CHARS) head = headOf([]);
  return capBody(head, tailText);
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
