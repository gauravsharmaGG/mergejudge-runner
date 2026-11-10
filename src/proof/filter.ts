/** Static rule filter for a generated proof test: runs before anything executes. The sandbox is the enforcement; this removes tests that obviously need more than it allows. */

export type Language = "javascript" | "python";

export const MAX_TEST_BYTES = 8000;
export const MAX_TEST_LINES = 160;

export function languageOf(path: string): Language | null {
  if (/\.(?:[cm]?js|jsx)$/i.test(path)) return "javascript";
  if (/\.py$/i.test(path)) return "python";
  return null;
}

const ABS_PATH = /["'`]\/(?:etc|home|root|usr|var|proc|sys|dev|tmp|Users|opt|mnt|run|private)\b/;

const JS_DENY: [RegExp, string][] = [
  [/(?:from|import|require)\s*\(?\s*["'](?:node:)?(?:https?|http2|net|tls|dgram|dns(?:\/promises)?|child_process|worker_threads|cluster|vm|inspector|repl)["']/, "imports a network or process module"],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, "uses a network API"],
  [/\b(?:eval|Function)\s*\(|\bprocess\s*\.\s*(?:binding|dlopen|kill|chdir|abort|exit)\b/, "uses eval or process control"],
  [/\b(?:write|append)File(?:Sync)?\b|\bmkdtemp(?:Sync)?\b|\bmkdir(?:Sync)?\b|\brmSync\b|\brmdir(?:Sync)?\b|\.rm\s*\(|\bunlink(?:Sync)?\b|\brename(?:Sync)?\b|\bcopyFile(?:Sync)?\b|\bcreateWriteStream\b|\bsymlink(?:Sync)?\b|\bchmod(?:Sync)?\b|\bchown(?:Sync)?\b|\btruncate(?:Sync)?\b|\butimes(?:Sync)?\b/, "writes to the filesystem"],
  [ABS_PATH, "refers to an absolute system path"],
];

const PY_DENY: [RegExp, string][] = [
  [/^\s*(?:import|from)\s+(?:socket|ssl|urllib|http|ftplib|smtplib|telnetlib|requests|httpx|aiohttp|subprocess|multiprocessing|ctypes|asyncio|shutil|pty)\b/m, "imports a network or process module"],
  [/\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*|fork|remove|unlink|rmdir|removedirs|rename|replace|mkdir|makedirs|chmod|chown|symlink|link|kill|chdir)\b/, "uses os process or filesystem calls"],
  [/\b(?:eval|exec|compile|__import__)\s*\(/, "uses eval or dynamic import"],
  [/\bopen\s*\([^)]*["'][^"']*[wax+][^"']*["']/, "opens a file for writing"],
  [ABS_PATH, "refers to an absolute system path"],
];

export interface FilterResult { ok: boolean; reasons: string[] }

export function filterTestSource(language: Language, code: string): FilterResult {
  const reasons: string[] = [];
  if (!code.trim()) return { ok: false, reasons: ["empty test"] };
  if (Buffer.byteLength(code) > MAX_TEST_BYTES || code.split("\n").length > MAX_TEST_LINES) reasons.push(`test is longer than ${MAX_TEST_LINES} lines / ${MAX_TEST_BYTES} bytes`);
  if (code.includes("\0")) reasons.push("test contains a NUL byte");
  if (language === "javascript") {
    if (!/["']node:test["']/.test(code)) reasons.push("does not use node:test");
    if (!/\bassert\b/.test(code)) reasons.push("has no assertion");
  } else {
    if (!/\bunittest\b/.test(code)) reasons.push("does not use unittest");
    if (!/\bassert\w*\b/.test(code)) reasons.push("has no assertion");
  }
  for (const [re, why] of language === "javascript" ? JS_DENY : PY_DENY) if (re.test(code)) reasons.push(why);
  return { ok: reasons.length === 0, reasons };
}
