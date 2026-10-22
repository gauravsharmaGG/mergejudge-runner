import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import {
  classifyLlmFailure, formatLlmFailure, llmTransportFromConfig, LlmError, LLM_HTTP_DEFAULTS, parseRetryAfterMs, postJson, retryDelayMs, withCallBudget,
} from "../core/llm/http.js";
import { WorkersAiProvider, type WorkersAiBinding } from "../core/llm/workersai.js";

const SECRET = "CUSTOMER_FN_export_function_pay";

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("llm transport config", () => {
  it("uses safe defaults and lets env override config, clamped to the caps", () => {
    const defaults = llmTransportFromConfig(parseConfig("").provider, {});
    expect(defaults.timeoutMs).toBe(LLM_HTTP_DEFAULTS.timeoutMs);
    expect(defaults.maxRetries).toBe(LLM_HTTP_DEFAULTS.maxRetries);
    expect(defaults.budgetMs).toBe(LLM_HTTP_DEFAULTS.budgetMs);
    expect(defaults.maxDelayMs).toBe(LLM_HTTP_DEFAULTS.maxDelayMs);
    expect(defaults).toMatchObject({ timeoutMs: 120_000, maxRetries: 2, maxTimeoutRetries: 1, budgetMs: 240_000 });
    expect(defaults.budgetMs).toBeLessThanOrEqual(300_000);
    // one retry after a timeout fits in the call budget
    expect(defaults.timeoutMs * (defaults.maxTimeoutRetries + 1)).toBeLessThanOrEqual(defaults.budgetMs);

    const cfg = parseConfig("provider:\n  type: openai\n  model: m\n  timeout_ms: 5000\n  max_retries: 1\n  budget_ms: 20000\n  max_delay_ms: 1500\n").provider;
    expect(llmTransportFromConfig(cfg, {}).timeoutMs).toBe(5000);
    expect(llmTransportFromConfig(cfg, {}).maxRetries).toBe(1);
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_TIMEOUT_MS: "8000" }).timeoutMs).toBe(8000);
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_TIMEOUT_MS: "nope" }).timeoutMs).toBe(5000);
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_TIMEOUT_MS: "90000" }).timeoutMs).toBe(20_000);
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_BUDGET_MS: "999999" }).budgetMs).toBe(300_000);
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_TIMEOUT_MS: "999999", MERGEJUDGE_LLM_BUDGET_MS: "999999" }).timeoutMs).toBe(180_000);
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_MAX_TIMEOUT_RETRIES: "0" }).maxTimeoutRetries).toBe(0);
    const big = parseConfig("provider:\n  type: openai\n  model: m\n  timeout_ms: 180000\n  max_timeout_retries: 2\n  budget_ms: 300000\n").provider;
    expect(llmTransportFromConfig(big, {})).toMatchObject({ timeoutMs: 180_000, maxTimeoutRetries: 2, budgetMs: 300_000 });
    expect(llmTransportFromConfig(cfg, { MERGEJUDGE_LLM_MAX_RETRIES: "0" }).maxRetries).toBe(0);
  });

  it("rejects a timeout outside the schema range", () => {
    expect(() => parseConfig("provider:\n  type: openai\n  model: m\n  timeout_ms: 10\n")).toThrow(/timeout_ms/);
    expect(() => parseConfig("provider:\n  type: openai\n  model: m\n  timeout_ms: 180001\n")).toThrow(/timeout_ms/);
    expect(() => parseConfig("provider:\n  type: openai\n  model: m\n  budget_ms: 300001\n")).toThrow(/budget_ms/);
  });
});

describe("retry delay", () => {
  it("uses equal jitter for backoff and caps Retry-After", () => {
    expect(retryDelayMs(0, null, { backoffMs: 200, maxDelayMs: 4_000, random: () => 0 })).toBe(100);
    expect(retryDelayMs(0, null, { backoffMs: 200, maxDelayMs: 4_000, random: () => 1 })).toBe(200);
    expect(retryDelayMs(2, null, { backoffMs: 200, maxDelayMs: 4_000, random: () => 1 })).toBe(800);
    expect(retryDelayMs(0, 30_000, { backoffMs: 200, maxDelayMs: 4_000, random: () => 0 })).toBe(4_000);
    expect(retryDelayMs(0, 0, { backoffMs: 200, maxDelayMs: 4_000, random: () => 1 })).toBe(0);
    expect(parseRetryAfterMs("30", 100)).toBe(100);
    expect(parseRetryAfterMs("soon", 4_000)).toBeNull();
    const now = 1_700_000_000_000;
    expect(parseRetryAfterMs(new Date(now + 3_000).toUTCString(), 4_000, now)).toBe(3_000);
    expect(parseRetryAfterMs(new Date(now + 30_000).toUTCString(), 4_000, now)).toBe(4_000);
  });
});

