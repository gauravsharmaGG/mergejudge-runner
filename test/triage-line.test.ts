import { describe, expect, it } from "vitest";
import { evaluateRubric, lenientLine } from "../core/rubrics.js";
import { parseTriageOutput, validateAgainstFiles } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

// Shape of the Workers AI DeepSeek V4.1 Flash replies that failed the whole free review as "parse"
// (Nov 20, a 10-line workflow PR; reproduced 5/5): "line" holds the diff line text instead of a number.
const PATCH = [
  "@@ -6,7 +6,7 @@ on:",
  "       - cron: '0 */6 * * *'",
  " ",
  " concurrency:",
  "-  group: scan-${{ github.run_id }}",
  "+  group: scan",
  "   cancel-in-progress: false",
  " ",
  " permissions:",
  "@@ -73,6 +73,9 @@ jobs:",
  "         run: |",
  "           python tools/scan.py --output report.json",
  " ",
  "+      - name: Upload inventory artifact",
  "+        uses: actions/upload-artifact@v4",
  "+          retention-days: 1",
].join("\n");
const pf: PrFile = { path: ".github/workflows/scan.yml", status: "renamed", additions: 4, deletions: 1, patch: PATCH, previousPath: ".github/workflows/old.yml" };
const reply = (findings: unknown[]) => JSON.stringify({ summary: "Renames the scan workflow.", files: [{ path: pf.path, lane: "review", reason: "workflow", findings }] });

describe("lenientLine", () => {
  it("keeps numbers and the prompt's L<n> form", () => {
    expect(lenientLine(9)).toBe(9);
    expect(lenientLine("76")).toBe(76);
    expect(lenientLine("L76")).toBe(76);
    expect(lenientLine("L76 +      - name: Upload")).toBe(76);
    expect(lenientLine(" l9 +x")).toBe(9);
  });
  it("drops code text, junk and non-positive numbers", () => {
    for (const v of ["  group: scan", "+      - name: Upload", "10 * x", "L9x", "", null, undefined, {}, 0, -3, 2.5, NaN]) expect(lenientLine(v)).toBeUndefined();
  });
});

describe("parseTriageOutput with a non-numeric line", () => {
  it("no longer throws for the failing reply shape (code in line)", () => {
    const out = parseTriageOutput(reply([
      { line: "  group: scan", quote: "  group: scan", message: "fixed group serialises runs", severity: "nit", pre_existing: false },
      { line: "+      - name: Upload inventory artifact", quote: "+      - name: Upload inventory artifact", message: "inventory is public", severity: "important" },
    ]));
    expect(out.files[0]!.findings.map((f) => f.line)).toEqual([undefined, undefined]);
  });

  it("recovers the line from a unique quote and keeps it inline", () => {
    const r = validateAgainstFiles(parseTriageOutput(reply([
      { line: "  group: scan", quote: "  group: scan", message: "fixed group" },
      { line: "+      - name: Upload inventory artifact", quote: "+      - name: Upload inventory artifact", message: "public artifact", severity: "important" },
    ])), [pf]);
    expect(r.findings.map((f) => [f.line, f.severity])).toEqual([[9, undefined], [76, "important"]]);
  });

  it("uses the L<n> prefix form directly", () => {
    const r = validateAgainstFiles(parseTriageOutput(reply([
      { line: "L77 +        uses: actions/upload-artifact@v4", quote: "uses: actions/upload-artifact@v4", message: "pin by sha" },
    ])), [pf]);
    expect(r.findings[0]).toMatchObject({ line: 77, quote: "uses: actions/upload-artifact@v4" });
  });

  it("keeps a finding file-level when the quote is missing, ambiguous or not in the diff", () => {
    const amb: PrFile = { ...pf, patch: "@@ -1,2 +1,3 @@\n same_line();\n+same_line();\n tail();" };
    const r = validateAgainstFiles(parseTriageOutput(JSON.stringify({ summary: "s", files: [
      { path: pf.path, lane: "review", reason: "", findings: [{ line: "whatever", message: "no quote" }, { line: "x", quote: "not in the diff at all", message: "bad quote" }] },
    ] })), [pf]);
    expect(r.findings.map((f) => f.line)).toEqual([undefined, undefined]);
    const r2 = validateAgainstFiles(parseTriageOutput(JSON.stringify({ summary: "s", files: [
      { path: amb.path, lane: "review", reason: "", findings: [{ line: "same_line();", quote: "same_line();", message: "dup" }] },
    ] })), [amb]);
    expect(r2.findings[0]!.line).toBeUndefined();
  });

  it("a numeric line still wins over the quote lookup", () => {
    const r = validateAgainstFiles(parseTriageOutput(reply([{ line: 9, quote: "group: scan", message: "m" }])), [pf]);
    expect(r.findings[0]!.line).toBe(9);
  });
});

describe("rubric evidence line", () => {
  it("accepts code text in evidence.line instead of failing the reply", () => {
    const out = parseTriageOutput(JSON.stringify({ summary: "s", files: [], rubric: [
      { id: "c1", result: "fail", justification: "j", evidence: { path: pf.path, line: "+  group: scan", quote: "group: scan" } },
    ] }));
    const res = evaluateRubric(out.rubric, [{ id: "c1", question: "Is it fine?" } as never], [pf]);
    expect(res[0]).toMatchObject({ id: "c1" });
  });
});
