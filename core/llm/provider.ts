export interface LlmRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  /** Prefer JSON-object responses when the endpoint supports it (OpenAI-compatible). */
  jsonMode?: boolean;
}

/**
 * Provider-reported token counts of one HTTP call. `input` is the part of the prompt that was neither read from nor
 * written to the prompt cache, so `input`, `cacheRead`, `cacheWrite` and `output` never overlap (each is billed once).
 */
export interface LlmUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Called once per model call. `usage` is null when the response carried no usage field (the call still happened). */
export type UsageSink = (usage: LlmUsage | null) => void;

/** Non-negative integer from an untrusted JSON number, else 0. */
export const tokenCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Report a call to the sink; a sink that throws never fails the review. */
export function reportUsage(sink: UsageSink | undefined, usage: LlmUsage | null): void {
  if (!sink) return;
  try { sink(usage); } catch { /* metering must never break a review */ }
}

/** OpenAI-style counts (Chat Completions, Responses, z.ai): the prompt total includes the cached part. */
export function openAiUsage(prompt: unknown, completion: unknown, cached: unknown): LlmUsage {
  const p = tokenCount(prompt), c = Math.min(p, tokenCount(cached));
  return { input: p - c, output: tokenCount(completion), cacheRead: c, cacheWrite: 0 };
}

/** Reply text plus whether the provider cut it off at the output limit. */
export interface LlmResult { text: string; truncated: boolean; outputTokens?: number }

/**
 * Cut off at the limit: the provider said so (finish_reason "length", stop_reason "max_tokens", status incomplete), or,
 * as a fallback for endpoints that omit it, the reported output tokens reached the limit.
 */
export const isTruncated = (byReason: boolean, outputTokens: number, limit: number): boolean =>
  byReason || (outputTokens > 0 && limit > 0 && outputTokens >= limit);

export interface LlmProvider {
  readonly label: string; // shown in the comment footer
  /** Stable id for error logs (`openai`, `anthropic`, `workers-ai`, …). Not the model name. */
  readonly providerId?: string;
  complete(req: LlmRequest): Promise<string>;
  /** Like `complete`, but also reports truncation. Without it the reply is assumed complete. */
  completeEx?(req: LlmRequest): Promise<LlmResult>;
  /** True when `chat` supports tool calling (needed by `review.mode: deep`). */
  readonly supportsTools?: boolean;
  chat?(req: ChatRequest): Promise<ChatTurn>;
}

/** A read-only tool offered to the model. `parameters` is a JSON schema object. */
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  /** Omit (or empty) to force a plain text answer. */
  tools?: ToolDef[];
  maxOutputTokens: number;
  jsonMode?: boolean;
  /** Upper bound in ms for this call, retries included (deep mode's remaining time). Lowers, never raises, the provider budget. */
  budgetMs?: number;
}

export interface ChatTurn {
  text: string;
  toolCalls: ToolCall[];
  /** Provider-reported token counts, when available. */
  usage?: { input: number; output: number };
  /** The reply hit the output limit (text and tool calls may be incomplete). */
  truncated?: boolean;
}

/** One call through `completeEx` when the provider has it, else `complete`. */
export async function completeWithMeta(p: LlmProvider, req: LlmRequest): Promise<LlmResult> {
  return p.completeEx ? p.completeEx(req) : { text: await p.complete(req), truncated: false };
}

export const canUseTools = (p: LlmProvider | null | undefined): p is LlmProvider & Required<Pick<LlmProvider, "chat">> =>
  !!p && p.supportsTools === true && typeof p.chat === "function";

/** Parse a tool-call arguments string; bad JSON yields {} so the tool reports a usage error instead of throwing. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

export {
  classifyLlmFailure, formatLlmFailure, httpErrorClass, isRetryableLlmError, llmTransportFromConfig, LlmError, LLM_HTTP_DEFAULTS, LLM_HTTP_LIMITS,
  parseRetryAfterMs, postJson, rejectOnAbort, retryDelayMs, withLlmRetries,
  type LlmErrorClass, type LlmFailure, type LlmTransport, type ProviderHttpConfig,
} from "./http.js";
