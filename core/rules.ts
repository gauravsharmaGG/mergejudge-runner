import { minimatch } from "minimatch";
import type { Config } from "./config.js";
import { maxLane, type FileVerdict, type Lane, type PrFile } from "./types.js";

const MM = { dot: true, matchBase: false } as const;
export const matchesAny = (path: string, globs: string[]): boolean =>
  globs.some((g) => minimatch(path, g, MM));

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "Cargo.lock",
  "Gemfile.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "go.sum", "uv.lock",
]);
const MANIFESTS = new Set([
  "package.json", "Cargo.toml", "Gemfile", "pyproject.toml", "requirements.txt", "Pipfile",
  "composer.json", "go.mod", "build.gradle", "pom.xml",
]);

export function isDependencyFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return LOCKFILES.has(base) || MANIFESTS.has(base) || /^requirements.*\.txt$/.test(base);
}

const HUGE_LINES = 5000;

/** Source/script extensions that always need a human, even in an auto path and in rules-only mode. */
export const CODE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "astro",
  "py", "go", "rs", "java", "kt", "kts", "scala", "rb", "php", "sh", "bash", "zsh", "ps1",
  "sql", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm", "dart", "lua", "pl",
  "ex", "exs", "erl", "clj", "hs", "r", "wasm",
]);

export function isCodeFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  if (i <= 0) return false;
  return CODE_EXTENSIONS.has(base.slice(i + 1).toLowerCase());
}

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: "hard-coded api key", re: /\bapi[_-]?key\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

// Built at runtime so the literal AWS documentation keys never appear in source or the bundle.
const DOC_KEYS = new Set([
  ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  ["wJalrXUtnFEMI/K7MDENG/", "bPxRfiCYEXAMPLEKEY"].join(""),
]);
const PLACEHOLDER_WORD = /EXAMPLE|PLACEHOLDER|DUMMY|FAKE|XXXX|CHANGEME/i;
const WORD_ONLY = /^[a-z]+(?:[-_][a-z]+)*$/i;
const PLACEHOLDER_WORDS = new Set(["test", "dummy", "fake", "example", "changeme", "placeholder", "sample", "mock", "secret", "redacted"]);

/** An api-key value made only of letter words joined by - or _ (no digits), at least one an obvious placeholder word. */
function isWordPlaceholder(v: string): boolean {
  return WORD_ONLY.test(v) && v.toLowerCase().split(/[-_]/).some((w) => PLACEHOLDER_WORDS.has(w));
}
const RUN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** True for one repeated character, or a straight ascending run (ABCDEF..., 0123...; digits may wrap 9 -> 0). */
function isTrivialBody(body: string): boolean {
  if (body.length < 4) return false;
  if (/^(.)\1*$/.test(body)) return true;
  const idx = [...body.toUpperCase()].map((c) => RUN_ALPHABET.indexOf(c));
  if (idx.includes(-1)) return false;
  const digits = idx.every((i) => i < 10);
  return idx.every((v, i) => i === 0 || v === idx[i - 1]! + 1 || (digits && idx[i - 1] === 9 && v === 0));
}

/** Why a matched secret is an obvious fake, or undefined if it looks real. `body` is the key without its fixed prefix. */
function placeholderKind(value: string, body: string, allowRun: boolean): string | undefined {
  if (DOC_KEYS.has(value)) return "documentation key";
  if (PLACEHOLDER_WORD.test(value)) return "placeholder word";
  if (/^(.)\1*$/.test(body)) return "repeated characters";
  if (allowRun && isTrivialBody(body)) return "sequential characters";
  return undefined;
}

/** Short display form: first 4 chars, an ellipsis, last up-to-7 chars. Only ever used for placeholders. */
function mask(v: string): string {
  return v.length <= 12 ? `${v.slice(0, 4)}…` : `${v.slice(0, 4)}…${v.slice(-7)}`;
}

const isTestPath = (path: string): boolean =>
  /(^|\/)(tests?|__tests__|fixtures?)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path);

interface SecretScan { blocked: string[]; skipped: string[] }

/**
 * Scans added lines of a unified-diff patch. Obvious fake keys (docs keys, EXAMPLE/PLACEHOLDER/DUMMY/FAKE/XXXX,
 * repeated or ascending-run bodies) go to `skipped` instead of `blocked`. A test/fixture path never exempts a
 * real-looking key by itself. Private key blocks are never skipped. GitHub tokens are skipped only for placeholder
 * words or repeated characters (not ascending runs). Api-key values made only of words (no digits) including a
 * test/dummy/fake/example/secret-style word are skipped as test placeholders.
 */
