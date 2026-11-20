import { parse } from "yaml";
import { z } from "zod";
import type { Lane, PrFile } from "./types.js";

/**
 * A finding's "line" as a new-file line number, or undefined. Accepts a positive integer, a numeric string ("76") and
 * the prompt's own prefix form ("L76" or "L76 +code"). Anything else (the model copying the code into "line") becomes
 * undefined, so one bad field keeps the finding file-level instead of failing the whole reply as a parse error.
 */
export function lenientLine(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  // A bare number must be the whole value: "10 * x" is code, not line 10.
  const m = v.trim().match(/^(?:L(\d+)(?:\s|$)|(\d+)$)/i);
  const n = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

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
        .object({ path: z.string().default(""), line: z.unknown().transform(lenientLine).optional(), quote: z.string().default("") })
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
    const ev = r.evidence && r.evidence.quote.trim()
      ? { path: r.evidence.path, ...(r.evidence.line !== undefined ? { line: r.evidence.line } : {}), quote: r.evidence.quote.slice(0, 200) }
      : undefined;
    if (verdict === "fail") {
      const p = ev ? patches.get(ev.path) : undefined;
      if (!ev || p === undefined || !quoteInPatch(ev.quote, p)) verdict = "unverified";
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
