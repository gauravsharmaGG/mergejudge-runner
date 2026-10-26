import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import type { LlmProvider } from "../core/llm/provider.js";
import { produceReviewResult } from "../core/review.js";
import type { PrFile } from "../core/types.js";
import { applySecondPass, SECOND_PASS_RULES } from "../src/ai.js";
import { main } from "../src/cli.js";
import { aiModeOf, explicitReviewMode, verifyFindingEvidence, withAiMode } from "../src/deep.js";

const QUOTE = "export function charge(user) { return user.balance - 1; }";
const patch = `@@ -1,2 +1,3 @@\n context\n-old\n+${QUOTE}`;
const docs: PrFile = { path: "docs/guide.md", status: "modified", additions: 2, deletions: 1, patch };
const workflow: PrFile = { path: ".github/workflows/ci.yml", status: "modified", additions: 2, deletions: 1, patch };

const first = {
  summary: "Docs edit.",
  files: [{ path: "docs/guide.md", lane: "auto" as const, reason: "docs only", findings: [] as { line: number; quote?: string; message: string }[] }],
};
const second = {
  summary: "second",
  files: [{
    path: "docs/guide.md",
    lane: "auto" as const,
    reason: "balance can go negative",
    findings: [
      { line: 2, quote: "this line was never in the diff", message: "invented bug" },
      { line: 2, quote: QUOTE, message: "balance can go negative" },
      { line: 9, quote: QUOTE, message: "line is not in the hunk" },
    ],
  }],
};

function provider(complete: LlmProvider["complete"]): LlmProvider {
  return { label: "gpt-test", providerId: "openai", complete };
}

const pr = { number: 7, title: "t", body: "", node_id: "n", head: { sha: "a".repeat(40) }, user: { login: "u", type: "User" } };

describe("verifyFindingEvidence", () => {
  it("keeps a quote that matches the diff at a hunk line", () => {
    const f = verifyFindingEvidence({ path: "docs/guide.md", line: 2, quote: QUOTE, message: "balance can go negative" }, [docs]);
    expect(f).toEqual({ path: "docs/guide.md", line: 2, quote: QUOTE, message: "balance can go negative" });
  });

  it("drops a finding whose quote is missing, unknown, or off the diff", () => {
    expect(verifyFindingEvidence({ path: "docs/guide.md", line: 2, message: "no quote" }, [docs])).toBeNull();
    expect(verifyFindingEvidence({ path: "docs/guide.md", line: 2, quote: "nope not here", message: "invented" }, [docs])).toBeNull();
    expect(verifyFindingEvidence({ path: "other.ts", line: 2, quote: QUOTE, message: "wrong file" }, [docs])).toBeNull();
    expect(verifyFindingEvidence({ path: "docs/guide.md", line: 9, quote: QUOTE, message: "bad line" }, [docs])).toBeNull();
    expect(verifyFindingEvidence({ path: "docs/guide.md", line: 2, quote: "abc", message: "too short" }, [docs])).toBeNull();
  });
});

describe("applySecondPass", () => {
  it("keeps only verified quotes and does not lower a lane", () => {
    const base = {
      summary: "first",
      files: new Map([["docs/guide.md", { lane: "review" as const, reason: "needs a look" }]]),
      findings: [{ path: "docs/guide.md", line: 2, quote: QUOTE, message: "already reported" }],
      rubric: [],
    };
    const raw = {
      summary: "second",
      files: [{
        path: "docs/guide.md",
        lane: "auto" as const,
        reason: "try to lower",
        findings: [
          { line: 2, quote: "not in diff", message: "dropped" },
          { line: 2, quote: QUOTE, message: "already reported" },
          { line: 2, quote: QUOTE, message: "new cross-hunk issue" },
        ],
      }],
      rubric: [],
    };
    const applied = applySecondPass(base, raw, [docs]);
    expect(applied.kept).toBe(1);
    expect(applied.dropped).toBe(1);
    expect(applied.llm.files.get("docs/guide.md")?.lane).toBe("review");
    expect(applied.llm.findings.map((f) => f.message)).toEqual(["already reported", "new cross-hunk issue"]);
  });
});

