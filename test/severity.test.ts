import { describe, expect, it } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { unansweredFindings } from "../core/answers.js";
import { parseConfig } from "../core/config.js";
import { inlineBody, planInline } from "../core/inline.js";
import { fileFindingsOf, lineFindingsOf, preExistingOf, renderComment } from "../core/render.js";
import { findingSeverity, parseTriageOutput, validateAgainstFiles, type Finding, type LlmTriage } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

// new-side: 10 context, 11 added, 12 context
const PATCH = "@@ -10,2 +10,3 @@\n ctx_line();\n+added_line();\n tail_line();";
const pf: PrFile = { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: PATCH };
const out = (findings: unknown[], lane = "review") => JSON.stringify({ summary: "s", files: [{ path: "src/a.ts", lane, reason: "r", findings }], rubric: [] });
const validate = (findings: unknown[]) => validateAgainstFiles(parseTriageOutput(out(findings)), [pf]);

describe("schema", () => {
  it("parses with and without the new fields", () => {
    const r = validate([
      { line: 11, quote: "added_line();", message: "a", severity: "nit", pre_existing: false },
      { line: 11, quote: "added_line();", message: "b" },
    ]);
    expect(r.findings.map((f) => f.severity)).toEqual(["nit", undefined]);
    expect(r.findings.every((f) => !f.preExisting)).toBe(true);
    expect(findingSeverity(r.findings[1]!)).toBe("important");
  });
  it("treats junk values leniently", () => {
    const r = validate([{ line: 11, quote: "added_line();", message: "a", severity: "huge", pre_existing: "yes" }]);
    expect(r.findings).toEqual([{ path: "src/a.ts", line: 11, quote: "added_line();", message: "a" }]);
  });
  it("keeps preExisting when the model says so", () => {
    const r = validate([{ line: 11, quote: "added_line();", message: "a", pre_existing: true }, { line: 99, message: "file", pre_existing: true }]);
    expect(r.findings.map((f) => f.preExisting)).toEqual([true, true]);
  });
});

describe("pre-existing comes only from the model", () => {
  it("does not mark a verified context line by position alone", () => {
    const r = validate([
      { line: 10, quote: "ctx_line();", message: "ctx" },
      { line: 11, quote: "added_line();", message: "added" },
    ]);
    expect(r.findings.map((f) => [f.message, f.preExisting])).toEqual([["ctx", undefined], ["added", undefined]]);
  });
});

const added: Finding = { path: "src/a.ts", line: 11, quote: "added_line();", message: "bug <here>" };
const nit: Finding = { path: "src/a.ts", line: 12, quote: "x", message: "style", severity: "nit" };
const old: Finding = { path: "src/a.ts", line: 10, quote: "ctx_line();", message: "old bug", preExisting: true };
const fileLevel: Finding = { path: "src/a.ts", message: "file thing", severity: "nit" };
const oldFile: Finding = { path: "src/a.ts", message: "old file thing", preExisting: true };
const all = [added, nit, old, fileLevel, oldFile];

const render = (findings: Finding[]) => renderComment({
  agg: { lane: "review", files: [{ path: "src/a.ts", lane: "review", reasons: ["code"] }], labelReasons: [], summary: "s", rubric: [] },
  mode: "m", tokensEstimate: 1, notes: [],
  lineFindings: lineFindingsOf(findings), fileFindings: fileFindingsOf(findings), preExistingFindings: preExistingOf(findings),
});

describe("render", () => {
  it("tags findings and collapses pre-existing ones", () => {
    const body = render(all);
    expect(body).toContain("**Important:** bug");
    expect(body).toContain("**Nit:** style");
    expect(body).toContain("**Nit:** file thing");
    expect(body).toContain("<details><summary>Pre-existing issues (not introduced by this PR): 2</summary>");
    expect(body).toContain("src/a.ts:10 **Pre-existing:** old bug");
    expect(body).toContain("**Pre-existing:** old file thing");
    const normal = body.slice(0, body.indexOf("Pre-existing issues"));
    expect(normal).not.toContain("old bug");
  });
  it("omits the block when there are none", () => {
    expect(render([added])).not.toContain("Pre-existing");
  });
  it("tags the inline body", () => {
    expect(inlineBody({ ...added, line: 11 })).toContain("**Important:** bug");
    expect(inlineBody({ ...nit, line: 12 })).toContain("**Nit:** style");
  });
});

describe("inline selection and answer gate", () => {
  it("planInline never posts pre-existing findings", () => {
    const plan = planInline(all, []);
    expect(plan.create.map((c) => c.line)).toEqual([11, 12]);
  });
  it("answer gate ignores pre-existing findings", () => {
    expect(unansweredFindings([old], [], new Set()).open).toBe(0);
    expect(unansweredFindings([added, old], [], new Set()).open).toBe(1);
  });
});

describe("lane", () => {
  const cfg = parseConfig("");
  const file: PrFile = { path: "docs/readme.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" };
  const llm = (findings: Finding[]): LlmTriage => ({
    summary: "s", files: new Map([["docs/readme.md", { lane: "block" as const, reason: "scary" }]]), findings, rubric: [],
  });
  const lane = (findings: Finding[]) => aggregate([file], [], cfg, llm(findings));
  const f = (o: Partial<Finding>): Finding => ({ path: "docs/readme.md", message: "m", ...o });

  it("ignores the raise when every finding is pre-existing", () => {
    const a = lane([f({ preExisting: true }), f({ line: 3, quote: "q", preExisting: true })]);
    expect(a.lane).toBe("auto");
    expect(a.files[0]!.reasons).toContain("AI raise ignored: only pre-existing issues");
  });
  it("keeps the raise when mixed or without findings", () => {
    expect(lane([f({ preExisting: true }), f({})]).lane).toBe("block");
    expect(lane([]).lane).toBe("block");
  });
  it("never lowers below the rule floor", () => {
    const wf: PrFile = { path: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0 };
    const l: LlmTriage = { summary: "s", files: new Map([[wf.path, { lane: "block", reason: "x" }]]), findings: [{ path: wf.path, message: "m", preExisting: true }], rubric: [] };
    const base = aggregate([wf], [], cfg, null).lane;
    expect(aggregate([wf], [], cfg, l).lane).toBe(base);
  });
});
