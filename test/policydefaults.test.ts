import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { DEFAULT_POLICY_FILES, loadPolicies } from "../core/policy.js";

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
