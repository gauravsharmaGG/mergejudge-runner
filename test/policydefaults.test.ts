import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { DEFAULT_POLICY_FILES, loadPolicies } from "../core/policy.js";
import type { LlmProvider, LlmResult } from "../core/llm/provider.js";
import { produceReviewResult } from "../core/review.js";
import type { PrFile } from "../core/types.js";

describe("default policy files", () => {
  it("include REVIEW.md next to REVIEW_POLICY.md, AGENTS.md and CLAUDE.md", () => {
    expect(DEFAULT_POLICY_FILES).toEqual(["REVIEW_POLICY.md", "REVIEW.md", "APPROVAL_POLICY.md", "AGENTS.md", "CLAUDE.md"]);
    expect(parseConfig("").policy_files).toEqual(DEFAULT_POLICY_FILES);
  });

  it("an explicit policy_files list still replaces the defaults", () => {
    expect(parseConfig("policy_files: [docs/RULES.md]").policy_files).toEqual(["docs/RULES.md"]);
  });

  it("a repo with only REVIEW.md gets it into the prompt and the others listed as missing", async () => {
    const files: Record<string, string> = { "REVIEW.md": "# Review\nNo nits." };
    const p = await loadPolicies(DEFAULT_POLICY_FILES, async (x) => files[x] ?? null);
    expect(p.used).toEqual([{ path: "REVIEW.md", truncated: false }]);
    expect(p.text).toContain("--- REVIEW.md ---\n# Review\nNo nits.");
    expect(p.skipped).toEqual(["REVIEW_POLICY.md", "APPROVAL_POLICY.md", "AGENTS.md", "CLAUDE.md"]);
  });
});

describe("Not checked: policy files line", () => {
  const reply = JSON.stringify({ summary: "ok", files: [{ path: "a.ts", lane: "review", reason: "logic", findings: [] }] });
  const provider: LlmProvider = {
    label: "fake", providerId: "openai",
    complete: async () => reply,
    completeEx: async (): Promise<LlmResult> => ({ text: reply, truncated: false, usage: null }),
  };
  const run = (repoFiles: Record<string, string>, cfgText = "provider:\n  type: openai\n  model: fake\n") => produceReviewResult({
    pr: { number: 1, node_id: "n", head: { sha: "abcdef0" }, title: "T", body: "" } as never, cfg: parseConfig(cfgText), cfgRef: "main",
    files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }] as PrFile[],
    provider, log: { info: () => {}, warning: () => {} },
    readRepoFile: async (p: string) => repoFiles[p] ?? null,
    contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
  } as never);

  it("does not call the other default files missing when REVIEW.md was loaded", async () => {
    const r = await run({ "REVIEW.md": "# Review\nNo nits." });
    expect(r.body).not.toMatch(/Policy files? missing/);
    expect(r.body).not.toContain("REVIEW\\_POLICY.md");
  });

  it("does not call the others missing when only CLAUDE.md was loaded", async () => {
    const r = await run({ "CLAUDE.md": "Prefer small functions." });
    expect(r.body).not.toMatch(/Policy files? missing/);
  });

  it("lists every default file, REVIEW.md included, when none was found", async () => {
    const r = await run({});
    const line = r.body.split("\n").find((l) => l.includes("Policy files missing or empty"));
    expect(line).toBe("- Policy files missing or empty: REVIEW\\_POLICY.md, REVIEW.md, APPROVAL\\_POLICY.md, AGENTS.md, CLAUDE.md");
  });

  it("says nothing about policy files when policy_files is empty", async () => {
    const r = await run({}, "provider:\n  type: openai\n  model: fake\npolicy_files: []\n");
    expect(r.body).not.toMatch(/Policy files? missing/);
  });
});