export function scanSecrets(patch: string | undefined, path = ""): SecretScan {
  const blocked = new Set<string>();
  const skipped = new Set<string>();
  if (!patch) return { blocked: [], skipped: [] };
  const where = path && isTestPath(path) ? ", test path" : "";
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const p of SECRET_PATTERNS) {
      for (const m of line.matchAll(new RegExp(p.re.source, p.re.flags + "g"))) {
        let kind: string | undefined;
        let shown = "";
        if (p.name === "AWS access key") {
          kind = placeholderKind(m[0], m[0].slice(4), true);
          shown = mask(m[0]);
        } else if (p.name === "GitHub token") {
          kind = placeholderKind(m[0], m[0].slice(m[0].indexOf("_") + 1), false);
          shown = mask(m[0]);
        } else if (p.name === "hard-coded api key") {
          const v = m[0].replace(/^[^"']*["']/, "").slice(0, -1);
          kind = placeholderKind(v, v, true) ?? (isWordPlaceholder(v) ? "test placeholder" : undefined);
          shown = mask(v);
        }
        if (kind) skipped.add(`placeholder secret skipped: ${shown} (${kind}${where})`);
        else blocked.add(p.name);
      }
    }
  }
  return { blocked: [...blocked], skipped: [...skipped] };
}

/** Returns names of (non-placeholder) secret patterns found in added lines of a unified-diff patch. */
export function findSecrets(patch: string | undefined, path = ""): string[] {
  return scanSecrets(patch, path).blocked;
}

/**
 * Known safety guards. A protected-path change that REMOVES one (a `-` line) without the same guard reappearing in an
 * added line of that file (so moves and reformatting do not trigger) is raised to block — except in YAML, where a guard
 * deleted together with the whole step or job that carried it is not a weakening: the guarded action no longer exists.
 * Curated and narrow on purpose.
 */
export const SAFETY_GUARDS: { name: string; why: string; re: RegExp }[] = [
  { name: "--match-head-commit", why: "merge-safety guard", re: /--match-head-commit\b/ },
  { name: "persist-credentials: false", why: "checkout credential guard", re: /\bpersist-credentials\s*:\s*["']?false\b/ },
  { name: "set -e", why: "shell fail-fast guard", re: /^\s*(?:run\s*:\s*)?set\s+-[a-z]*e[a-z]*(?:\s|$)/ },
  { name: "--frozen-lockfile", why: "dependency-integrity guard", re: /--frozen-lockfile\b|\bnpm\s+ci\b/ },
];

/** One content line of a unified-diff patch. GitHub's file.patch starts at the first @@ hunk (no ---/+++ headers). */
interface PatchLine { op: "ctx" | "del" | "add"; text: string; hunk: number }

function parsePatchLines(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let hunk = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) hunk++;
    // A "---..." line is a removed line starting with "--" (no headers in GitHub's patch); "\ No newline" carries no content.
    else if (line.startsWith("-")) out.push({ op: "del", text: line.slice(1), hunk });
    else if (line.startsWith("+")) out.push({ op: "add", text: line.slice(1), hunk });
    else if (line.startsWith(" ")) out.push({ op: "ctx", text: line.slice(1), hunk });
  }
  return out;
}

/** Leading spaces of a YAML line; undefined for blank lines and anything tab-tainted (structure not decidable). */
function yamlIndent(text: string): number | undefined {
  const m = /^( *)\S/.exec(text);
  return m ? m[1]!.length : undefined;
}

/** A YAML sequence item (`- uses: ...`, `- name: x`, a bare `-`): the start of a step-like block. */
const isListItemStart = (text: string): boolean => /^ *-(?: |$)/.test(text);

/** A YAML mapping key that opens a nested block (`label:`, `steps:`, `if: >-`): after the colon only an optional
 * block-scalar indicator or comment, never a value. */
