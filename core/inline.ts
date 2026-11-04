import type { Finding } from "./triage.js";
import { escapeMd } from "./render.js";

export const INLINE_MARKER = "<!-- mergejudge:inline";
export const keyOf = (path: string, line: number) => `${path}:${line}`;
const pathOfKey = (key: string) => key.slice(0, key.lastIndexOf(":"));

/** Longest finding text kept in a resolved comment's hidden marker. */
export const ORIG_MAX_CHARS = 200;

/** Where and by whom a finding is posted or resolved: lets a later harvest tell "code changed" from "reviewer changed". */
export interface InlineCtx {
  /** Head commit of the run. */
  sha?: string;
  /** Reviewer id of the run (engine / model label). Compared for equality only. */
  reviewer?: string;
}

const tok = (s: string | undefined) => (s ?? "").replace(/[^A-Za-z0-9._:/@+-]/g, "_").slice(0, 60);
const attrs = (a: Record<string, string | undefined>) =>
  Object.entries(a).filter(([, v]) => v).map(([k, v]) => ` ${k}=${encodeURIComponent(v!)}`).join("");
const marker = (key: string, state: "active" | "resolved", extra: Record<string, string | undefined> = {}) =>
  `${INLINE_MARKER} key=${encodeURIComponent(key)} state=${state}${attrs(extra)} -->`;

/** Message text of one of our inline comments (marker and prefix removed, markdown escapes undone). */
export function findingText(body: string): string {
  return body.replace(/\n*```suggestion\n[\s\S]*?\n```/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(?:⚖️\s*)?\*\*MergeJudge \((?:LLM|AI)\):\*\*\s*/, "").replace(/\\([\\`*_{}\[\]()#+\-.!|<>~])/g, "$1").trim();
}

export function inlineBody(f: Finding & { line: number }, ctx: InlineCtx = {}): string {
  return `${marker(keyOf(f.path, f.line), "active", { sha: tok(ctx.sha), rv: tok(ctx.reviewer) })}\n⚖️ **MergeJudge (AI):** ${escapeMd(f.message)}${f.suggestion ? `\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : ""}`;
}

/**
 * The rewritten root of a finding that is no longer flagged. The original text and the posting/resolving context stay in
 * the hidden marker (URL-encoded, so it cannot close the HTML comment), because the visible text is replaced.
 */
export function resolvedBody(key: string, prev: { text?: string; sha?: string; rv?: string } = {}, ctx: InlineCtx = {}): string {
  const orig = (prev.text ?? "").replace(/\s+/g, " ").trim().slice(0, ORIG_MAX_CHARS);
  const m = marker(key, "resolved", { sha: tok(prev.sha), rv: tok(prev.rv), sha2: tok(ctx.sha), rv2: tok(ctx.reviewer), orig });
  return `${m}\n✅ ~~MergeJudge finding~~ — no longer flagged on the latest run.`;
}

export interface InlineMarker {
  key: string;
  state: string;
  /** Head when the finding was posted, and the reviewer that posted it. */
  sha?: string;
  rv?: string;
  /** Head and reviewer of the run that resolved it. */
  sha2?: string;
  rv2?: string;
  /** Original finding text (resolved comments only). */
  orig?: string;
}

const dec = (s: string | undefined) => {
  if (s === undefined) return undefined;
  try { return decodeURIComponent(s); } catch { return undefined; }
};

export function parseMarker(body: string | undefined): InlineMarker | null {
  const m = body?.match(/<!-- mergejudge:inline key=(\S+) state=(active|resolved)((?: [a-z0-9]+=\S*)*) -->/);
  if (!m) return null;
  const out: InlineMarker = { key: decodeURIComponent(m[1]!), state: m[2]! };
  for (const a of m[3]!.matchAll(/ ([a-z0-9]+)=(\S*)/g)) {
    const k = a[1]!;
    if (k === "sha" || k === "rv" || k === "sha2" || k === "rv2" || k === "orig") {
      const v = dec(a[2]);
      if (v) out[k] = v;
    }
  }
  return out;
}

export interface ExistingComment { id: number; body?: string; isBot: boolean }
export interface InlinePlan {
  create: { path: string; line: number; body: string }[];
  update: { id: number; body: string; thread?: "resolve" | "unresolve" }[];
}

const stripMarker = (b: string | undefined) => (b ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();

/**
 * Dedupe by path:line. Existing → update in place; vanished → mark resolved; new → create.
 * An unchanged finding keeps its comment (and so the head/reviewer it was first posted with).
 */
export function planInline(findings: Finding[], existing: ExistingComment[], ctx: InlineCtx = {}, keepPaths: ReadonlySet<string> = new Set()): InlinePlan {
  const mine = new Map<string, ExistingComment>();
  for (const c of existing) {
    if (!c.isBot) continue;
    const m = parseMarker(c.body);
    if (m && !mine.has(m.key)) mine.set(m.key, c);
  }
  // Comments on files that were not re-reviewed this round stay exactly as they are: not updated, not resolved.
  if (keepPaths.size) for (const [key, c] of mine) if (keepPaths.has(pathOfKey(key))) mine.delete(key);
  const plan: InlinePlan = { create: [], update: [] };
  const wanted = new Set<string>();
  for (const f of findings) {
    if (f.line === undefined || keepPaths.has(f.path)) continue;
    const key = keyOf(f.path, f.line);
    if (wanted.has(key)) continue;
    wanted.add(key);
    const body = inlineBody({ ...f, line: f.line }, ctx);
    const ex = mine.get(key);
    if (!ex) plan.create.push({ path: f.path, line: f.line, body });
    else if (parseMarker(ex.body)?.state === "resolved") plan.update.push({ id: ex.id, body, thread: "unresolve" });
    else if (stripMarker(ex.body) !== stripMarker(body)) plan.update.push({ id: ex.id, body });
  }
  for (const [key, c] of mine) {
    if (wanted.has(key)) continue;
    const m = parseMarker(c.body);
    if (m?.state !== "resolved") plan.update.push({ id: c.id, body: resolvedBody(key, { text: findingText(c.body ?? ""), sha: m?.sha, rv: m?.rv }, ctx), thread: "resolve" });
  }
  return plan;
}
