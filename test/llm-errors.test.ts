import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { LlmError } from "../core/llm/http.js";
import type { LlmProvider } from "../core/llm/provider.js";
import { aiUnavailableNote, produceReviewResult } from "../core/review.js";
import { retryInstruction, runTriage } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const SECRET = "CUSTOMER_FN_export function pay(){return 42}";
const file: PrFile = { path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" };
const cfg = parseConfig("provider:\n  type: openai\n  model: gpt-test\n");

function provider(complete: LlmProvider["complete"]): LlmProvider {
  return { label: "gpt-test", providerId: "openai", complete };
}

describe("AI failure text", () => {
  it("repair prompt does not quote the parser or the model reply", () => {
    expect(retryInstruction(false)).toBe(
      "REPAIR: Your previous reply was not valid JSON. Respond with compact JSON only, no reasoning text, keep findings short. Reply with ONLY a single JSON object matching the schema. No markdown fences, no prose.",
    );
    expect(retryInstruction(true)).toContain("cut off at the output limit");
    expect(retryInstruction(false)).not.toContain(SECRET);
  });

  it("logs and returns only the error class when the model reply is not JSON", async () => {
    const logs: string[] = [];
    const seen: string[] = [];
    let n = 0;
    const res = await runTriage(provider(async (req) => {
      seen.push(req.user);
      n++;
      if (n === 1) return `not json ${SECRET} {"summary":`;
      return JSON.stringify({ summary: "ok", files: [{ path: "a.ts", lane: "review", reason: "logic", findings: [] }] });
    }), { title: "t", body: "", files: [file] }, cfg, {}, (m) => logs.push(m));
    expect(res.llm?.summary).toBe("ok");
    expect(logs.join("\n")).toContain("class=parse");
    expect(logs.join("\n")).toContain("provider=openai");
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(seen[1]).not.toContain(SECRET);
    expect(seen[1]).toContain("not valid JSON");
  });

  it("classifies a schema failure without logging the model text", async () => {
    const logs: string[] = [];
    const res = await runTriage(provider(async () => JSON.stringify({
      summary: SECRET, files: [{ path: "a.ts", lane: "nope-lane", reason: SECRET, findings: [] }],
    })), { title: "t", body: "", files: [file] }, cfg, {}, (m) => logs.push(m), (m) => logs.push(m));
    expect(res.llm).toBeNull();
    expect(res.error).toBe("schema");
    expect(logs.join("\n")).toContain("class=schema provider=openai");
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain("nope-lane");
  });

  it("turns a provider failure into a generic rules-only comment", async () => {
    const logs: string[] = [];
    const boom = new LlmError("timeout", { provider: "openai" });
    const raw = new Error(`LLM HTTP 500: ${SECRET}`);
    for (const fail of [boom, raw]) {
      logs.length = 0;
      const result = await produceReviewResult({
        pr: { number: 7, title: "t", body: "", node_id: "n", head: { sha: "a".repeat(40) }, user: { login: "u", type: "User" } },
        cfg, cfgRef: "main", files: [file],
        provider: provider(async () => { throw fail; }),
        readRepoFile: async () => null,
        contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
        log: { info: (m) => logs.push(m), warning: (m) => logs.push(m) },
      });
      expect(result.body).toContain("AI review unavailable");
      expect(result.body).not.toContain(SECRET);
      expect(result.body).not.toContain("LLM triage failed");
      expect(result.body).not.toContain("LLM HTTP");
      expect(logs.join("\n")).not.toContain(SECRET);
    }
    expect(aiUnavailableNote("timeout")).toBe("AI review unavailable (timeout).");
    expect(aiUnavailableNote("parse", true)).toBe("AI review unavailable (parse). Output was cut off at the token limit.");
    expect(aiUnavailableNote("http_429")).not.toContain(SECRET);
  });
});