function isBlockKey(text: string): boolean {
  if (isListItemStart(text)) return false;
  const i = text.indexOf(":");
  if (i < 1 || /[#{}\[\],&*!|>'"@`]/.test(text.slice(0, i))) return false;
  return /^:(\s*(?:[|>][+-]?\d*)?)(\s+#.*)?$/.test(text.slice(i));
}

/** True when the block-key line at `j` opens a block that itself contains a sequence (`steps:`), i.e. it is a job-like
 * container rather than a leaf mapping such as `with:` or `env:`. */
function opensStepContainer(lines: PatchLine[], j: number): boolean {
  const h = yamlIndent(lines[j]!.text)!;
  for (let k = j + 1; k < lines.length && lines[k]!.hunk === lines[j]!.hunk; k++) {
    const ind = yamlIndent(lines[k]!.text);
    if (ind === undefined) continue;
    if (ind <= h) return false;
    if (isListItemStart(lines[k]!.text)) return true;
  }
  return false;
}

/** True when the block opened at `j` (a step or job header) is removed whole: the guard line `g` is one of its `-`
 * lines, every other line of the block up to the first line at or below the header's indent is also removed, no `+`
 * line lands inside it, and the block's end is visible in the same hunk (a block running past the hunk is
 * unverifiable, so it does not count). */
function blockRemovedWhole(lines: PatchLine[], j: number, g: number): boolean {
  const h = yamlIndent(lines[j]!.text)!;
  let sawGuard = j === g;
  for (let k = j + 1; k < lines.length && lines[k]!.hunk === lines[j]!.hunk; k++) {
    const e = lines[k]!;
    if (e.op === "add") return false; // new content lands inside the block
    const ind = yamlIndent(e.text);
    if (ind === undefined) continue; // blank line: belongs to no block
    if (ind <= h) return sawGuard; // block ended cleanly at a shallower line
    if (e.op === "ctx") return false; // part of the block survives
    if (k === g) sawGuard = true;
  }
  return false;
}

/** True when the removed guard line at `i` went away together with the whole YAML step or job that carried it (the
 * guarded action no longer exists), so its removal weakens nothing. The header must sit in the same contiguous run of
 * removed lines: a context or added line in between means part of that block survived. */
function guardRemovedWithItsBlock(lines: PatchLine[], i: number): boolean {
  const guard = yamlIndent(lines[i]!.text);
  if (guard === undefined) return false;
  for (let j = i; j >= 0 && lines[j]!.op === "del" && lines[j]!.hunk === lines[i]!.hunk; j--) {
    const text = lines[j]!.text;
    const h = yamlIndent(text);
    if (h === undefined || (j < i && h >= guard)) continue; // blank, or not an enclosing header
    const isStep = isListItemStart(text);
    if (!isStep && !(isBlockKey(text) && opensStepContainer(lines, j))) continue;
    if (blockRemovedWhole(lines, j, i)) return true;
  }
  return false;
}

/**
 * Names of safety guards removed (and not re-added) by a unified-diff patch. In YAML files a guard whose every removed
 * occurrence went away together with its whole step or job (see guardRemovedWithItsBlock) does not count as removed.
 * Non-YAML files keep the plain removed-without-readded rule; unverifiable shapes stay flagged (a false block is
 * acceptable, a missed weakening is not).
 */
export function findRemovedGuards(patch: string | undefined, path = ""): string[] {
  if (!patch) return [];
  const lines = parsePatchLines(patch);
  const added = lines.filter((l) => l.op === "add").map((l) => l.text);
  const yaml = /\.ya?ml$/i.test(path);
  return SAFETY_GUARDS.filter((g) =>
    !added.some((l) => g.re.test(l)) &&
    lines.some((l, i) => l.op === "del" && g.re.test(l.text) && (!yaml || !guardRemovedWithItsBlock(lines, i))),
  ).map((g) => g.name);
}

/**
 * Application-level authorization checks (role / permission / login guards). Deliberately broad and review-only: a
 * code file that loses one of these (a removed line matching, with no added line matching anywhere in the file, so moves
 * and reformatting do not trigger) cannot be auto, with or without an AI. Unlike SAFETY_GUARDS this is a heuristic, so
 * it raises to review, never block.
 */
const AUTH_CHECK = /\b(?:requireRole|requireAuth\w*|requireAdmin|requirePermission|isAdmin|isSuperuser|isOwner|hasRole|hasPermission|checkPermission|checkAuth\w*|assertAuth\w*|ensureAuth\w*|authorize|authorise|verifyToken|can[A-Z]\w*)\s*\(|\b(?:role|userRole|user\.role|isAdmin)\s*[!=]==?\s*[\w"'`]|\bpermissions?\.(?:includes|has|some)\(|@(?:RolesAllowed|PreAuthorize|Secured|login_required|permission_required)\b|\bAuthGuard\b|\bRolesGuard\b/;

/** True when the patch removes an authorization check and no added line contains one (see AUTH_CHECK). */
export function removesAuthCheck(patch: string | undefined): boolean {
  if (!patch) return false;
  const lines = parsePatchLines(patch);
  if (lines.some((l) => l.op === "add" && AUTH_CHECK.test(l.text))) return false;
  return lines.some((l) => l.op === "del" && AUTH_CHECK.test(l.text));
}

/**
 * True for MergeJudge's own config file: basename `.mergejudge.yml` or `.mergejudge.yaml` (case-insensitive) in any
 * directory, or one of `extra` (a custom config path, compared case-insensitively without a leading `./`).
 */
export function isMergeJudgeConfigPath(path: string, extra: readonly string[] = []): boolean {
  const norm = (p: string) => p.replace(/^\.\//, "").toLowerCase();
  const base = norm(path).split("/").pop() ?? "";
  if (base === ".mergejudge.yml" || base === ".mergejudge.yaml") return true;
  return extra.some((e) => e && norm(e) === norm(path));
}

/** Never code_auto candidates, whatever the config says: CI/workflow files, env files, shell/SQL/wasm. */
const CODE_AUTO_NEVER_GLOBS = [".github/**", "**/.env*", "_headers", "**/_headers"];
/** Hosting header files (CSP, CORS, caching) are always at least review, even if a repo config drops them from lanes.protected. */
const ALWAYS_REVIEW_GLOBS = ["_headers", "**/_headers"];
const CODE_AUTO_NEVER_EXT = new Set(["sql", "sh", "bash", "zsh", "ps1", "wasm"]);

/** Why a code file cannot be a code_auto candidate (undefined = it can). Rules only; the AI decides the rest. */
function codeAutoBlocker(file: PrFile, paths: string[], changed: number, ca: Config["lanes"]["code_auto"]): string | undefined {
  if (file.status === "removed" || file.status === "renamed" || file.previousPath) return "code file deleted or renamed (needs human review)";
  if (file.status !== "added" && file.status !== "modified") return `code file with status ${file.status} (needs human review)`;
  if (paths.some((p) => matchesAny(p, CODE_AUTO_NEVER_GLOBS) || CODE_AUTO_NEVER_EXT.has(p.split(".").pop()!.toLowerCase())))
    return "code file type never eligible for lanes.code_auto (CI, env, headers, shell, SQL, wasm)";
  if (ca.paths.length && !matchesAny(file.path, ca.paths)) return "code file outside lanes.code_auto.paths";
  if (changed > ca.max_lines) return `code file with ${changed} changed lines (lanes.code_auto.max_lines ${ca.max_lines})`;
  return undefined;
}

export function classifyFile(file: PrFile, cfg: Config, extraConfigPaths: readonly string[] = []): FileVerdict {
  const v = classifyFileInner(file, cfg, extraConfigPaths);
  const skipped = scanSecrets(file.patch, file.path).skipped;
  return skipped.length ? { ...v, reasons: [...v.reasons, ...skipped] } : v;
}

function classifyFileInner(file: PrFile, cfg: Config, extraConfigPaths: readonly string[]): FileVerdict {
  let lane: Lane = "auto";
  const reasons: string[] = [];
  const raise = (l: Lane, r: string) => {
    lane = maxLane(lane, l);
    reasons.push(r);
  };
  const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];

  const secrets = findSecrets(file.patch, file.path);
  if (secrets.length) raise("block", `possible secret in added lines (${secrets.join(", ")})`);

  // A PR that changes MergeJudge's own config can loosen every rule below, so it never goes auto (added, modified,
  // removed or renamed, either side). Raised before the auto-path and code_auto branches, which only run while lane is "auto".
  const configFile = paths.some((p) => isMergeJudgeConfigPath(p, extraConfigPaths));
  if (configFile) raise("review", "MergeJudge config file (.mergejudge.yml): always needs human review");

  const isProtected = paths.some((p) => matchesAny(p, cfg.lanes.protected));
  if (isProtected) {
    raise("review", "protected path");
    const gone = findRemovedGuards(file.patch, file.path);
    for (const g of SAFETY_GUARDS.filter((g) => gone.includes(g.name)))
      raise("block", `removes ${g.why} \`${g.name}\` from a protected path`);
  }
  if (!isProtected && paths.some((p) => matchesAny(p, ALWAYS_REVIEW_GLOBS))) raise("review", "protected path (hosting headers file)");
  // Code files always need review, unless lanes.code_auto is on: then a clean small one becomes a candidate (below).
  const ca = cfg.lanes.code_auto;
  const codeCandidate = !!ca?.enabled && paths.some(isCodeFile);
  if (!codeCandidate && paths.some(isCodeFile)) raise("review", "code file (always needs human review)");
  if (paths.some(isCodeFile) && removesAuthCheck(file.patch)) raise("review", "removes an authorization or role check (needs human review)");
  if (isDependencyFile(file.path)) raise("review", "dependency manifest or lockfile change");

  const changed = file.additions + file.deletions;
  if (!file.patch && file.status === "removed") raise("review", "removed binary or very large file");
  else if (!file.patch && file.status !== "renamed") raise("review", "no diff available (binary or very large file)");
  else if (changed > HUGE_LINES) raise("review", `very large change (${changed} lines)`);

  if (codeCandidate) {
    const blocker = lane === "auto" ? codeAutoBlocker(file, paths, changed, ca!) : "code file (needs human review)";
    if (blocker || lane !== "auto") raise("review", blocker ?? "code file (needs human review)");
    else return { path: file.path, lane: "review", reasons: [`code file eligible for lanes.code_auto (${changed} changed lines); stays review unless the AI explicitly says auto`], autoCandidate: true };
  } else if (lane === "auto") {
    if (matchesAny(file.path, cfg.lanes.auto)) {
      if (changed > cfg.lanes.max_auto_lines)
        raise("review", `auto-eligible path but ${changed} lines changed (limit ${cfg.lanes.max_auto_lines})`);
      else reasons.push("docs/style/static path, small change");
    } else {
      raise("review", "not in an auto-merge path");
    }
  }
  return { path: file.path, lane, reasons, ...(configFile ? { configFile: true } : {}) };
}

export function classifyFiles(files: PrFile[], cfg: Config, extraConfigPaths: readonly string[] = []): FileVerdict[] {
  const out = files.map((f) => classifyFile(f, cfg, extraConfigPaths));
  // PR-wide cap: too many changed lines over all candidates and none of them is a candidate.
  const ca = cfg.lanes.code_auto;
  if (ca?.enabled) {
    const lines = (i: number) => files[i]!.additions + files[i]!.deletions;
    const total = out.reduce((n, v, i) => n + (v.autoCandidate ? lines(i) : 0), 0);
    if (total > ca.max_total_lines)
      return out.map((v) => v.autoCandidate
        ? { path: v.path, lane: "review", reasons: [`code_auto: ${total} changed lines over candidate code files (lanes.code_auto.max_total_lines ${ca.max_total_lines})`] }
        : v);
  }
  return out;
}

/** Held labels: returns the minimum lane forced by labels plus reasons. */
export function labelLane(labels: string[], cfg: Config): { lane: Lane; reasons: string[] } {
  const lower = labels.map((l) => l.toLowerCase());
  const has = (set: string[]) => set.filter((s) => lower.includes(s.toLowerCase()));
  const b = has(cfg.labels.block);
  if (b.length) return { lane: "block", reasons: b.map((l) => `label \`${l}\` holds this PR`) };
  const r = has(cfg.labels.review);
  if (r.length) return { lane: "review", reasons: r.map((l) => `label \`${l}\` requires review`) };
  return { lane: "auto", reasons: [] };
}

/** Paths matching any exclude glob are kept for rule-laning but omitted from the LLM prompt. */
export function excludeFromLlm<T extends { path: string }>(files: T[], globs: string[]): { kept: T[]; skipped: string[] } {
  if (!globs.length) return { kept: files, skipped: [] };
  const skipped: string[] = [];
  const kept = files.filter((f) => {
    const hit = globs.some((g) => minimatch(f.path, g, { dot: true }));
    if (hit) skipped.push(f.path);
    return !hit;
  });
  return { kept, skipped };
}
