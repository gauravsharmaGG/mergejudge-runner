/**
 * Proof tests (beta, runner only). For serious findings the reviewer writes a small executable test that passes on the PR's
 * base commit and fails on its head. A finding whose test does exactly that gets a "proven by test" badge and the test in a
 * collapsed block; every other finding is posted exactly as before. Nothing in here can fail a review: every error path
 * ends in "no badge".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeMd } from "../../core/render.js";
import { estimateTokens } from "../../core/triage.js";
import type { ReviewResult } from "../../core/review.js";
import type { PrFile } from "../../core/types.js";
import type { Logger } from "../redact.js";
import { languageOf, type Language } from "./filter.js";
import { proofGate } from "./gate.js";
import type { ProofOptions } from "./options.js";
import { INTENT_SCHEMA, TEST_SCHEMA, intentPrompt, parseIntent, parseTest, testPrompt, type ProofLlm } from "./prompts.js";
import { proveTest } from "./prove.js";
import { exportTree } from "./run.js";
import type { Sandbox } from "./sandbox.js";

/** Prefix of a proven finding's message. TODO(learning): the dismissal signal (core/falsealarm.ts classifyThread, stored by the Worker) reads this text; a Worker-side hook could treat "dismissed while badged" as a stronger "not a bug here" signal. Nothing in this repo stores signals, so it is not wired. */
export const PROOF_BADGE = "🧪 Proven by test: ";
export const isProofBadged = (message: string): boolean => message.startsWith(PROOF_BADGE);

const MAX_BODY = 64_000;
const MAX_MESSAGE = 4000;
/** Wall-clock ceiling for the whole step; the job's own timeout still applies on top. */
export const PROOF_TOTAL_MS = 4 * 60_000;

export interface ProofDeps {
  opts: ProofOptions;
  llm: ProofLlm;
  /** Resolves the sandbox (null = none usable on this machine). Called only after the gate passed. */
  sandbox: () => Promise<Sandbox | null>;
  /** Git directory holding both commits (the local clone); null for jobs without a local clone. */
  gitDir: string | null;
  baseSha: string | null;
  headSha: string;
  pr: { title: string; body: string };
  /** Text of REVIEW.md-style sensitive globs (already parsed). */
  sensitive: string[];
  files: PrFile[];
  readFileAt: (sha: string, path: string) => Promise<string | null>;
  env: Record<string, string | undefined>;
  log: Logger;
  signal?: AbortSignal;
  tmpRoot?: string;
  totalMs?: number;
}

export interface ProofSummary {
  ran: boolean;
  /** Why the step did nothing, when ran is false. */
  reason?: string;
  attempted: number;
  proven: number;
  /** Estimated tokens of the proof step's model calls (also added to the comment footer). */
  tokens?: number;
}

interface Proven { index: number; language: Language; code: string; asserts: string }

const skipped = (reason: string): ProofSummary => ({ ran: false, reason, attempted: 0, proven: 0 });

const fenceFor = (code: string) => "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));

export function renderProofSection(proven: Proven[], findings: ReviewResult["findings"], intent: { intent: string; risk: string }, attempted: number, withTests = true): string {
  const out = ["### 🧪 Proof tests (beta)", "", `<sub>${proven.length} of ${attempted} tested finding${attempted === 1 ? "" : "s"} proven by an executable test. Claims: ${escapeMd(intent.intent)} Could break: ${escapeMd(intent.risk)}</sub>`, ""];
  for (const p of proven) {
    const f = findings[p.index]!;
    const text = f.message.startsWith(PROOF_BADGE) ? f.message.slice(PROOF_BADGE.length) : f.message;
    out.push(`**🧪 Proven by test** \`${f.path}${f.line ? `:${f.line}` : ""}\`: ${escapeMd(text)}`, "");
    if (!withTests) continue;
    const fence = fenceFor(p.code);
    out.push("<details><summary>Test that passes on the base commit and fails on the head (move it into your test directory first)</summary>", "", ...(p.asserts ? [`_${escapeMd(p.asserts)}_`, ""] : []), "_Written to run from `.mj-proof/` at the repo root, so its imports are relative to that folder: move the file next to your tests and fix the import paths._", "", `${fence}${p.language === "python" ? "python" : "js"}`, p.code, fence, "", "</details>", "");
  }
  return out.join("\n");
}

/** Adds the proof step's tokens to the footer count: `~N tokens` becomes `~N+P tokens (proof P)`, next to the story share when there is one. */
export function addProofTokens(body: string, tokens: number): string {
  if (tokens <= 0) return body;
  const all = [...body.matchAll(/~(\d+) tokens(?: \(story (\d+)\))?/g)];
  const m = all[all.length - 1];
  if (!m) return body;
  const note = `${m[2] ? `story ${m[2]}, ` : ""}proof ${tokens}`;
  return `${body.slice(0, m.index)}~${Number(m[1]) + tokens} tokens (${note})${body.slice(m.index! + m[0].length)}`;
}

/** Puts the section above the comment's tail (the "---" block with the footer), or at the end when there is none. */
export function insertProofSection(body: string, section: string): string {
  const at = body.lastIndexOf("\n---\n");
  return at < 0 ? `${body}\n\n${section}\n` : `${body.slice(0, at).replace(/\n+$/, "")}\n\n${section}\n${body.slice(at)}`;
}

/**
 * Mutates `result` (finding messages and body) only for proven findings. Resolves on every path; the caller needs no try/catch.
 * With `opts.enabled` false it returns before doing anything at all.
 */
