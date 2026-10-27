import { describe, expect, it } from "vitest";
import { relocateQuoteAcrossFiles, resolveLineFromQuote } from "../core/rubrics.js";
import type { PrFile } from "../core/types.js";

const patch = ["@@ -1,3 +10,5 @@", " const a = 1;", "+const total = compute(a);", " const b = 2;", "+return total + b;", " done();"].join("\n");
const file = (path: string, p?: string): PrFile => ({ path, status: "modified", additions: 1, deletions: 0, ...(p !== undefined ? { patch: p } : {}) });

describe("resolveLineFromQuote", () => {
  it("finds the exact line", () => expect(resolveLineFromQuote("const total = compute(a);", patch)).toBe(11));
  it("strips L<n> and +/- prefixes", () => expect(resolveLineFromQuote("L11 +const total = compute(a);", patch, 11)).toBe(11));
  it.each([1, 2, 3])("corrects a hint off by %i", (d) => expect(resolveLineFromQuote("return total + b;", patch, 13 + d)).toBe(13));
  it("keeps a hint that is already right", () => expect(resolveLineFromQuote("const total", patch, 11)).toBe(11));
  it("handles multi-line quotes, anchoring on the last line", () =>
    expect(resolveLineFromQuote("+const total = compute(a);\n const b = 2;", patch, 5)).toBe(12));
  it("returns null when missing, too short, or no patch", () => {
    expect(resolveLineFromQuote("nothing here at all", patch)).toBeNull();
    expect(resolveLineFromQuote("a=1", patch)).toBeNull();
    expect(resolveLineFromQuote("const a = 1;", undefined)).toBeNull();
  });
  it("prefers an added line over context on a tie", () => {
    const p = "@@ -1,2 +1,3 @@\n same line here\n+same line here";
    expect(resolveLineFromQuote("same line here", p, 99)).toBe(2);
    const q = "@@ -1,3 +1,3 @@\n+same line here\n x\n same line here";
    expect(resolveLineFromQuote("same line here", q, 2)).toBe(1);
  });
});

describe("relocateQuoteAcrossFiles", () => {
  const a = file("a.ts", "@@ -1,1 +1,2 @@\n x\n+unique_call_in_a();");
  const b = file("b.ts", "@@ -1,1 +5,2 @@\n y\n+other_call_in_b();");
  it("relocates a unique match", () => expect(relocateQuoteAcrossFiles("other_call_in_b();", [a, b], 2)).toEqual({ path: "b.ts", line: 6 }));
  it("same-file unique still returns that file", () => expect(relocateQuoteAcrossFiles("unique_call_in_a();", [a, b])).toEqual({ path: "a.ts", line: 2 }));
  it("returns null for 0 matches", () => expect(relocateQuoteAcrossFiles("missing_everywhere()", [a, b])).toBeNull());
  it("returns null for 2+ matches", () => {
    const c = file("c.ts", "@@ -1,1 +1,2 @@\n x\n+unique_call_in_a();");
    expect(relocateQuoteAcrossFiles("unique_call_in_a();", [a, b, c])).toBeNull();
  });
  it("ignores files without a patch", () => expect(relocateQuoteAcrossFiles("unique_call_in_a();", [a, file("z.png")])?.path).toBe("a.ts"));
});
