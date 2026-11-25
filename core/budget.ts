import type { Config } from "./config.js";

/**
 * Output-token limit per call. `budget.max_output_tokens` wins when the repo sets it; otherwise the default depends on the
 * model: reasoning-capable models spend output tokens on hidden reasoning before the JSON, so a small cap cuts the JSON
 * off (observed: glm-5.x stopping at exactly 2500 tokens). Keep the table small; unknown models get the lower default.
 */
export const DEFAULT_OUTPUT_TOKENS = 2500;
export const REASONING_OUTPUT_TOKENS = 8000;

/**
 * Model ids (any gateway prefix such as `openrouter/openai/` or `@cf/zai-org/`) treated as reasoning-capable. DeepSeek: R1/reasoner
 * and the v4+ family (v4.x-flash and -pro reason by default); v2/v3 chat and deepseek-coder do not (v3.1 hybrids default to no thinking).
 */
export const REASONING_MODEL =
  /(?:^|[/:@])(?:glm-?(?:5|4\.[5-9])|gpt-5|o[1-9](?:-|$)|deepseek-(?:r1|reasoner|v(?:[4-9]|\d{2,}))|qwq|gemini-4|[^/]*thinking)/i;

export const isReasoningModel = (model: string | undefined): boolean => !!model && REASONING_MODEL.test(model);

/** Smallest reply that can still hold a useful JSON object. */
const MIN_OUTPUT = 256;
/** Prompt room kept free when an explicit limit is clamped to the per-PR budget. */
const MIN_INPUT = 1000;

/**
 * Effective output limit: explicit config, else the per-model default, clamped so output never leaves the prompt
 * less than MIN_INPUT of room inside `budget.max_tokens_per_pr` (a defaulted limit is also capped at half of it).
 */
export function resolveOutputLimit(cfg: Config): number {
  const total = cfg.budget.max_tokens_per_pr;
  const explicit = cfg.budget.max_output_tokens;
  if (explicit !== undefined) return Math.max(MIN_OUTPUT, Math.min(explicit, total - MIN_INPUT));
  const want = isReasoningModel(cfg.provider.model) ? REASONING_OUTPUT_TOKENS : DEFAULT_OUTPUT_TOKENS;
  return Math.max(MIN_OUTPUT, Math.min(want, Math.floor(total / 2)));
}

/** Limit for the single retry after a cut-off or unparseable reply: 2x, never past the `room` the budget leaves. */
export function retryOutputLimit(limit: number, room: number): number {
  return Math.max(limit, Math.min(limit * 2, room));
}

/** Added to the retry prompt so the reply fits in the extra room. */
export const COMPACT_JSON_INSTRUCTION = "Respond with compact JSON only, no reasoning text, keep findings short.";

/** PR story call: a small cap, a larger one for reasoning-capable models (hidden reasoning comes out of the same limit). */
export const STORY_OUTPUT_TOKENS = 1200;
export const STORY_REASONING_OUTPUT_TOKENS = 4000;
/** Below this much output room the story call is not worth making. */
export const MIN_STORY_OUTPUT = 600;
export const storyOutputLimit = (model: string | undefined): number => (isReasoningModel(model) ? STORY_REASONING_OUTPUT_TOKENS : STORY_OUTPUT_TOKENS);

/** Tokens one call used: provider-reported usage when the response had it, else undefined (callers fall back to an estimate). */
export const usageTotal = (u: { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined): number | undefined =>
  u ? u.input + u.output + u.cacheRead + u.cacheWrite : undefined;

/**
 * Cumulative per-review token cap (`budget.max_tokens_per_pr`) over the review call, its retry, the second pass and the
 * story call, measured on actual usage where the provider reports it. Deep tool mode has its own `deep.max_tokens`
 * loop, so after it the larger of the two caps applies.
 */
export const perPrCap = (cfg: Config, deepToolLoop = false): number =>
  deepToolLoop ? Math.max(cfg.budget.max_tokens_per_pr, cfg.deep.max_tokens) : cfg.budget.max_tokens_per_pr;

/** True when `spent` plus a call of `estimate` tokens (prompt + output limit) would go past `cap`. */
export const exceedsCap = (spent: number, estimate: number, cap: number): boolean => spent + estimate > cap;
