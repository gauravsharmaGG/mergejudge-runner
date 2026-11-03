import { keyOf } from "./inline.js";
import type { Finding } from "./triage.js";

/** One MergeJudge inline thread as the answer check sees it. */
export interface FindingThread {
  rootId: number;
  key: string;
  path: string;
  state: "active" | "resolved";
  isResolved: boolean;
  replies: { author: string | null; isBot: boolean; body: string }[];
}

/** Shortest reply (quoted lines and spaces removed) that counts as a reason. */
export const MIN_REASON_CHARS = 8;

const reasonText = (body: string) => body.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();

/** Answered = resolved by anyone, or a human replied with a reason. Bot replies never count. */
export function isAnswered(t: FindingThread): boolean {
  if (t.isResolved) return true;
  return t.replies.some((r) => !r.isBot && reasonText(r.body).length >= MIN_REASON_CHARS);
}

/**
 * Inline findings nobody answered: current findings with a line whose thread is missing or unanswered, plus active
 * unanswered threads on `keepPaths` (files not re-reviewed this round, so their findings stay open).
 */
export function unansweredFindings(findings: Finding[], threads: FindingThread[], keepPaths: ReadonlySet<string>): { open: number; keys: string[] } {
  const byKey = new Map<string, FindingThread>();
  for (const t of threads) if (!byKey.has(t.key)) byKey.set(t.key, t);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (f.line === undefined) continue;
    const key = keyOf(f.path, f.line);
    if (seen.has(key)) continue;
    seen.add(key);
    const t = byKey.get(key);
    // A thread the bot already rewrote as resolved is reopened with the new finding, so it needs a fresh answer.
    if (!t || t.state === "resolved" || !isAnswered(t)) keys.push(key);
  }
  for (const t of threads) {
    if (t.state !== "active" || !keepPaths.has(t.path) || seen.has(t.key)) continue;
    seen.add(t.key);
    if (!isAnswered(t)) keys.push(t.key);
  }
  return { open: keys.length, keys };
}

export const ROUNDS_MARKER = "<!-- mergejudge:rounds";

export const renderRoundsMarker = (n: number, sha: string): string => `${ROUNDS_MARKER} n=${n} sha=${sha} -->`;

export function parseRoundsMarker(body: string | undefined): { n: number; sha: string } | null {
  const m = body?.match(/<!-- mergejudge:rounds n=(\d{1,4}) sha=([0-9a-f]{7,40}) -->/);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 1000 ? { n, sha: m[2]! } : null;
}

/** Round number of this head: first review is 1, a re-run on the same head keeps the number, a new head adds one. */
export function nextRound(prev: { n: number; sha: string } | null, headSha: string): number {
  if (!prev) return 1;
  return prev.sha === headSha ? prev.n : prev.n + 1;
}
