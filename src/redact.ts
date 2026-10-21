/**
 * Log hygiene shared by the runner logger and the GitHub Action. Logs are ids, repo/PR numbers, durations
 * and sizes. This masks anything that slips through: tokens, auth headers, emails, PEM blocks, and long
 * base64 or hex secrets. A prompt, a diff or a model reply is replaced whole so none of it is printed.
 */
const PATTERNS: RegExp[] = [
  /mjr_[ea]_[A-Za-z0-9_-]{6,}/g, // MergeJudge runner / enrollment tokens
  /sk-ant-[A-Za-z0-9_-]{6,}/g, // Anthropic keys and OAuth tokens
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\s*[:=]\s*[^,\s"]+/gi,
  /\b(ANTHROPIC_[A-Z_]+|MERGEJUDGE_[A-Z_]*(?:TOKEN|KEY|SECRET)[A-Z_]*|CLAUDE_CODE_OAUTH_TOKEN)=\S+/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{8,}\b/g, // z.ai API keys (<32 hex>.<secret>)
  /\b(ZAI_[A-Z_]*|OPENAI_[A-Z_]*|CODEX_[A-Z_]*(?:KEY|TOKEN)[A-Z_]*)=\S+/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email
  /(?<![A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![A-Za-z0-9+/])/g, // long standard base64 (40+ chars; padding is not a word char)
  /\b(?:[A-Za-z0-9_-]{4}){12,}\b/g, // long url-safe token (48+ chars)
  /\b[0-9a-fA-F]{32,}\b/g, // long hex (specific key shapes above run first)
];

export const REDACTED = "[redacted]";

const MAX_LOG_CHARS = 4_000;

/** A prompt, unified diff or model JSON reply. The whole line is dropped; a prefix would still be customer code. */
function mustDrop(text: string): boolean {
  if (text.length > MAX_LOG_CHARS) return true;
  if (text.includes("diff --git ") || /@@ -\d+(?:,\d+)? \+\d+/.test(text)) return true;
  if (/<\/?untrusted_pr_data>/i.test(text)) return true;
  if (text.includes("You are MergeJudge, a pull request risk triager")) return true;
  if (/"summary"\s*:/.test(text) && /"lane"\s*:/.test(text) && /"files"\s*:/.test(text)) return true;
  return false;
}

/** Masks token-shaped strings plus every literal in `secrets` (ignored when shorter than 6 chars). */
export function redact(text: string, secrets: readonly string[] = []): string {
  if (mustDrop(text)) return REDACTED;
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join(REDACTED);
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export interface LogFns {
  info(message: string): void;
  warning(message: string): void;
}

/** `@actions/core` info/warning (and any other pair of log functions) with the same redaction as the runner logger. */
export function redactedLogs(sink: LogFns, secrets: readonly string[] = []): LogFns {
  return {
    info: (m) => sink.info(redact(m, secrets)),
    warning: (m) => sink.warning(redact(m, secrets)),
  };
}

/** What `status` shows of a token: the first characters only. */
export const tokenPrefix = (t: string): string => (t ? `${t.slice(0, 10)}…` : "(none)");

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export interface Logger {
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
}

export function createLogger(write: (line: string) => void, secrets: () => readonly string[] = () => [], now: () => Date = () => new Date()): Logger {
  const emit = (level: string, msg: string, f?: LogFields) => {
    const kv = f ? Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}=${typeof v === "string" && /[\s"]/.test(v) ? JSON.stringify(v) : String(v)}`).join("") : "";
    write(redact(`${now().toISOString()} ${level} ${msg}${kv}`, secrets()));
  };
  return { info: (m, f) => emit("INFO", m, f), warn: (m, f) => emit("WARN", m, f), error: (m, f) => emit("ERROR", m, f) };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
