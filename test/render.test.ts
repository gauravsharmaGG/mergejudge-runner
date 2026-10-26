import { describe, expect, it } from "vitest";
import { AUTO_MERGE_NOTE, MERGE_NOTE, mergeNote, renderComment } from "../core/render.js";

const agg = { lane: "review" as const, files: [], labelReasons: [], summary: "s", rubric: [] };
const render = (approval?: { enabled?: boolean; mode?: string } | null) =>
  renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], approval });

describe("comment footer merge note", () => {
  it("has the exact cleared wording", () => {
    expect(MERGE_NOTE).toBe("MergeJudge doesn't merge PRs itself.");
    expect(AUTO_MERGE_NOTE).toBe("With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs.");
  });

  it("says only the first sentence without auto-merge-only", () => {
    for (const a of [undefined, null, { enabled: false, mode: "auto-merge-only" }, { enabled: true, mode: "none" }, { enabled: true, mode: "bot-approve" }]) {
      const md = render(a);
      expect(md).toContain(" · MergeJudge doesn't merge PRs itself.</sub>");
      expect(md).not.toContain("auto-merge-only");
      expect(md).not.toContain("never merges");
    }
  });

  it("adds the auto-merge sentence when approval is enabled with mode auto-merge-only", () => {
    expect(mergeNote({ enabled: true, mode: "auto-merge-only" })).toBe(`${MERGE_NOTE} ${AUTO_MERGE_NOTE}`);
    expect(render({ enabled: true, mode: "auto-merge-only" }))
      .toContain(" · MergeJudge doesn't merge PRs itself. With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs.</sub>");
  });
});

describe("AI reason and lane explanation", () => {
  const file = (o: object) => ({ path: "a.py", lane: "review" as const, reasons: ["code file"], additions: 1, deletions: 0, ...o });
  const mk = (files: object[], extra: object = {}) =>
    renderComment({ agg: { ...agg, files, ...extra } as never, mode: "m", tokensEstimate: 0, notes: [] });

  it("shows an escaped, capped AI reason for review files", () => {
    const md = mk([file({ llmReason: "adds <b>new</b> logic " + "x".repeat(300) })]);
    expect(md).toContain("code file; AI: adds \\<b\\>new\\</b\\> logic");
    expect(md).toContain("…");
    expect(md).not.toContain("x".repeat(210));
  });

  it("does not repeat a reason already present or show it for auto files", () => {
    expect(mk([file({ llmReason: "code file" })])).not.toContain("AI:");
    expect(mk([file({ lane: "auto", llmReason: "typo" })], { lane: "auto" })).not.toContain("AI:");
  });

  it("omits the details block for one reason and keeps it for several", () => {
    expect(mk([file({})])).not.toContain("Why this lane? Details");
    expect(mk([file({}), file({ path: "b.py" })])).toContain("Why this lane? Details");
  });
});

describe("sticky report order", () => {
  for (const laneMap of [false, true]) for (const count of [1, 30]) {
    it(`orders ${count} files with lane map ${laneMap}`, () => {
      const files = Array.from({ length: count }, (_, i) => ({ path: `src/${i}.ts`, lane: "review" as const, reasons: ["review reason"] }));
      const input = { ...agg, lane: "block" as const, files, rubric: [
        { id: "info", severity: "low" as const, verdict: "fail" as const, justification: "informational detail" },
        { id: "blocker", severity: "high" as const, verdict: "fail" as const, justification: "blocking detail", raiseTo: "block" as const },
      ] };
      const before = JSON.stringify(input);
      const md = renderComment({ agg: input, mode: "model", tokensEstimate: 1, laneMap,
        notes: ["AI budget exhausted", "quiet-evidence suppressed comments", "Skipped files: vendor/a.ts"],
        fileFindings: [{ path: "src/0.ts", message: "unverified detail" }] });
      const sections = ["**Overall lane:**", "Why this lane?", "### Findings", "#### Block", "blocking detail", "#### Review", "#### Informational", "informational detail",
        ...(laneMap ? ["### 🗺️ Lane choice map"] : []), "### Coverage gaps", "AI budget exhausted", "unverified detail"];
      for (let i = 1; i < sections.length; i++) {
        expect(md.indexOf(sections[i - 1]!)).toBeGreaterThanOrEqual(0);
        expect(md.indexOf(sections[i]!)).toBeGreaterThan(md.indexOf(sections[i - 1]!));
      }
      expect(md.match(/Overall lane:/g)).toHaveLength(1);
      expect(md.match(/Why this lane\? /g)).toHaveLength(1);
      expect(md).toContain("quiet-evidence suppressed comments");
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});