export async function applyProofTests(result: ReviewResult, d: ProofDeps): Promise<ProofSummary> {
  if (!d.opts.enabled) return skipped("off");
  let tokens = 0;
  const counted: ProofDeps = {
    ...d,
    llm: async (req) => {
      tokens += estimateTokens(req.system) + estimateTokens(req.user);
      const reply = await d.llm(req);
      tokens += estimateTokens(reply);
      return reply;
    },
  };
  try {
    const sum = await runProof(result, counted);
    return tokens ? { ...sum, tokens } : sum;
  } finally {
    if (tokens) result.body = addProofTokens(result.body, tokens);
  }
}

async function runProof(result: ReviewResult, d: ProofDeps): Promise<ProofSummary> {
  const { log } = d;
  let tmp: string | null = null;
  try {
    if (result.kind !== "review") return skipped("not a review result");
    const gate = proofGate({ lane: result.lane, paths: d.files.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]), sensitive: d.sensitive });
    if (!gate.run) { log.info(`proof tests: not run (${gate.reason})`); return skipped(gate.reason); }
    if (!d.gitDir || !d.baseSha) { log.info("proof tests: not run (needs a job with a local clone: runner.code_source: local)"); return skipped("no local clone"); }
    const eligible = result.findings.flatMap((f, i) => (f.line !== undefined && !isProofBadged(f.message) && languageOf(f.path) && d.files.find((x) => x.path === f.path)?.status !== "removed" ? [i] : []));
    if (!eligible.length) { log.info("proof tests: not run (no line-anchored finding in a JavaScript or Python file)"); return skipped("no eligible finding"); }
    const sandbox = await d.sandbox();
    if (!sandbox) { log.warn("proof tests: not run (no usable sandbox; needs bubblewrap with unprivileged user namespaces on Linux)"); return skipped("no sandbox"); }

    const signal = AbortSignal.any([...(d.signal ? [d.signal] : []), AbortSignal.timeout(d.totalMs ?? PROOF_TOTAL_MS)]);
    log.info(`proof tests: running (${gate.reason}; sandbox ${sandbox.name}; at most ${d.opts.maxPerPr})`);
    const asked = eligible.map((i) => result.findings[i]!);
    const ip = intentPrompt(d.pr, d.files.map((f) => f.path), asked);
    const intent = parseIntent(await d.llm({ ...ip, schema: INTENT_SCHEMA, maxOutputTokens: 1500 }), asked.length);
    if (!intent) { log.info("proof tests: not run (intent step gave no usable answer)"); return skipped("no intent"); }
    const picked = intent.findings.filter((x) => x.severity === "high" && x.testable).slice(0, d.opts.maxPerPr).map((x) => eligible[x.id]!);
    if (!picked.length) { log.info("proof tests: no high-severity testable finding"); return { ran: true, attempted: 0, proven: 0 }; }

    tmp = mkdtempSync(join(d.tmpRoot ?? tmpdir(), "mjr-proof-"));
    const baseRoot = join(tmp, "base"), headRoot = join(tmp, "head");
    await exportTree(d.gitDir, d.baseSha, baseRoot, d.env, signal);
    await exportTree(d.gitDir, d.headSha, headRoot, d.env, signal);

    const proven: Proven[] = [];
    let attempted = 0;
    for (const index of picked) {
      if (signal.aborted) break;
      const finding = result.findings[index]!;
      const language = languageOf(finding.path)!;
      attempted++;
      try {
        const patch = d.files.find((f) => f.path === finding.path)?.patch ?? "";
        const source = (await d.readFileAt(d.headSha, finding.path).catch(() => null)) ?? "";
        const tp = testPrompt({ language, intent: intent.intent, risk: intent.risk, finding, patch, source });
        const test = parseTest(await d.llm({ ...tp, schema: TEST_SCHEMA, maxOutputTokens: 4000 }));
        if (!test) { log.info(`proof tests: ${finding.path}:${finding.line}: the model declined or returned no test`); continue; }
        const verdict = await proveTest({ sandbox, language, target: { path: finding.path, line: finding.line! }, code: test.code, baseRoot, headRoot, timeoutMs: d.opts.timeoutMs, signal });
        log.info(`proof tests: ${finding.path}:${finding.line}: ${verdict.status} (${verdict.reason})`);
        if (verdict.status === "proven") proven.push({ index, language, code: test.code, asserts: test.asserts });
      } catch (e) {
        log.info(`proof tests: ${finding.path}:${finding.line}: not proven (${(e as Error).message.slice(0, 120)})`);
      }
    }
    if (!proven.length) return { ran: true, attempted, proven: 0 };

    let section = renderProofSection(proven, result.findings, intent, attempted);
    if (result.body.length + section.length > MAX_BODY) section = renderProofSection(proven, result.findings, intent, attempted, false);
    if (result.body.length + section.length > MAX_BODY) { log.warn("proof tests: comment too long for the proof section; badges only"); section = "";
    }
    for (const p of proven) {
      const f = result.findings[p.index]!;
      f.message = `${PROOF_BADGE}${f.message}`.slice(0, MAX_MESSAGE);
    }
    if (section) result.body = insertProofSection(result.body, section);
    return { ran: true, attempted, proven: proven.length };
  } catch (e) {
    log.warn(`proof tests: stopped (${(e as Error).message.slice(0, 160)}); the review is unchanged`);
    return { ran: true, attempted: 0, proven: 0 };
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir cleanup is best effort */ } }
  }
}
