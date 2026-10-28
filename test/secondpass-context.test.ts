import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import { buildUserPrompt } from "../core/triage.js";
import { applySecondPass, SECOND_PASS_RULES } from "../src/ai.js";

describe("SECOND_PASS_RULES", () => {
  it("is context-aware and has no protected categories", () => {
    for (const k of ["Diff Anchor Rule", "CONTEXT", "low risk, not a guarantee"]) {
      expect(SECOND_PASS_RULES).toContain(k);
    }
    for (const k of ["Protected Defect Categories", "Ground A", "Ground B"]) {
      expect(SECOND_PASS_RULES).not.toContain(k);
    }
    expect(SECOND_PASS_RULES).not.toContain("only evidence");
    expect(SECOND_PASS_RULES).not.toMatch(/[—–→]/);
  });
});

describe("pass 2 with context", () => {
  const QUOTE = "export function charge(user, amount) { return user.balance - amount; }";
  const file = { path: "src/pay.ts", status: "modified", additions: 1, deletions: 1, patch: `@@ -1,2 +1,2 @@\n context\n-old\n+${QUOTE}` };
  const ctx = [{ path: "src/caller.ts", kind: "caller" as const, why: "calls charge", content: "charge(amount, user)", truncated: false }];

  it("renders context into the pass 2 prompt", () => {
    const built = buildUserPrompt({ title: "t", body: "", files: [file], context: ctx }, parseConfig(""), SECOND_PASS_RULES);
    expect(built.prompt).toContain("CONTEXT caller: src/caller.ts");
    expect(built.contextTokens).toBeGreaterThan(0);
  });

  it("keeps a diff-anchored cross-file finding", () => {
    const first = { summary: "", files: new Map([["src/pay.ts", { lane: "auto" as const, reason: "ok" }]]), findings: [], rubric: [] };
    const raw = { summary: "s", files: [{ path: "src/pay.ts", lane: "review" as const, reason: "caller swaps args",
      findings: [{ line: 2, quote: QUOTE, message: "src/caller.ts passes (amount, user)" }] }], rubric: [] };
    const applied = applySecondPass(first, raw, [file]);
    expect(applied.kept).toBe(1);
    expect(applied.llm.files.get("src/pay.ts")!.lane).toBe("review");
  });
});
