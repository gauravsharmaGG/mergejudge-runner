/**
 * Bounded calls to model HTTP APIs (and the Workers AI binding, which has no status codes of its own).
 * Each attempt is aborted with AbortController. Retries cover only network errors, timeouts, HTTP 408,
 * 429 and 5xx, with exponential backoff, equal jitter, and Retry-After capped by `maxDelayMs`.
 * 4xx auth and validation responses are not retried. Failure bodies are never read and never attached
 * to the error: logs and PR comments get the class, provider id and status only.
 *
 * Defaults: 120s per attempt, at most 1 retry after an attempt times out, up to 2 retries for network
 * errors, HTTP 408, 429 and 5xx, and 240s for one call including retries and waits. A diff review makes
 * one or two calls. Deep mode stops tool use at `deep.max_seconds` (120s default) and caps every model
 * call so the whole deep loop ends within `deep.max_seconds` + DEEP_FINISH_MS (240s): 6 minutes by default,
 * inside the runner's 10-minute job and a Worker invocation. Schema caps are 180s per attempt and 300s
 * for the whole call.
 */

export const LLM_HTTP_DEFAULTS = {
  timeoutMs: 120_000,
  maxRetries: 2,
  maxTimeoutRetries: 1,
  backoffMs: 200,
  maxDelayMs: 4_000,
  budgetMs: 240_000,
} as const;

export const LLM_HTTP_LIMITS = {
  timeoutMs: [1_000, 180_000],
  maxRetries: [0, 4],
  maxTimeoutRetries: [0, 4],
  backoffMs: [0, 5_000],
  maxDelayMs: [0, 10_000],
  budgetMs: [1_000, 300_000],
} as const;

export type LlmErrorClass = "timeout" | "network" | "http_429" | "http_5xx" | "http_4xx" | "parse" | "schema";

export interface LlmFailure {
  errorClass: LlmErrorClass;
  provider?: string;
  status?: number;
}

export class LlmError extends Error {
  readonly errorClass: LlmErrorClass;
  readonly provider?: string;
  readonly status?: number;
  /** Retry-After in ms, already capped. Omitted from the message so it cannot carry a body. */
  readonly retryAfterMs: number | null;
  constructor(errorClass: LlmErrorClass, info: { provider?: string; status?: number; retryAfterMs?: number | null } = {}) {
    super(formatLlmFailure({ errorClass, provider: info.provider, status: info.status }));
    this.name = "LlmError";
    this.errorClass = errorClass;
    this.provider = info.provider;
    this.status = info.status;
    this.retryAfterMs = info.retryAfterMs ?? null;
  }
}

/** Log line: class, provider id and status. No response body and no model text. */
export function formatLlmFailure(f: LlmFailure): string {
  const parts = [`class=${f.errorClass}`];
  if (f.provider) parts.push(`provider=${f.provider}`);
  if (typeof f.status === "number") parts.push(`status=${f.status}`);
  return parts.join(" ");
}

export function httpErrorClass(status: number): LlmErrorClass {
  if (status === 429) return "http_429";
  if (status === 408) return "timeout";
  if (status >= 500 && status <= 599) return "http_5xx";
  return "http_4xx";
}

/** Our own per-attempt abort fired (not an HTTP 408 from the provider). Limited by `maxTimeoutRetries`. */
export function isAttemptTimeout(e: LlmError): boolean {
  return e.errorClass === "timeout" && e.status === undefined;
}

export function isRetryableLlmError(e: LlmError): boolean {
  return e.errorClass === "timeout" || e.errorClass === "network" || e.errorClass === "http_429" || e.errorClass === "http_5xx";
}

export interface LlmTransport {
  providerId: string;
  timeoutMs: number;
  /** Retries for network errors, HTTP 408, 429 and 5xx (and the cap on all retries). */
  maxRetries: number;
  /** Retries after an attempt hit `timeoutMs`. Counted inside `maxRetries`. */
  maxTimeoutRetries: number;
  backoffMs: number;
  maxDelayMs: number;
  budgetMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ProviderHttpConfig {
  type?: string;
  timeout_ms?: number;
  max_retries?: number;
  max_timeout_retries?: number;
  budget_ms?: number;
  max_delay_ms?: number;
}

const ENV_KEYS = {
  timeoutMs: "MERGEJUDGE_LLM_TIMEOUT_MS",
  maxRetries: "MERGEJUDGE_LLM_MAX_RETRIES",
  maxTimeoutRetries: "MERGEJUDGE_LLM_MAX_TIMEOUT_RETRIES",
  budgetMs: "MERGEJUDGE_LLM_BUDGET_MS",
  maxDelayMs: "MERGEJUDGE_LLM_MAX_DELAY_MS",
} as const;

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function pickInt(envRaw: string | undefined, configVal: number | undefined, fallback: number, bounds: readonly [number, number]): number {
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const n = Number(envRaw);
    if (Number.isInteger(n)) return clampInt(n, bounds[0], bounds[1]);
  }
  if (typeof configVal === "number" && Number.isInteger(configVal)) return clampInt(configVal, bounds[0], bounds[1]);
  return fallback;
}

