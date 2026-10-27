import type { PrFile } from "./types.js";

interface Stack {
  name: string;
  match: (path: string) => boolean;
  rules: string[];
}

const ext = (re: RegExp) => (p: string) => re.test(p);

const STACKS: Stack[] = [
  {
    name: "TS/JS/React",
    match: ext(/\.(?:[cm]?[jt]sx?|vue)$/i),
    rules: [
      "promises not awaited inside try/catch or loops",
      "stale closures; hooks called conditionally",
      "JSON.parse / res.json() without error handling",
      "`!val` truthiness where 0 or \"\" is valid",
    ],
  },
  {
    name: "Python",
    match: ext(/\.py$/i),
    rules: [
      "mutable default arguments",
      "blocking I/O or sleep inside async def",
      "bare except / BaseException",
      "f-string built SQL or shell commands",
      "generator or iterator consumed twice",
    ],
  },
  {
    name: "Go",
    match: ext(/\.go$/i),
    rules: [
      "goroutine/channel leaks with no ctx.Done()",
      "defer inside loops",
      "WaitGroup/Mutex copied, or Lock without Unlock",
      "nil interface vs typed nil",
      "unclosed Body/Rows",
    ],
  },
  {
    name: "Rust/C/C++/Java/Kotlin",
    match: ext(/\.(?:rs|c|cc|cpp|h|hpp|java|kt)$/i),
    rules: [
      "use-after-free, dangling refs, lock-order inversion",
      "unwrap/expect on untrusted input",
      "resource leak on early return",
      "equals/hashCode mismatch; null dereference",
    ],
  },
  {
    name: "GitHub Actions",
    match: ext(/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i),
    rules: [
      "`${{ github.event.* }}` interpolated in run: scripts (pass via env:)",
      "permissions: write-all; pull_request_target checking out untrusted code",
    ],
  },
  {
    name: "SQL/migrations",
    match: (p) => /\.sql$/i.test(p) || /(?:^|\/)migrat(?:ions|e)\//i.test(p),
    rules: [
      "NOT NULL column added without DEFAULT",
      "foreign keys without an index",
      "lock-heavy DDL inside a transaction",
    ],
  },
];

/** Short checklists for the stacks whose paths appear in the PR; empty string when none match. */
export function buildLanguageRulesPrompt(files: readonly PrFile[]): string {
  const paths = files.map((f) => f.path);
  const active = STACKS.filter((s) => paths.some(s.match));
  if (!active.length) return "";
  const body = active.map((s) => `- ${s.name}: ${s.rules.join("; ")}`).join("\n");
  return `\n\nLanguage checklists (only for stacks in this PR; report one only when the visible diff shows it, with a quote):\n${body}`;
}
