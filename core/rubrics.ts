import { parse } from "yaml";
import { z } from "zod";
import type { Lane, PrFile } from "./types.js";

export const criterionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/i),
  question: z.string().min(5),
  severity: z.enum(["low", "medium", "high"]).default("medium"),
  scoring: z.enum(["pass_fail", "1-5"]).default("pass_fail"),
  /** Lane to raise the PR to when a high-severity criterion fails with evidence. */
  raise_to: z.enum(["review", "block"]).default("review"),
  /** Extra guidance appended to the question in the prompt (a learning proposal adds one when a check is often wrong). Context only. */
  note: z.string().max(300).optional(),
});
export type Criterion = z.infer<typeof criterionSchema>;
const packSchema = z.object({ name: z.string(), description: z.string().default(""), criteria: z.array(criterionSchema).min(1) });

const SECURITY = `
name: security
description: Secrets, injection, data exposure, unsafe execution.
criteria:
  - id: sec.no-secrets
    question: Does the change avoid adding real credentials, tokens or private keys (or instructions to expose them)?
    severity: high
    raise_to: block
  - id: sec.no-exfiltration
    question: Does the change avoid sending user, cookie, storage or environment data to unexpected external hosts?
    severity: high
    raise_to: block
  - id: sec.no-unsafe-exec
    question: Does the change avoid eval/new Function/shell execution of untrusted input, and piping remote scripts into a shell?
    severity: high
  - id: sec.input-handling
    question: Is untrusted input (URL params, form data, HTML) validated or escaped before use (no innerHTML/XSS sinks)?
    severity: medium
`;
const CORRECTNESS = `
name: correctness
description: Logic, error handling, tests.
criteria:
  - id: cor.logic
    question: Is the changed logic plausibly correct with no obvious bugs (off-by-one, wrong condition, broken control flow)?
    severity: high
  - id: cor.errors
    question: Are errors handled instead of silently swallowed where it matters?
    severity: medium
  - id: cor.tests
    question: Is new or changed behaviour covered by tests (n/a for docs/style-only changes)?
    severity: low
    scoring: 1-5
`;
const MAINTAINABILITY = `
name: maintainability
description: Readability and scope.
criteria:
  - id: mnt.readable
    question: Is the code readable, with clear names and no dead or debug code left behind?
    severity: low
    scoring: 1-5
  - id: mnt.scoped
    question: Is the change focused on one purpose (no unrelated edits mixed in)?
    severity: low
`;

export const DEFAULT_PACKS: Record<string, z.infer<typeof packSchema>> = Object.fromEntries(
  [SECURITY, CORRECTNESS, MAINTAINABILITY].map((y) => {
    const p = packSchema.parse(parse(y));
    return [p.name, p];
  }),
);
export const DEFAULT_ENABLED_PACKS = ["security", "correctness"];

export const NOTE_ID_RE = /^[a-z0-9][a-z0-9_.-]*$/i;

/** `notes` (config `rubrics.notes`) maps a criterion id, built-in or custom, to extra prompt guidance. */
export function selectCriteria(packs: string[], custom: Criterion[], notes: Record<string, string> = {}): Criterion[] {
  const out: Criterion[] = [];
  const seen = new Set<string>();
  for (const name of packs) {
    const p = DEFAULT_PACKS[name];
    if (!p) throw new Error(`Unknown rubric pack: ${name} (known: ${Object.keys(DEFAULT_PACKS).join(", ")})`);
    for (const c of p.criteria) if (!seen.has(c.id)) (seen.add(c.id), out.push(c));
  }
  for (const c of custom) if (!seen.has(c.id)) (seen.add(c.id), out.push(c));
  return out.map((c) => (notes[c.id] && !c.note ? { ...c, note: notes[c.id]! } : c));
}

export function criteriaPrompt(cs: Criterion[]): string {
  return cs
    .map((c) => `- ${c.id} [${c.severity}, ${c.scoring === "1-5" ? "score 1-5 (5 best)" : "pass/fail"}]: ${c.question}${c.note ? ` Note: ${c.note.replace(/\s+/g, " ").trim()}` : ""}`)
    .join("\n");
}

export const rubricOutputSchema = z
  .array(
    z.object({
      id: z.string(),
      result: z.union([z.enum(["pass", "fail", "n/a"]), z.coerce.number()]),
      justification: z.string().default(""),
      evidence: z
        .object({ path: z.string().default(""), line: z.coerce.number().int().optional(), quote: z.string().default("") })
        .optional(),
    }),
  )
  .max(50)
  .default([]);
export type RubricRaw = z.infer<typeof rubricOutputSchema>;