describe("ai.mode deep", () => {
  it("defaults to fast and accepts deep", () => {
    expect(parseConfig("").ai.mode).toBe("fast");
    expect(parseConfig("ai:\n  mode: deep\n").ai.mode).toBe("deep");
    expect(() => parseConfig("ai:\n  mode: turbo\n")).toThrow(/ai\.mode/);
    expect(aiModeOf(undefined)).toBe("fast");
    expect(withAiMode(parseConfig(""), "deep").ai.mode).toBe("deep");
  });

  it("posts a second-pass finding only when the quote matches, and raises the lane", async () => {
    let n = 0;
    const cfg = parseConfig("provider:\n  type: openai\n  model: gpt-test\nai:\n  mode: deep\n");
    const result = await produceReviewResult({
      pr, cfg, cfgRef: "main", files: [docs],
      provider: provider(async (req) => {
        n++;
        if (n === 1) {
          expect(req.system).not.toContain("Second pass");
          return JSON.stringify(first);
        }
        expect(req.system).toContain("falsify");
        expect(req.system).toContain("low risk, not a guarantee");
        return JSON.stringify(second);
      }),
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
      log: { info: () => {}, warning: () => {} },
    });
    expect(n).toBe(2);
    expect(result.lane).toBe("review");
    expect(result.findings.map((f) => f.message)).toEqual(["balance can go negative"]);
    expect(result.findings[0]).toMatchObject({ line: 2, quote: QUOTE });
    expect(result.body).toContain("Second pass kept 1 finding");
    expect(result.body).not.toContain("this line was never in the diff");
    expect(result.usage.breakdown?.second_pass).toBeGreaterThan(0);
  });

  it("fast mode does not run the second pass", async () => {
    let n = 0;
    const cfg = parseConfig("provider:\n  type: openai\n  model: gpt-test\n");
    const result = await produceReviewResult({
      pr, cfg, cfgRef: "main", files: [docs],
      provider: provider(async () => { n++; return JSON.stringify(first); }),
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
      log: { info: () => {}, warning: () => {} },
    });
    expect(n).toBe(1);
    expect(result.lane).toBe("auto");
    expect(result.findings).toEqual([]);
    expect(result.usage.breakdown?.second_pass).toBeUndefined();
  });

  it("keeps the rules floor when the second pass tries to mark a protected path auto", async () => {
    const cfg = parseConfig("provider:\n  type: openai\n  model: gpt-test\nai:\n  mode: deep\n");
    const result = await produceReviewResult({
      pr, cfg, cfgRef: "main", files: [workflow],
      provider: provider(async () => JSON.stringify({
        summary: "workflow",
        files: [{ path: workflow.path, lane: "auto", reason: "looks safe", findings: [{ line: 2, quote: QUOTE, message: "unchecked balance" }] }],
      })),
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
      log: { info: () => {}, warning: () => {} },
    });
    expect(result.lane).toBe("review");
    expect(result.agg.files[0]?.lane).toBe("review");
    expect(result.findings).toHaveLength(1);
  });

  it("clears a non-abort engine failure so the first pass is still posted", async () => {
    let n = 0;
    const cfg = parseConfig("provider:\n  type: openai\n  model: gpt-test\nai:\n  mode: deep\n");
    const engine = {
      label: "runner:claude-code",
      providerId: "claude-code",
      fatal: null as { kind: string; message: string } | null,
      async complete() {
        n++;
        if (n === 1) return JSON.stringify({
          summary: "first",
          files: [{ path: docs.path, lane: "review", reason: "logic", findings: [{ line: 2, quote: QUOTE, message: "from pass 1" }] }],
        });
        this.fatal = { kind: "exit", message: "engine exited with code 1" };
        throw this.fatal;
      },
    };
    const result = await produceReviewResult({
      pr, cfg, cfgRef: "main", files: [docs],
      provider: engine,
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
      log: { info: () => {}, warning: () => {} },
    });
    expect(n).toBe(2);
    expect(engine.fatal).toBeNull();
    expect(result.findings.map((f) => f.message)).toEqual(["from pass 1"]);
    expect(result.body).toContain("Second pass unavailable");
  });

  it("keeps the first pass when the second pass fails", async () => {
    let n = 0;
    const cfg = parseConfig("provider:\n  type: openai\n  model: gpt-test\nai:\n  mode: deep\n");
    const logs: string[] = [];
    const result = await produceReviewResult({
      pr, cfg, cfgRef: "main", files: [docs],
      provider: provider(async () => {
        n++;
        if (n === 1) return JSON.stringify({
          summary: "first",
          files: [{ path: docs.path, lane: "review", reason: "logic", findings: [{ line: 2, quote: QUOTE, message: "from pass 1" }] }],
        });
        throw new Error("provider down");
      }),
      readRepoFile: async () => null,
      contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
      log: { info: (m) => logs.push(m), warning: (m) => logs.push(m) },
    });
    expect(n).toBe(3);
    expect(result.findings.map((f) => f.message)).toEqual(["from pass 1"]);
    expect(result.body).toContain("Second pass unavailable");
    expect(result.body).not.toContain("provider down");
    expect(logs.join("\n")).not.toContain("provider down");
  });
});