describe("postJson", () => {
  const fast = { timeoutMs: 5_000, budgetMs: 20_000, backoffMs: 200, maxDelayMs: 4_000, providerId: "openai" as const };

  it("retries 5xx and network errors, then succeeds, without reading the error body", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    let errorBodyReads = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls < 3) {
        const res = jsonResponse(503, `please retry ${SECRET}`, { "retry-after": "0" });
        const text = res.text.bind(res);
        res.text = async () => { errorBodyReads++; return text(); };
        return res;
      }
      return jsonResponse(200, JSON.stringify({ ok: true }));
    };
    const data = await postJson("https://example.test/v1", { authorization: "Bearer secret" }, { user: SECRET }, {
      ...fast, maxRetries: 2, random: () => 1, fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([0, 0]);
    expect(errorBodyReads).toBe(0);
  });

  it("backs off with jitter when Retry-After is absent and caps a long Retry-After", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, SECRET, { "retry-after": "30" });
      if (calls === 2) return jsonResponse(500, SECRET);
      return jsonResponse(200, JSON.stringify({ ok: 1 }));
    };
    await postJson("https://example.test/v1", {}, { n: 1 }, {
      ...fast, maxRetries: 2, maxDelayMs: 100, backoffMs: 80, random: () => 0, fetchImpl,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toBe(3);
    expect(sleeps[0]).toBe(100);
    expect(sleeps[1]).toBe(50);
  });

  it("does not retry 4xx auth or validation, and the error has no body", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls++;
        return jsonResponse(status, `invalid ${SECRET} near customer code`);
      };
      const err = await postJson("https://example.test/v1", {}, {}, { ...fast, maxRetries: 4, fetchImpl, sleep: async () => { throw new Error("slept"); } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmError);
      if (!(err instanceof LlmError)) throw err;
      expect(err.errorClass).toBe("http_4xx");
      expect(err.status).toBe(status);
      expect(err.message).toBe(`class=http_4xx provider=openai status=${status}`);
      expect(err.message).not.toContain(SECRET);
      expect(String(err)).not.toContain("customer code");
      expect(calls).toBe(1);
    }
  });

  it("classifies a timeout, retries it, and stops within the attempt budget", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      calls++;
      const signal = init?.signal;
      const hang = setTimeout(() => reject(new Error("hung")), 5_000);
      signal?.addEventListener("abort", () => {
        clearTimeout(hang);
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    });
    const err = await postJson("https://example.test/v1", {}, { prompt: SECRET }, {
      providerId: "anthropic", timeoutMs: 30, maxRetries: 2, budgetMs: 500, backoffMs: 0, maxDelayMs: 0,
      fetchImpl, sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    if (!(err instanceof LlmError)) throw err;
    expect(err.errorClass).toBe("timeout");
    expect(err.provider).toBe("anthropic");
    expect(err.message).not.toContain(SECRET);
    expect(calls).toBe(2); // one retry after a timeout, even with maxRetries 2
  });

  it("allows more timeout retries when configured", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const err = await postJson("https://example.test/v1", {}, {}, {
      providerId: "openai", timeoutMs: 20, maxRetries: 2, maxTimeoutRetries: 2, budgetMs: 500, backoffMs: 0, maxDelayMs: 0,
      fetchImpl, sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ errorClass: "timeout" });
    expect(calls).toBe(3);
  });

  it("still retries HTTP 408 and 5xx twice; a timeout counts toward both limits", async () => {
    let calls = 0;
    const fetch408: typeof fetch = async () => { calls++; return jsonResponse(408, SECRET); };
    const e408 = await postJson("https://example.test/v1", {}, {}, { ...fast, maxRetries: 2, backoffMs: 0, maxDelayMs: 0, fetchImpl: fetch408, sleep: async () => {} }).catch((e: unknown) => e);
    expect(e408).toMatchObject({ errorClass: "timeout", status: 408 });
    expect(calls).toBe(3);

    calls = 0;
    const mixed: typeof fetch = (_url, init) => {
      calls++;
      if (calls === 1) return new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      if (calls === 2) return Promise.resolve(jsonResponse(503, SECRET));
      return Promise.resolve(jsonResponse(200, JSON.stringify({ ok: true })));
    };
    const ok = await postJson("https://example.test/v1", {}, {}, {
      providerId: "openai", timeoutMs: 20, maxRetries: 2, budgetMs: 2_000, backoffMs: 0, maxDelayMs: 0, fetchImpl: mixed, sleep: async () => {},
    });
    expect(ok).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("lowers, never raises, the call budget for one request", () => {
    expect(withCallBudget({ budgetMs: 240_000 }, 50_000).budgetMs).toBe(50_000);
    expect(withCallBudget({ budgetMs: 240_000 }, 900_000).budgetMs).toBe(240_000);
    expect(withCallBudget({}, 10).budgetMs).toBe(10);
    expect(withCallBudget({ budgetMs: 240_000 }, undefined).budgetMs).toBe(240_000);
  });

  it("retries a network error and does not keep the client message", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      throw new TypeError(`fetch failed ${SECRET}`);
    };
    const err = await postJson("https://example.test/v1", {}, {}, {
      ...fast, maxRetries: 1, backoffMs: 0, maxDelayMs: 0, fetchImpl, sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(LlmError);
    if (!(err instanceof LlmError)) throw err;
    expect(err).toMatchObject({ errorClass: "network", provider: "openai" });
    expect(err.message).not.toContain(SECRET);
  });

  it("does not retry a 200 that is not JSON, and does not echo the body", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return jsonResponse(200, `not-json ${SECRET}`);
    };
    const err = await postJson("https://example.test/v1", {}, {}, { ...fast, maxRetries: 3, fetchImpl }).catch((e: unknown) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(LlmError);
    if (!(err instanceof LlmError)) throw err;
    expect(err).toMatchObject({ errorClass: "parse", status: 200 });
    expect(err.message).not.toContain(SECRET);
  });

  it("does not start another attempt after the caller aborts", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      ctl.abort();
      return jsonResponse(503, SECRET);
    };
    await expect(postJson("https://example.test/v1", {}, {}, {
      ...fast, maxRetries: 4, signal: ctl.signal, fetchImpl, sleep: async () => { throw new Error("slept"); },
    })).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });

  it("does not call the provider when the signal is already aborted", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return jsonResponse(200, "{}"); };
    await expect(postJson("https://example.test/v1", {}, {}, { ...fast, signal: ctl.signal, fetchImpl })).rejects.toBeTruthy();
    expect(calls).toBe(0);
  });

  it("stops retrying once the call budget is spent", async () => {
    let t = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls++;
      t += 30_000;
      return jsonResponse(503, SECRET);
    };
    const err = await postJson("https://example.test/v1", {}, {}, {
      providerId: "openai", timeoutMs: 30_000, maxRetries: 5, budgetMs: 70_000, backoffMs: 1_000, maxDelayMs: 4_000,
      random: () => 1, now: () => t, fetchImpl, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    if (!(err instanceof LlmError)) throw err;
    expect(err).toMatchObject({ errorClass: "http_5xx", status: 503 });
    expect(err.message).not.toContain(SECRET);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });
});