export type Verdict = "pass" | "fail" | "n/a" | "unverified";
export interface RubricResult {
  id: string;
  severity: Criterion["severity"];
  verdict: Verdict;
  score?: number;
  justification: string;
  evidence?: { path: string; line?: number; quote: string };
  raiseTo?: Lane;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** True when `quote` (L<n> prefix and leading +/- stripped, whitespace-normalised, >= 4 chars) appears in the patch. */
export function quoteInPatch(quote: string, patch: string | undefined): boolean {
  const q = norm(quote).replace(/^l\d+ /, "").replace(/^[+-]\s*/, "");
  return q.length >= 4 && norm(patch ?? "").includes(q);
}

interface NewLine { n: number; text: string; added: boolean }

/** New-file lines (added + context) of a unified diff, same hunk walk as `diffLines`. */
function newFileLines(patch: string): NewLine[] {
  const out: NewLine[] = [];
  let n = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { n = Number(h[1]); inHunk = true; continue; }
    if (!inHunk || line.startsWith("\\") || line.startsWith("-")) continue;
    out.push({ n, text: norm(line.slice(1)), added: line.startsWith("+") });
    n++;
  }
  return out;
}

const MAX_SPAN = 8;

/**
 * New-file line a verbatim `quote` sits on (the last line of a multi-line quote), or null when it is not in the patch.
 * Keeps `hintLine` when it matches; otherwise picks the match nearest the hint (added beats context, then earlier).
 */
export function resolveLineFromQuote(quote: string, patch: string | undefined, hintLine?: number): number | null {
  if (!patch || !quoteInPatch(quote, patch)) return null;
  const parts = quote.split("\n").map((l) => l.trim().replace(/^L\d+\s+/, "").replace(/^[+-]\s*/, "")).filter(Boolean);
  const q = norm(parts.join(" "));
  if (q.length < 4) return null;
  const lines = newFileLines(patch);
  const hits: NewLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    let joined = "";
    for (let j = i; j < lines.length && j < i + MAX_SPAN; j++) {
      if (j > i && lines[j]!.n !== lines[j - 1]!.n + 1) break;
      joined = joined ? `${joined} ${lines[j]!.text}` : lines[j]!.text;
      if (joined.includes(q)) { hits.push(lines[j]!); break; }
    }
  }
  if (!hits.length) return null;
  if (hintLine !== undefined && hits.some((l) => l.n === hintLine)) return hintLine;
  const hint = hintLine ?? 0;
  hits.sort((a, b) => Math.abs(a.n - hint) - Math.abs(b.n - hint) || Number(b.added) - Number(a.added) || a.n - b.n);
  return hits[0]!.n;
}

/** Path + line of the one file whose patch holds `quote`; null for zero or several candidates (never guess). */
export function relocateQuoteAcrossFiles(quote: string, files: readonly PrFile[], hintLine?: number): { path: string; line: number } | null {
  const cands = files.filter((f) => f.patch && quoteInPatch(quote, f.patch));
  if (cands.length !== 1) return null;
  const c = cands[0]!;
  const line = resolveLineFromQuote(quote, c.patch, hintLine);
  return line === null ? null : { path: c.path, line };
}

/**
 * Validate LLM rubric output against known criteria and the diff:
 * a fail only counts (and can raise the lane) if its evidence quote appears in that file's patch.
 * Otherwise it is downgraded to "unverified". Missing criteria are omitted.
 */
export function evaluateRubric(raw: RubricRaw, criteria: Criterion[], files: PrFile[]): RubricResult[] {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const patches = new Map(files.map((f) => [f.path, f.patch ?? ""]));
  const out: RubricResult[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const c = byId.get(r.id);
    if (!c || seen.has(r.id)) continue;
    seen.add(r.id);
    let verdict: Verdict;
    let score: number | undefined;
    if (typeof r.result === "number") {
      if (c.scoring !== "1-5" || !Number.isFinite(r.result)) continue;
      score = Math.min(5, Math.max(1, Math.round(r.result)));
      verdict = score <= 2 ? "fail" : "pass";
    } else verdict = r.result;
    let ev: RubricResult["evidence"] = r.evidence && r.evidence.quote.trim()
      ? { path: r.evidence.path, ...(r.evidence.line !== undefined ? { line: r.evidence.line } : {}), quote: r.evidence.quote.slice(0, 200) }
      : undefined;
    if (verdict === "fail") {
      const p = ev ? patches.get(ev.path) : undefined;
      if (!ev || p === undefined || !quoteInPatch(ev.quote, p)) {
        const moved = ev ? relocateQuoteAcrossFiles(ev.quote, files, ev.line) : null;
        if (ev && moved) ev = { path: moved.path, line: moved.line, quote: ev.quote };
        else verdict = "unverified";
      }
    }
    out.push({
      id: c.id,
      severity: c.severity,
      verdict,
      ...(score !== undefined ? { score } : {}),
      justification: r.justification.slice(0, 240),
      ...(ev ? { evidence: ev } : {}),
      ...(verdict === "fail" && c.severity === "high" ? { raiseTo: c.raise_to } : {}),
    });
  }
  return out;
}