describe("review mode switches", () => {
  it("resolves --deep, --mode, review_mode, MERGEJUDGE_MODE and INPUT_REVIEW_MODE", () => {
    expect(explicitReviewMode({ deepFlag: true })).toBe("deep");
    expect(explicitReviewMode({ flag: "deep" })).toBe("deep");
    expect(explicitReviewMode({ flag: "fast" })).toBe("fast");
    expect(explicitReviewMode({ reviewMode: "deep", env: { MERGEJUDGE_MODE: "fast" } })).toBe("deep");
    expect(explicitReviewMode({ env: { MERGEJUDGE_MODE: "deep" } })).toBe("deep");
    expect(explicitReviewMode({ env: { INPUT_REVIEW_MODE: "deep" } })).toBe("deep");
    expect(explicitReviewMode({ env: { MERGEJUDGE_MODE: "fast", INPUT_REVIEW_MODE: "deep" } })).toBe("fast");
    expect(explicitReviewMode({})).toBeUndefined();
    expect(() => explicitReviewMode({ flag: "turbo" })).toThrow(/fast or deep/);
    expect(() => explicitReviewMode({ deepFlag: true, flag: "fast" })).toThrow(/conflicts/);
  });

  it("CLI --help documents --deep and --mode, and a bad mode exits 2", async () => {
    const out: string[] = [];
    expect(await main(["run", "--help"], { out: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).toContain("--deep");
    expect(out.join("\n")).toContain("--mode fast|deep");
    const errs: string[] = [];
    expect(await main(["run", "--mode", "turbo"], { err: (l) => errs.push(l) })).toBe(2);
    expect(errs.join("\n")).toMatch(/fast or deep/);
    errs.length = 0;
    expect(await main(["run", "--deep", "--mode", "fast"], { err: (l) => errs.push(l) })).toBe(2);
    expect(errs.join("\n")).toMatch(/conflicts/);
  });
});

describe("copy", () => {
  it("the bench section and the second-pass prompt avoid em dashes, en dashes and arrows", () => {
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    const start = readme.indexOf("## Martian Code-Review-Bench");
    const end = readme.indexOf("## Quiet by default");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start, end);
    expect(section).toContain("75.9%");
    expect(section).toContain("38.0%");
    expect(section).toContain("50.6%");
    expect(section).toContain("1.58");
    expect(section).toContain("60");
    expect(section).toContain("19");
    expect(section).toContain("~28s");
    expect(section).toContain("75.0%");
    expect(section).toContain("28.5%");
    expect(section).toContain("41.3%");
    expect(section).toContain("1.20");
    expect(section).toContain("45");
    expect(section).toContain("15");
    expect(section).toContain("~15s");
    expect(section).toContain("78.3%");
    expect(section).toContain("42.7%");
    expect(section).toContain("55.3%");
    expect(section).toContain("low risk, not a guarantee");
    expect(section).not.toMatch(/[—–→]/);
    expect(SECOND_PASS_RULES).not.toMatch(/[—–→]/);
    expect(SECOND_PASS_RULES).toContain("low risk, not a guarantee");
  });
});