/**
 * Resolved limits for one provider. Config values win over defaults; the MERGEJUDGE_LLM_* env vars
 * win over config (clamped to the schema caps). `timeoutMs` is never larger than `budgetMs`.
 */
export function llmTransportFromConfig(cfg: ProviderHttpConfig, env: Record<string, string | undefined> = {}): LlmTransport {
  const budgetMs = pickInt(env[ENV_KEYS.budgetMs], cfg.budget_ms, LLM_HTTP_DEFAULTS.budgetMs, LLM_HTTP_LIMITS.budgetMs);
  const timeoutMs = Math.min(budgetMs, pickInt(env[ENV_KEYS.timeoutMs], cfg.timeout_ms, LLM_HTTP_DEFAULTS.timeoutMs, LLM_HTTP_LIMITS.timeoutMs));
  const maxDelayMs = Math.min(budgetMs, pickInt(env[ENV_KEYS.maxDelayMs], cfg.max_delay_ms, LLM_HTTP_DEFAULTS.maxDelayMs, LLM_HTTP_LIMITS.maxDelayMs));
  return {
    providerId: cfg.type && cfg.type !== "none" ? cfg.type : "llm",
    timeoutMs,
    maxRetries: pickInt(env[ENV_KEYS.maxRetries], cfg.max_retries, LLM_HTTP_DEFAULTS.maxRetries, LLM_HTTP_LIMITS.maxRetries),
    maxTimeoutRetries: pickInt(env[ENV_KEYS.maxTimeoutRetries], cfg.max_timeout_retries, LLM_HTTP_DEFAULTS.maxTimeoutRetries, LLM_HTTP_LIMITS.maxTimeoutRetries),
    backoffMs: LLM_HTTP_DEFAULTS.backoffMs,
    maxDelayMs,
    budgetMs,
  };
}

/** Retry-After as milliseconds, capped. Delta-seconds or HTTP-date. Null when the header is missing or not a date. */
export function parseRetryAfterMs(header: string | null, capMs: number, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n * 1000), capMs);
  const d = Date.parse(trimmed);
  if (!Number.isFinite(d)) return null;
  return Math.min(Math.max(0, d - now), capMs);
}

/**
 * Wait before attempt `attempt + 1` (0-based index of the failure). A Retry-After value is used as-is
 * within the cap; otherwise exponential backoff with equal jitter in `[exp/2, exp]`.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null, o: { backoffMs: number; maxDelayMs: number; random: () => number }): number {
  if (retryAfterMs !== null) return Math.min(o.maxDelayMs, Math.max(0, retryAfterMs));
  const exp = Math.min(o.maxDelayMs, o.backoffMs * 2 ** Math.max(0, attempt));
  const rand = Math.min(1, Math.max(0, o.random()));
  return Math.min(o.maxDelayMs, Math.floor(exp / 2 + (exp / 2) * rand));
}

function isAbortError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : (typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined);
  return name === "AbortError" || name === "TimeoutError";
}

const NET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"]);

function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const code = (e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
  return typeof code === "string" && (NET_CODES.has(code) || code.startsWith("UND_ERR_"));
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode;
  return typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599 ? s : undefined;
}

/** Class of a thrown model-call or parse failure. The original message is never copied. */
export function classifyLlmFailure(e: unknown, providerHint?: string): LlmFailure {
  if (e instanceof LlmError) return { errorClass: e.errorClass, provider: e.provider ?? providerHint, status: e.status };
  if (typeof e === "object" && e !== null && (e as { name?: string }).name === "ZodError") return { errorClass: "schema", provider: providerHint };
  if (e instanceof SyntaxError) return { errorClass: "parse", provider: providerHint };
  if (e instanceof Error && e.message === "no JSON object in LLM output") return { errorClass: "parse", provider: providerHint };
  const status = statusOf(e);
  if (status !== undefined) return { errorClass: httpErrorClass(status), provider: providerHint, status };
  if (isAbortError(e)) return { errorClass: "timeout", provider: providerHint };
  if (isNetworkError(e)) return { errorClass: "network", provider: providerHint };
  return { errorClass: "parse", provider: providerHint };
}

