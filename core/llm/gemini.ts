import { LlmError, postJson, withCallBudget, type LlmTransport } from "./http.js";
import { isTruncated, reportUsage, tokenCount, type LlmProvider, type LlmRequest, type LlmResult, type LlmUsage, type UsageSink } from "./provider.js";

export type GeminiThinkingLevel = "low" | "medium" | "high" | "xhigh";

/** `provider.thinking_level` if set, else medium for gemini-4-neon (the API itself defaults Neon to high), else none (no thinkingConfig sent). */
export function geminiThinkingLevel(cfg: { model?: string; thinking_level?: GeminiThinkingLevel }): GeminiThinkingLevel | undefined {
  if (cfg.thinking_level) return cfg.thinking_level;
  return cfg.model?.startsWith("gemini-4-neon") ? "medium" : undefined;
}

type GeminiUsage = { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };

/** `promptTokenCount` includes the cached part; thinking tokens are billed as output. */
export function geminiUsage(u: GeminiUsage | undefined): LlmUsage | null {
  if (!u || typeof u !== "object") return null;
  const prompt = tokenCount(u.promptTokenCount), cached = Math.min(prompt, tokenCount(u.cachedContentTokenCount));
  return { input: prompt - cached, output: tokenCount(u.candidatesTokenCount) + tokenCount(u.thoughtsTokenCount), cacheRead: cached, cacheWrite: 0 };
}

export class GeminiProvider implements LlmProvider {
  readonly label: string;
  readonly providerId: string;
  readonly supportsTools = false;
  constructor(private baseUrl: string, private model: string, private apiKey: string, private thinkingLevel?: GeminiThinkingLevel, private onUsage?: UsageSink, private transport: Partial<LlmTransport> = {}) {
    this.label = model;
    this.providerId = transport.providerId ?? "gemini";
  }
  private url() { return `${this.baseUrl.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`; }
  async complete(req: LlmRequest): Promise<string> {
    const r = await this.completeEx(req);
    if (!r.text) throw new LlmError("parse", { provider: this.providerId });
    return r.text;
  }
  async completeEx(req: LlmRequest): Promise<LlmResult> {
    const http = withCallBudget({ ...this.transport, providerId: this.providerId }, req.budgetMs, typeof req.maxRetries === "number" ? req.maxRetries : undefined);
    const data = (await postJson(
      this.url(),
      { "x-goog-api-key": this.apiKey },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens,
          ...(req.jsonMode || req.outputSchema ? { responseMimeType: "application/json" } : {}),
          ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.thinkingLevel.toUpperCase() } } : {}),
        },
      },
      http,
    )) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: unknown }[]; usageMetadata?: GeminiUsage };
    const usage = geminiUsage(data.usageMetadata);
    reportUsage(this.onUsage, usage, req.purpose);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const outputTokens = usage?.output ?? 0;
    return { text, truncated: isTruncated(cand?.finishReason === "MAX_TOKENS", outputTokens, req.maxOutputTokens), outputTokens, usage };
  }
}
