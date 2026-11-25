import { describe, expect, it } from "vitest";
import { isReasoningModel } from "../core/budget.js";
import { parseConfig } from "../core/config.js";
import { GeminiProvider, geminiThinkingLevel, type GeminiThinkingLevel } from "../core/llm/gemini.js";
import { createProvider, priceProvider } from "../core/llm/index.js";
import type { LlmUsage } from "../core/llm/provider.js";

const KEY = "test-key-123";
const req = { system: "sys", user: "usr", maxOutputTokens: 1000 };

function mock(reply: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const ok = { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] };
const make = (model: string, level: GeminiThinkingLevel | undefined, m: ReturnType<typeof mock>, onUsage?: (u: LlmUsage | null) => void) =>
  new GeminiProvider("https://generativelanguage.googleapis.com", model, KEY, level, onUsage, { fetchImpl: m.fetchImpl });

describe("gemini config", () => {
  it("accepts gemini + thinking_level and rejects unknown levels", () => {
    const c = parseConfig("provider:\n  type: gemini\n  model: gemini-4-neon\n  thinking_level: high\n");
    expect(c.provider.type).toBe("gemini");
    expect(c.provider.thinking_level).toBe("high");
    expect(() => parseConfig("provider:\n  type: gemini\n  thinking_level: minimal\n")).toThrow();
  });
  it("default provider stays none", () => {
    expect(parseConfig("").provider.type).toBe("none");
  });
  it("neon is a reasoning model", () => {
    expect(isReasoningModel("gemini-4-neon")).toBe(true);
  });
});

describe("gemini request", () => {
  it("posts to generateContent with the key in a header only", async () => {
    const m = mock(ok);
    await make("gemini-4-neon", undefined, m).completeEx(req);
    expect(m.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent");
    expect(m.calls[0]!.url).not.toContain(KEY);
    expect(m.calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
  });
  it("thinking level: medium default for neon, explicit high, absent otherwise", async () => {
    const level = async (model: string, thinking_level?: GeminiThinkingLevel) => {
      const m = mock(ok);
      await make(model, geminiThinkingLevel({ model, thinking_level }), m).completeEx(req);
      return m.calls[0]!.body.generationConfig.thinkingConfig?.thinkingLevel;
    };
    expect(await level("gemini-4-neon")).toBe("MEDIUM");
    expect(await level("gemini-4-neon", "high")).toBe("HIGH");
    expect(await level("gemini-4-flash")).toBeUndefined();
  });
  it("sends no sampling or budget fields and sets json mime type", async () => {
    const m = mock(ok);
    await make("gemini-4-neon", "medium", m).completeEx({ ...req, jsonMode: true });
    const body = JSON.stringify(m.calls[0]!.body);
    for (const k of ["temperature", "topP", "topK", "thinkingBudget", "MINIMAL"]) expect(body).not.toContain(k);
    expect(m.calls[0]!.body.generationConfig.responseMimeType).toBe("application/json");
    expect(m.calls[0]!.body.generationConfig.maxOutputTokens).toBe(1000);
  });
});

describe("gemini reply", () => {
  it("excludes thought parts", async () => {
    const m = mock({ candidates: [{ content: { parts: [{ text: "secret thinking", thought: true }, { text: "answer" }] } }] });
    expect((await make("gemini-4-neon", "medium", m).completeEx(req)).text).toBe("answer");
  });
  it("flags MAX_TOKENS as truncated", async () => {
    const m = mock({ candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }] });
    expect((await make("gemini-4-neon", "medium", m).completeEx(req)).truncated).toBe(true);
  });
  it("maps usage", async () => {
    const m = mock({ ...ok, usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 20, thoughtsTokenCount: 50 } });
    let seen: LlmUsage | null = null;
    const r = await make("gemini-4-neon", "medium", m, (u) => { seen = u; }).completeEx(req);
    expect(r.usage).toEqual({ input: 70, cacheRead: 30, output: 70, cacheWrite: 0 });
    expect(seen).toEqual(r.usage);
  });
});

describe("gemini wiring", () => {
  it("createProvider needs GEMINI_API_KEY", () => {
    const cfg = parseConfig("provider:\n  type: gemini\n  model: gemini-4-neon\n");
    expect(createProvider(cfg.provider, {})).toEqual({ provider: null, note: "env GEMINI_API_KEY not set" });
    expect(createProvider(cfg.provider, { GEMINI_API_KEY: KEY }).provider?.label).toBe("gemini-4-neon");
  });
  it("priceProvider", () => {
    expect(priceProvider(parseConfig("provider:\n  type: gemini\n  model: gemini-4-neon\n").provider)).toBe("gemini");
    expect(priceProvider(parseConfig("provider:\n  type: gemini\n  model: m\n  base_url: https://proxy.example.com\n").provider)).toBe("custom:gemini");
  });
});