function fill(partial?: Partial<LlmTransport>): LlmTransport {
  const budgetMs = partial?.budgetMs ?? LLM_HTTP_DEFAULTS.budgetMs;
  return {
    providerId: partial?.providerId ?? "llm",
    timeoutMs: Math.min(partial?.timeoutMs ?? LLM_HTTP_DEFAULTS.timeoutMs, budgetMs),
    maxRetries: partial?.maxRetries ?? LLM_HTTP_DEFAULTS.maxRetries,
    maxTimeoutRetries: partial?.maxTimeoutRetries ?? LLM_HTTP_DEFAULTS.maxTimeoutRetries,
    backoffMs: partial?.backoffMs ?? LLM_HTTP_DEFAULTS.backoffMs,
    maxDelayMs: Math.min(partial?.maxDelayMs ?? LLM_HTTP_DEFAULTS.maxDelayMs, budgetMs),
    budgetMs,
    fetchImpl: partial?.fetchImpl,
    sleep: partial?.sleep,
    random: partial?.random,
    now: partial?.now,
    signal: partial?.signal,
  };
}

/** Lower the call budget (and the per-attempt timeout with it) to `budgetMs` when given. Never raises it. */
export function withCallBudget(t: Partial<LlmTransport>, budgetMs?: number): Partial<LlmTransport> {
  if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs)) return t;
  const cap = Math.max(1, Math.floor(budgetMs));
  return { ...t, budgetMs: Math.min(t.budgetMs ?? LLM_HTTP_DEFAULTS.budgetMs, cap) };
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Rejects when `signal` aborts. The Workers AI binding cannot observe the signal itself. */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function runAttempt<T>(op: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal | undefined, providerId: string): Promise<T> {
  const ctl = new AbortController();
  let timed = false;
  const timer = setTimeout(() => { timed = true; ctl.abort(); }, timeoutMs);
  const onParent = () => ctl.abort();
  if (parent?.aborted) {
    clearTimeout(timer);
    throw parent.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  parent?.addEventListener("abort", onParent, { once: true });
  try {
    return await op(ctl.signal);
  } catch (e) {
    if (parent?.aborted) throw parent.reason ?? e;
    if (e instanceof LlmError) throw e;
    if (timed || isAbortError(e)) throw new LlmError("timeout", { provider: providerId });
    if (isNetworkError(e)) throw new LlmError("network", { provider: providerId });
    const failure = classifyLlmFailure(e, providerId);
    throw new LlmError(failure.errorClass, { provider: failure.provider, status: failure.status });
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}

/** Run `op` with a per-attempt abort and a bounded number of retries inside `budgetMs`. */
export async function withLlmRetries<T>(op: (signal: AbortSignal) => Promise<T>, partial?: Partial<LlmTransport>): Promise<T> {
  const o = fill(partial);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const random = o.random ?? Math.random;
  const started = now();
  const attempts = o.maxRetries + 1;
  let last: LlmError | undefined;
  let timeoutRetries = 0;
  for (let i = 0; i < attempts; i++) {
    if (o.signal?.aborted) throw o.signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
    const remaining = o.budgetMs - (now() - started);
    if (remaining < 1) {
      if (last) throw last;
      throw new LlmError("timeout", { provider: o.providerId });
    }
    try {
      return await runAttempt(op, Math.max(1, Math.min(o.timeoutMs, remaining)), o.signal, o.providerId);
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason ?? e;
      const err = e instanceof LlmError ? e : new LlmError(classifyLlmFailure(e, o.providerId).errorClass, {
        provider: o.providerId,
        status: classifyLlmFailure(e, o.providerId).status,
      });
      last = err;
      if (!isRetryableLlmError(err) || i >= attempts - 1) throw err;
      if (isAttemptTimeout(err) && timeoutRetries++ >= o.maxTimeoutRetries) throw err;
      const room = o.budgetMs - (now() - started);
      if (room <= 0) throw err;
      const delay = Math.min(retryDelayMs(i, err.retryAfterMs, { backoffMs: o.backoffMs, maxDelayMs: o.maxDelayMs, random }), room);
      await sleep(delay, o.signal);
    }
  }
  throw last ?? new LlmError("network", { provider: o.providerId });
}

async function discard(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

/** POST JSON. On a non-2xx response the body is discarded unread. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, transport?: Partial<LlmTransport>): Promise<unknown> {
  const o = fill(transport);
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  return withLlmRetries(async (signal) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), o.maxDelayMs, now());
      await discard(res);
      throw new LlmError(httpErrorClass(res.status), { provider: o.providerId, status: res.status, retryAfterMs });
    }
    try {
      return await res.json();
    } catch {
      throw new LlmError("parse", { provider: o.providerId, status: res.status });
    }
  }, o);
}