describe("error classification", () => {
  it("maps known failures and never copies the message", () => {
    const secret = new SyntaxError(`Unexpected token, "${SECRET}" is not valid JSON`);
    expect(classifyLlmFailure(secret, "openai")).toEqual({ errorClass: "parse", provider: "openai" });
    expect(formatLlmFailure(classifyLlmFailure(secret, "openai"))).not.toContain(SECRET);
    const zod = Object.assign(new Error(`[{"message":"${SECRET}"}]`), { name: "ZodError" });
    expect(classifyLlmFailure(zod, "anthropic").errorClass).toBe("schema");
    expect(formatLlmFailure(classifyLlmFailure(zod, "anthropic"))).not.toContain(SECRET);
    const http = Object.assign(new Error(SECRET), { status: 502 });
    expect(classifyLlmFailure(http, "zai")).toEqual({ errorClass: "http_5xx", provider: "zai", status: 502 });
    expect(new LlmError("http_429", { provider: "openai", status: 429 }).message).toBe("class=http_429 provider=openai status=429");
  });
});

describe("Workers AI binding", () => {
  it("times out a hung run without putting the prompt on the error", async () => {
    const ai: WorkersAiBinding = { run: () => new Promise(() => {}) };
    const p = new WorkersAiProvider(ai, "@cf/test", undefined, { providerId: "workers-ai", timeoutMs: 30, maxRetries: 0, budgetMs: 200, sleep: async () => {} });
    const err = await p.complete({ system: "s", user: SECRET, maxOutputTokens: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    if (!(err instanceof LlmError)) throw err;
    expect(err).toMatchObject({ errorClass: "timeout", provider: "workers-ai" });
    expect(err.message).not.toContain(SECRET);
  });

  it("retries a 503 from the binding and does not retry a 401", async () => {
    let calls = 0;
    const ai: WorkersAiBinding = {
      run: async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error(`upstream ${SECRET}`), { status: 503 });
        return { response: "hello" };
      },
    };
    const sleeps: number[] = [];
    const p = new WorkersAiProvider(ai, "@cf/test", undefined, {
      providerId: "workers-ai", timeoutMs: 5_000, maxRetries: 2, budgetMs: 20_000, backoffMs: 10, maxDelayMs: 10, random: () => 1,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await expect(p.complete({ system: "s", user: "u", maxOutputTokens: 20 })).resolves.toBe("hello");
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(2);

    let authCalls = 0;
    const denied: WorkersAiBinding = {
      run: async () => { authCalls++; throw Object.assign(new Error(SECRET), { status: 401 }); },
    };
    const q = new WorkersAiProvider(denied, "@cf/test", undefined, { providerId: "workers-ai", maxRetries: 3, timeoutMs: 5_000, budgetMs: 20_000, sleep: async () => { throw new Error("slept"); } });
    const err = await q.complete({ system: "s", user: SECRET, maxOutputTokens: 20 }).catch((e: unknown) => e);
    expect(authCalls).toBe(1);
    expect(err).toBeInstanceOf(LlmError);
    if (!(err instanceof LlmError)) throw err;
    expect(err).toMatchObject({ errorClass: "http_4xx", status: 401 });
    expect(err.message).not.toContain(SECRET);
  });
});
