import type { ProviderConfig } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { llmTransportFromConfig } from "./http.js";
import { OpenAiProvider } from "./openai.js";
import type { LlmProvider, LlmUsage } from "./provider.js";
import { OpenAiResponsesProvider } from "./responses.js";
import { WorkersAiProvider, type WorkersAiBinding } from "./workersai.js";

export type { LlmProvider, LlmUsage } from "./provider.js";
export type { WorkersAiBinding } from "./workersai.js";

/**
 * Where API keys come from. Today: env vars (Action) or Worker secrets. Later: a per-org
 * bring-your-own-key store (D1) can implement the same lookup by name.
 */
export type KeySource = Record<string, string | undefined>;

export const ZAI_ENDPOINTS = {
  paygo: "https://api.z.ai/api/paas/v4",
  coding: "https://api.z.ai/api/coding/paas/v4",
} as const;

/** Default secret / env var name per provider type. `provider.api_key_env` overrides it. */
export const DEFAULT_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
  zai: "ZAI_API_KEY",
};

/** Secret / env var name the provider reads its key from: `provider.api_key_env`, else the type's default. */
export function providerKeyEnv(cfg: ProviderConfig): string {
  return cfg.api_key_env ?? DEFAULT_KEY_ENV[cfg.type] ?? "OPENAI_API_KEY";
}

/** Endpoint the provider will call: `provider.base_url`, else the type's official default. */
export function providerBaseUrl(cfg: ProviderConfig): string {
  if (cfg.base_url) return cfg.base_url;
  if (cfg.type === "anthropic") return "https://api.anthropic.com";
  if (cfg.type === "zai") return ZAI_ENDPOINTS[cfg.endpoint ?? "paygo"];
  return "https://api.openai.com/v1";
}

/** One metered model call: who was called (price-table provider key) and what the response said it used. */
export interface LlmCallUsage { provider: string; model: string; usage: LlmUsage | null }

const OFFICIAL_HOSTS: Record<string, string> = { "api.anthropic.com": "anthropic", "api.openai.com": "openai" };

/**
 * Key of the provider in the price table. Only the official pay-as-you-go endpoints map to a priced provider
 * (`anthropic`, `openai`, `zai`); a custom base_url, the z.ai coding plan, OpenAI-compatible gateways and Workers AI get
 * their own labels, which have no price rows, so their calls are flagged unpriced rather than billed at a guess.
 */
export function priceProvider(cfg: ProviderConfig): string {
  if (cfg.type === "workers-ai") return "workers-ai";
  if (cfg.type === "openai-compatible") return "openai-compatible";
  let u: URL | null = null;
  try { u = new URL(providerBaseUrl(cfg)); } catch { /* custom */ }
  if (!u || u.protocol !== "https:" || u.port !== "") return `custom:${cfg.type}`;
  if (cfg.type === "zai") return u.hostname === "api.z.ai" && u.pathname.replace(/\/+$/, "") === "/api/paas/v4" ? "zai" : "zai-coding";
  return OFFICIAL_HOSTS[u.hostname] === cfg.type ? cfg.type : `custom:${cfg.type}`;
}

/** Returns null (=> rules-only mode) if provider is none, the model is unset or no key/binding is available. */
export function createProvider(
  cfg: ProviderConfig,
  env: KeySource = process.env,
  bindings: { ai?: WorkersAiBinding; onCall?: (c: LlmCallUsage) => void } = {},
): { provider: LlmProvider | null; note?: string } {
  if (cfg.type === "none") return { provider: null };
  if (!cfg.model) return { provider: null, note: "provider.model not set" };
  const model = cfg.model;
  const onUsage = bindings.onCall ? (usage: LlmUsage | null) => bindings.onCall!({ provider: priceProvider(cfg), model, usage }) : undefined;
  const transport = llmTransportFromConfig(cfg, env);
  if (cfg.type === "workers-ai") {
    if (!bindings.ai) return { provider: null, note: "Workers AI binding `AI` not available (Worker runtime only)" };
    return { provider: new WorkersAiProvider(bindings.ai, model, onUsage, transport) };
  }
  const keyEnv = providerKeyEnv(cfg);
  const key = env[keyEnv];
  if (!key) return { provider: null, note: `env ${keyEnv} not set` };
  const base = providerBaseUrl(cfg);
  switch (cfg.type) {
    case "anthropic":
      return { provider: new AnthropicProvider(base, model, key, onUsage, transport) };
    case "openai":
      return cfg.api === "responses"
        ? { provider: new OpenAiResponsesProvider(base, model, key, onUsage, transport) }
        : { provider: new OpenAiProvider(base, model, key, onUsage, transport) };
    case "openai-compatible":
    case "zai":
      return { provider: new OpenAiProvider(base, model, key, onUsage, transport) };
    default: {
      const unhandled: never = cfg.type;
      throw new Error(`createProvider: no adapter for provider.type ${String(unhandled)}`);
    }
  }
}
