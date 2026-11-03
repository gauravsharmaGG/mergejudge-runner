import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { parseConfig } from "../core/config.js";
import { FEEDBACK_MARKER, feedbackChanged, parseFeedback } from "../core/feedback.js";
import { findingText, inlineBody } from "../core/inline.js";
import { produceReviewResult } from "../core/review.js";
import {
  ACTION_MARKER, AUTO_MERGE_NOTE, CHECK_NAME, MAX_COMMENT_CHARS, MARKER, MERGE_NOTE, aiReasonNote, checkSummary, criterionLabel, diffLink,
  isSummaryBody, mergeNote, renderComment, renderNote, withSummaryMarker,
} from "../core/render.js";
import type { PrFile } from "../core/types.js";

const agg = { lane: "review" as const, files: [], labelReasons: [], summary: "s", rubric: [] };
const render = (approval?: { enabled?: boolean; mode?: string } | null) =>
  renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], approval });
const file = (o: object = {}) => ({ path: "a.py", lane: "review" as const, reasons: ["code file"], additions: 1, deletions: 0, ...o });
const mk = (files: object[], extra: object = {}, input: object = {}) =>
  renderComment({ agg: { ...agg, files, ...extra } as never, mode: "m", tokensEstimate: 0, notes: [], ...input });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const LANE_RE = /\*\*Overall lane:\*\*\s*[^\n]*`?(auto|review|block)`?/i; // core/learnflow.ts

/** Text of one top-level section: from its heading line up to the next heading or `<details>` / divider. */
const section = (md: string, start: string) => {
  const i = md.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  const rest = md.slice(i + start.length);
  return rest.slice(0, rest.search(/\n(?:### |<details>|---)/) >>> 0 || undefined);
};

describe("comment footer merge note", () => {
  it("has the exact cleared wording", () => {
    expect(MERGE_NOTE).toBe("MergeJudge doesn't merge PRs itself.");
    expect(AUTO_MERGE_NOTE).toBe("With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs.");
  });

  it("says only the first sentence without auto-merge-only", () => {
    for (const a of [undefined, null, { enabled: false, mode: "auto-merge-only" }, { enabled: true, mode: "none" }, { enabled: true, mode: "bot-approve" }]) {
      const md = render(a);
      expect(md).toContain(" · MergeJudge doesn't merge PRs itself. · To make <code>block</code> stop merges");
      expect(md).not.toContain("auto-merge-only");
      expect(md).not.toContain("never merges");
    }
  });

  it("adds the auto-merge sentence when approval is enabled with mode auto-merge-only", () => {
    expect(mergeNote({ enabled: true, mode: "auto-merge-only" })).toBe(`${MERGE_NOTE} ${AUTO_MERGE_NOTE}`);
    expect(render({ enabled: true, mode: "auto-merge-only" }))
      .toContain(" · MergeJudge doesn't merge PRs itself. With approval.mode: auto-merge-only, it asks GitHub to auto-merge auto-lane PRs. · To make");
  });

  it("is one footer line with the tip, and the run details are collapsed", () => {
    const md = render();
    expect(md.match(/<sub>/g)!.length).toBeGreaterThanOrEqual(2);
    expect(md).toContain(`~0 tokens · ${MERGE_NOTE} · To make <code>block</code> stop merges, require <code>${CHECK_NAME}</code> in branch protection.</sub>`);
    expect(md).toContain("<details><summary><sub>Run details</sub></summary>");
    expect(md.slice(md.indexOf("Run details"))).toContain("Mode: rules-only");
    expect(md.split("\n").filter((l) => l.startsWith("<sub>rules-only · ~0 tokens"))).toHaveLength(1);
  });
});

describe("AI reason and Why this lane?", () => {
  it("shows an escaped, capped AI note for review files, without a duplicated prefix", () => {
    const md = mk([file({ llmReason: "adds <b>new</b> logic " + "x".repeat(300) })]);
    expect(md).toContain("- `a.py`: adds \\<b\\>new\\</b\\> logic");
    expect(md).toContain("…");
    expect(md).not.toContain("x".repeat(210));
    expect(md).not.toMatch(/AI: AI:|AI: LLM:/);
    expect(aiReasonNote(file({ llmReason: "adds <b>x" }))).toBe("AI: adds \\<b\\>x");
  });

  it("does not repeat a reason already present or show it for auto files", () => {
    expect(mk([file({ llmReason: "code file" })])).not.toContain("AI notes");
    expect(mk([file({ lane: "auto", llmReason: "typo" })], { lane: "auto" })).not.toContain("AI notes");
  });

  it("shows the AI's raising reason once, as an AI note, not as a rule reason", () => {
    const md = mk([file({ reasons: ["code file", "LLM: touches auth"], llmReason: "touches auth", source: "rule + LLM" })]);
    const why = md.slice(md.indexOf("<b>Why this lane?</b>"), md.indexOf("</details>"));
    expect(why).toContain("- **Code file:** `a.py`");
    expect(why).toContain("AI notes:");
    expect(why.match(/touches auth/g)).toHaveLength(1);
    expect(why).not.toContain("LLM:");
  });

  it("groups files by rule, not per file, with the boilerplate stripped and no per-file duplicate", () => {
    const files = [
      file({ path: ".github/workflows/ci.yml", reasons: ["protected path"] }),
      file({ path: ".mergejudge.yml", reasons: ["MergeJudge config file (.mergejudge.yml): always needs human review", "protected path"] }),
      file({ path: "a.py", reasons: ["code file (always needs human review)"] }),
      file({ path: "b.py", reasons: ["code file (always needs human review)"] }),
    ];
    const md = mk(files);
    const why = md.slice(md.indexOf("<details><summary><b>Why this lane?</b>"), md.indexOf("</details>"));
    expect(why).toContain("4 files matched 3 rules</summary>");
    expect(why).toContain("- **Protected path:** `.github/workflows/ci.yml`, `.mergejudge.yml`");
    expect(why).toContain("- **Code file:** `a.py`, `b.py`");
    expect(why).toContain("- **MergeJudge config file \\(.mergejudge.yml\\):** `.mergejudge.yml`");
    expect(why).not.toContain("always needs human review");
    expect(md).not.toContain("Why this lane? Details");
    expect(md).not.toContain("(source:");
    // each rule reason is stated once in the whole body
    expect(why.match(/Code file/g)).toHaveLength(1);
  });

  it("caps files per rule and lists label holds", () => {
    const files = Array.from({ length: 14 }, (_, i) => file({ path: `src/f${i}.py`, reasons: ["code file (always needs human review)"] }));
    const md = mk(files, { labelReasons: ["label `hold` holds this PR"] });
    expect(md).toContain("`src/f9.py` +4 more");
    expect(md).not.toContain("`src/f10.py`,");
    expect(md).toContain("PR labels / holds:\n\n- label \\`hold\\` holds this PR");
  });

  it("keeps the literal text the hosted Worker looks for, in every lane", () => {
    for (const lane of ["auto", "review", "block"] as const)
      expect(mk([file({ lane })], { lane })).toContain("Why this lane?");
    expect(mk([], { lane: "auto" })).toContain("Why this lane?");
  });

  it("explains an auto lane in the summary", () => {
    const md = mk([file({ path: "README.md", lane: "auto", reasons: ["docs/style/static path, small change"] })], { lane: "auto" });
    expect(md).toContain("<b>Why this lane?</b> docs-only \\(1 .md file\\)</summary>");
    expect(md).toContain("- **Docs/style/static path, small change:** `README.md`");
  });
});

describe("outcome line", () => {
  const first = (md: string) => md.split("\n").find((l) => l.startsWith("**Overall lane:**"))!;

  it("counts files, problems and line comments", () => {
    const files = [file({ path: "a.py" }), file({ path: "b.py" }), file({ path: "c.md", lane: "auto", reasons: ["docs"] })];
    const rubric = [
      { id: "cor.logic", verdict: "fail", severity: "high", justification: "j", evidence: { path: "a.py", line: 3, quote: "q" } },
      { id: "cor.errors", verdict: "unverified", severity: "medium", justification: "j" },
      { id: "cor.tests", verdict: "pass", severity: "low", justification: "ok" },
    ];
    const md = mk(files, {}, {
      fileFindings: [{ path: "b.py", message: "m" }],
      lineFindings: [{ path: "a.py", line: 9, message: "x" }, { path: "a.py", line: 10, message: "y" }],
    });
    expect(first(md)).toBe("**Overall lane:** 🟡 `review` · 2 of 3 files need a human look · 1 problem found · 2 line comments");
    const withRubric = mk(files, { rubric }, { fileFindings: [{ path: "b.py", message: "m" }], lineFindings: [{ path: "a.py", line: 9, message: "x" }] });
    expect(first(withRubric)).toBe("**Overall lane:** 🟡 `review` · 2 of 3 files need a human look · 3 problems found · 1 line comment");
  });

  it("omits zero parts and words auto and block lanes correctly", () => {
    expect(first(mk([file()]))).toBe("**Overall lane:** 🟡 `review` · 1 of 1 file needs a human look");
    expect(first(mk([file({ lane: "auto" }), file({ lane: "auto" })], { lane: "auto" }))).toBe("**Overall lane:** 🟢 `auto` · all 2 files look safe to auto-merge");
    const block = mk([file({ lane: "block" })], { lane: "block" });
    expect(first(block)).toBe("**Overall lane:** 🔴 `block` · 1 of 1 file needs a human look");
    expect(block).toContain(`*\`block\` fails the \`${CHECK_NAME}\` check.*`);
    expect(mk([file()], {}, {})).toContain(`*\`review\` is advisory: the \`${CHECK_NAME}\` check stays neutral; only \`block\` fails it.*`);
    expect(mk([file({ lane: "auto" })], { lane: "auto" })).not.toContain("is advisory");
    expect(first(mk([], { lane: "review", labelReasons: ["label `x` requires review"] }))).toContain("held by PR labels");
  });

  it("states the advisory sentence once and keeps the lane regex the learning flow uses working", () => {
    for (const lane of ["auto", "review", "block"] as const) {
      const md = mk([file({ lane })], { lane }, { lineFindings: [{ path: "a.py", line: 1, message: "m" }] });
      expect(md.match(/\*\*Overall lane:\*\*/g)).toHaveLength(1);
      expect(md.match(/is advisory/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(md.match(LANE_RE)![1]).toBe(lane);
    }
  });

  it("keeps the marker first and the summary as the first plain line (what the learning flow reads)", () => {
    const md = mk([file()], { summary: "Adds a thing." });
    expect(md.startsWith(`${MARKER}\n## ⚖️ MergeJudge\n\n**Overall lane:**`)).toBe(true);
    const plain = md.split("\n").find((l) => l && !l.startsWith("<") && !l.startsWith("#") && !l.startsWith("*"));
    expect(plain).toBe("Adds a thing.");
  });

  it("gives the Action a marker the hosted App's MARKER match can never find", () => {
    expect(ACTION_MARKER).not.toContain(MARKER); // the whole point of a separate marker
    expect(withSummaryMarker(`${MARKER}\nbody`, ACTION_MARKER)).toBe(`${ACTION_MARKER}\nbody`);
    expect(isSummaryBody(`${MARKER}\nbody`)).toBe(true);
    expect(isSummaryBody(`${ACTION_MARKER}\nbody`)).toBe(true);
    expect(isSummaryBody("no marker")).toBe(false);
  });
});

describe("What to check", () => {
  const PR = "https://github.com/o/r/pull/7";
  const rubric = [
    { id: "cor.logic", verdict: "fail", severity: "high", justification: "Exits 0 on failure.", raiseTo: "block", evidence: { path: "scripts/lint.mjs", line: 19, quote: "q" } },
    { id: "cor.tests", verdict: "fail", severity: "low", score: 2, justification: "Untested.", evidence: { path: "test/a.js", line: 3, quote: "q" } },
    { id: "sec.no-unsafe-exec", verdict: "unverified", severity: "high", justification: "Maybe.", evidence: { path: "scripts/lint.mjs" } },
    { id: "custom.thing", verdict: "fail", severity: "medium", justification: "No file." },
  ];
  const files = [file({ path: "test/a.js" }), file({ path: "scripts/lint.mjs", lane: "block" }), file({ path: ".github/w.yml" })];
  const lineFindings = [
    { path: "scripts/lint.mjs", line: 19, message: "same line as the check" },
    { path: ".github/w.yml", line: 26, message: "actions: write is broad" },
    { path: ".github/w.yml", line: 26, message: "duplicate" },
    { path: ".github/w.yml", line: 37, message: "no <permission> check" },
  ];
  const md = mk(files, { rubric, lane: "block", labelReasons: ["label `hold` holds this PR"] }, { prUrl: PR, lineFindings, fileFindings: [{ path: "test/a.js", message: "unclear" }] });
  const wtc = section(md, "### What to check");

  it("groups by file, strictest file first, then whole-PR items, then label holds", () => {
    const order = ["**scripts/lint.mjs**", "**test/a.js**", "**.github/w.yml**", "**Whole PR**", "**PR labels / holds**"].map((s) => wtc.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    // block file first, then review files in first-seen order, then the pinned groups
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(order[2]).toBeLessThan(order[3]!);
    expect(order[3]).toBeLessThan(order[4]!);
  });

  it("uses plain words for checks, never raw ids", () => {
    expect(wtc).toContain("- **Logic (high):** Exits 0 on failure.");
    expect(wtc).toContain("- **Tests (low, 2/5):** Untested.");
    expect(wtc).toContain("**Security: unsafe execution (high, needs a human check):** Maybe.");
    expect(wtc).toContain("- **custom.thing (medium):** No file.");
    expect(wtc).not.toMatch(/cor\.logic|cor\.tests|sec\.no-unsafe-exec/);
    expect(criterionLabel("cor.errors")).toBe("Error handling");
    expect(criterionLabel("sec.input-handling")).toBe("Security: input handling");
    expect(criterionLabel("my.own")).toBe("my.own");
  });

  it("links diff lines with the sha256 of the path", () => {
    const h = sha("scripts/lint.mjs");
    expect(diffLink(PR, "scripts/lint.mjs", 19)).toBe(`${PR}/files#diff-${h}R19`);
    expect(wtc).toContain(`[L19](${PR}/files#diff-${h}R19)`);
    expect(wtc).toContain(`[L26](${PR}/files#diff-${sha(".github/w.yml")}R26)`);
    expect(wtc).toContain(`[diff](${PR}/files#diff-${h})`); // evidence without a line
    expect(h).toHaveLength(64);
  });

  it("lists a path:line once: a rubric item and a line finding on the same line become one bullet", () => {
    expect(wtc.match(/R19\)/g)).toHaveLength(1);
    expect(wtc).toContain("Exits 0 on failure. [L19](" + `${PR}/files#diff-${sha("scripts/lint.mjs")}R19) · line comment`);
    expect(wtc).not.toContain("same line as the check");
    expect(wtc.match(/R26\)/g)).toHaveLength(1); // two line findings on one line: one bullet
    expect(wtc).toContain("no \\<permission\\> check");
  });

  it("marks file-level findings and shows label holds", () => {
    expect(wtc).toContain("- unclear · _needs a human check (no verified line)_");
    expect(wtc).toContain("- label \\`hold\\` holds this PR");
  });

  it("falls back to plain path:line without a PR url", () => {
    const plain = section(mk(files, { rubric, lane: "block" }, { lineFindings }), "### What to check");
    expect(plain).not.toContain("](");
    expect(plain).toContain("scripts/lint.mjs:19");
    expect(plain).toContain(".github/w.yml:37");
  });

  it("says so when nothing is flagged and caps long lists", () => {
    expect(mk([file({ lane: "auto" })], { lane: "auto" })).toContain("### What to check\n\nNothing specific flagged.");
    const many = Array.from({ length: 150 }, (_, i) => ({ path: "a.ts", line: i + 1, message: `m${i}` }));
    const body = mk([file({ path: "a.ts" })], {}, { lineFindings: many });
    expect(body).toContain("…and 50 more not shown (150 in total)");
    expect(body).not.toContain("m149");
  });

  it("ignores an unsafe prUrl", () => {
    const bad = section(mk(files, { rubric }, { prUrl: "javascript:alert(1)", lineFindings }), "### What to check");
    expect(bad).not.toContain("](");
  });
});

describe("Files section", () => {
  const paths = (n: number) => Array.from({ length: n }, (_, i) => `pkg${i % 4}/f${i}.ts`);
  const many = (n: number, autos = 0) => [
    ...paths(n).map((path) => file({ path, reasons: ["code file (always needs human review)"] })),
    ...Array.from({ length: autos }, (_, i) => file({ path: `docs/d${i}.md`, lane: "auto", reasons: ["docs/style/static path, small change"] })),
  ];

  it("is a collapsed bullet list with no wide table, raiser tag or map boilerplate", () => {
    for (const laneMap of [false, true]) {
      const md = mk(many(3, 2), {}, { laneMap });
      expect(md).toContain("<details><summary><b>Files (5):</b> 3 review · 2 auto</summary>");
      expect(md).toContain("- 🟡 `pkg0/f0.ts` — Code file");
      expect(md).toContain("- 🟢 `docs/d0.md` — Docs/style/static path, small change");
      expect(md).not.toMatch(/raiser|Raisers first|The map only explains|Lane choice map|🗺️|\| Source \||\| Reason \|/i);
      expect(md.indexOf("- 🟡 `pkg0/f0.ts`")).toBeLessThan(md.indexOf("- 🟢 `docs/d0.md`"));
    }
  });

  it("adds the folder table only with lane_map on and more than 15 files", () => {
    expect(mk(many(15), {}, { laneMap: true })).not.toContain("| Folder |");
    expect(mk(many(16), {}, { laneMap: false })).not.toContain("| Folder |");
    const big = mk(many(16), {}, { laneMap: true });
    expect(big).toContain("| Folder | 🟢 auto | 🟡 review | 🔴 block |");
    expect(big).toContain("| pkg0 | 0 | 4 | 0 |");
    expect(big).not.toContain("```mermaid");
  });

  it("lists safe files once and gives the split suggestion as one sentence", () => {
    const md = mk(many(2, 3), {});
    expect(md.match(/`docs\/d0\.md`/g)).toHaveLength(1);
    expect(md).toContain("The 3 auto files could go in a separate auto-mergeable PR.");
    expect(md).not.toContain("Split suggestion");
    expect(md).not.toContain("Safe files");
    expect(mk(many(2, 1), {})).toContain("The 1 auto file could go");
    expect(mk(many(0, 2), { lane: "auto" })).not.toContain("separate auto-mergeable PR");
  });

  it("keeps late raising files ahead of auto files when capped and counts totals before capping", () => {
    const files = [...Array.from({ length: 110 }, (_, i) => file({ path: `docs/${i}.md`, lane: "auto", reasons: ["docs"] })), file({ path: "src/last.ts" })];
    const md = mk(files, {});
    expect(md).toContain("Files (111):</b> 1 review · 110 auto");
    expect(md).toContain("- 🟡 `src/last.ts`");
    expect(md).toContain("11 more not shown (111 in total)");
  });

  it("embeds image and panel link only when valid https URLs are given, and only with lane_map", () => {
    const r = (o: object) => mk(many(2), {}, { laneMap: true, ...o });
    const files = r({ laneMapImageUrl: "https://x.test/m.gif", panelUrl: "https://panel.test/pr/1" });
    expect(files).toContain("![Lane map](https://x.test/m.gif)");
    expect(files).toContain("[Deeper view in MergeJudge panel](https://panel.test/pr/1)");
    expect(files.indexOf("![Lane map]")).toBeGreaterThan(files.indexOf("<summary><b>Files"));
    const bad = r({ laneMapImageUrl: "javascript:alert(1)", panelUrl: "http://x) [y](z" });
    expect(bad).not.toContain("![Lane map]");
    expect(bad).not.toContain("Deeper view");
    expect(r({ laneMap: false, panelUrl: "https://panel.test/" })).not.toContain("Deeper view");
  });

  it("is left out when there are no files", () => {
    expect(mk([], { lane: "auto" })).not.toContain("<summary><b>Files");
  });
});

describe("All checks", () => {
  const rubric = [
    { id: "sec.no-secrets", verdict: "pass", severity: "high", justification: "No creds." },
    { id: "sec.input-handling", verdict: "n/a", severity: "medium", justification: "No web input." },
    { id: "cor.logic", verdict: "fail", severity: "high", justification: "UNIQUE-FAIL-TEXT", evidence: { path: "a.py", line: 2, quote: "q" } },
    { id: "cor.tests", verdict: "fail", severity: "low", score: 2, justification: "UNIQUE-TESTS-TEXT" },
    { id: "cor.errors", verdict: "unverified", severity: "medium", justification: "UNIQUE-UNVERIFIED-TEXT" },
  ];
  const md = mk([file()], { rubric });
  const block = md.slice(md.indexOf("<summary><b>All checks</b>"), md.indexOf("</details>", md.indexOf("<summary><b>All checks</b>")));

  it("counts verdicts and keeps pass / n/a justifications", () => {
    expect(block).toContain("<summary><b>All checks</b> (1 pass · 2 fail · 1 unverified · 1 n/a)</summary>");
    expect(block).toContain("- ✅ `sec.no-secrets`: No creds.");
    expect(block).toContain("- ➖ `sec.input-handling`: No web input.");
  });

  it("points failed and unverified items at What to check without repeating their text", () => {
    expect(block).toContain("- ❌ `cor.logic`: see What to check");
    expect(block).toContain("- ❌ `cor.tests` 2/5: see What to check");
    expect(block).toContain("- ❔ `cor.errors`: see What to check");
    // the justification is stated exactly once in the whole body (in What to check)
    expect(md.match(/UNIQUE-FAIL-TEXT/g)).toHaveLength(1);
    expect(md.match(/UNIQUE-TESTS-TEXT/g)).toHaveLength(1);
    expect(md).not.toContain("Rubric:");
  });

  it("is left out without a rubric", () => {
    expect(mk([file()])).not.toContain("All checks");
  });

  it("keeps the `- ❌ `id`` shape the learning flow parses", () => {
    expect([...md.matchAll(/^\s*-\s*❌\s*`([^`]+)`/gm)].map((m) => m[1])).toEqual(["cor.logic", "cor.tests"]);
  });
});

describe("Not checked", () => {
  it("is a tight list: one line per gap, missing policy files on one line, no generic line when a note explains the AI gap", () => {
    const md = renderComment({ agg, mode: "rules-only", tokensEstimate: 0,
      notes: ["AI review unavailable (parse).", "Policy file missing or empty: REVIEW_POLICY.md", "Policy file missing or empty: AGENTS.md"] });
    const nc = md.slice(md.indexOf("### Not checked"), md.indexOf("---"));
    expect(nc).toBe("### Not checked\n\n- AI review unavailable \\(parse\\).\n- Policy files missing or empty: REVIEW\\_POLICY.md, AGENTS.md\n\n");
    expect(md).not.toContain("AI review was not performed");
  });

  it("is omitted when there is nothing to report", () => {
    const md = mk([file()], {}, { mode: "gpt-test" });
    expect(md).not.toContain("Not checked");
    expect(md).not.toContain("Coverage gaps");
    expect(md).not.toContain("No known coverage gaps");
  });

  it("lists a rules-only run, truncated policy, unverified checks and notes", () => {
    const md = renderComment({
      agg: { ...agg, files: [file()], rubric: [{ id: "cor.logic", verdict: "unverified", severity: "high", justification: "j" }] } as never,
      mode: "rules-only", tokensEstimate: 0, notes: ["Diff excluded from AI review: vendor.js"],
      policyFiles: [{ path: "POLICY.md", truncated: true }],
    });
    const nc = md.slice(md.indexOf("### Not checked"), md.indexOf("---"));
    expect(nc).toContain("- AI review was not performed; deterministic rules only.");
    expect(nc).toContain("- Policy truncated: POLICY.md");
    expect(nc).toContain("- Unverified check: Logic");
    expect(nc).toContain("- Diff excluded from AI review: vendor.js");
  });

  it("does not add the generic rules-only line when a note already says so", () => {
    const md = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: ["Free AI review skipped: limit reached; rules-only."] });
    expect(md).not.toContain("AI review was not performed");
    expect(md).toContain("- Free AI review skipped: limit reached; rules-only.");
  });

  it("restores well-formed https links in notes and keeps bare URLs clickable", () => {
    const keys = "https://app.mergejudge.si/app/i/170944538/keys?a=1&b_c=2";
    expect(renderNote(`Rules-only: [save your provider key](${keys}) to enable AI.`))
      .toBe(`Rules-only: [save your provider key](${keys}) to enable AI.`);
    expect(renderNote(`See ${keys}.`)).toBe(`See ${keys}.`);
    expect(renderNote("Free AI review skipped: limit reached (3 file(s))."))
      .toBe("Free AI review skipped: limit reached \\(3 file\\(s\\)\\).");
    const md = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [`Add [your key](${keys}) now`] });
    expect(md).toContain(`- Add [your key](${keys}) now`);
    expect(md).not.toContain("\\[your key\\]");
  });

  it("still escapes everything else, including injected paths and links to other schemes", () => {
    const cases = [
      "Diff excluded from AI review: <img src=x onerror=alert(1)>.js",
      "Diff unavailable: [click](javascript:alert(1))",
      "Diff unavailable: [click](http://evil.test/x)",
      "Diff unavailable: [a](https://evil.test/x y)",
      "Diff unavailable: [a](https://evil.test/x\"onclick=1)",
      "Diff unavailable: [<b>](https://evil.test/x)",
      "Diff unavailable: @octocat `code` *bold* | pipe",
    ];
    for (const c of cases) {
      const out = renderNote(c);
      expect(out).not.toMatch(/(?<!\\)<img|(?<!\\)<b>|(?<!\\)\[click\]\(javascript|(?<!\\)\[click\]\(http:/);
      expect(out).not.toMatch(/(?<!\\)\[[^\]]*\]\(/); // no unescaped markdown link survives, except https ones tested above
      expect(out).not.toContain("@octocat");
      expect(out).not.toMatch(/(?<!\\)`code`|(?<!\\)\*bold\*/);
    }
    expect(renderNote("x\n[y](https://github.com/o/r)\nz")).toBe("x [y](https://github.com/o/r) z");
    // an image marker is escaped, so the restored link can never render as an image
    expect(renderNote("![img](https://app.mergejudge.si/x.png)")).toBe("\\![img](https://app.mergejudge.si/x.png)");
  });

  it("only restores links to MergeJudge or GitHub hosts", () => {
    // a PR author can name a file like a markdown link; it must not become a live link
    for (const c of ["Diff unavailable: [x](https://evil.example/a).js", "Diff unavailable: [x](https://mergejudge.si.evil.example/a)"]) {
      expect(renderNote(c)).not.toMatch(/(?<!\\)\[x\]\(/);
    }
    expect(renderNote("See [docs](https://docs.github.com/actions)")).toBe("See [docs](https://docs.github.com/actions)");
    expect(renderNote("See [k](https://mergejudge.si/k)")).toBe("See [k](https://mergejudge.si/k)");
  });

  it("is kept when a large report is capped", () => {
    const body = renderComment({ agg: { ...agg, summary: "x".repeat(70_000) }, mode: "rules-only", tokensEstimate: 0,
      notes: ["AI budget exhausted"], fileFindings: [{ path: "a.ts", message: "unverified" }] });
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(body).toContain("### Not checked");
    expect(body).toContain("AI budget exhausted");
    expect(body).toContain("AI review was not performed");
    expect(body).toContain(FEEDBACK_MARKER);
    expect(body).toContain("Run details");
    expect(body.startsWith(MARKER)).toBe(true);
  });
});

describe("feedback block", () => {
  const rubric = [
    { id: "cor.logic", verdict: "fail", severity: "high", justification: "j" },
    { id: "cor.tests", verdict: "pass", severity: "low", score: 2, justification: "j" },
    { id: "sec.no-secrets", verdict: "pass", severity: "high", justification: "j" },
  ];
  const body = mk([file()], { rubric });
  const tick = (b: string, ...labels: string[]) => labels.reduce((s, l) => s.replace(`- [ ] ${l}`, `- [x] ${l}`), b);

  it("has the short heading, the five open boxes and per-check boxes inside a details", () => {
    expect(body).toContain(`${FEEDBACK_MARKER}\n**Was this review right?**`);
    expect(body).not.toContain("Feedback for MergeJudge");
    for (const l of ["Correct", "Too lenient", "Too strict", "Wrong reason", "Missed something"]) expect(body).toContain(`- [ ] ${l}\n`);
    const det = body.slice(body.indexOf("<summary>Rate each flagged check</summary>"));
    expect(det).toContain("- [ ] cor.logic: wrong\n- [ ] cor.logic: right");
    expect(det).toContain("- [ ] cor.tests: wrong"); // a low score is flagged too
    expect(det).not.toContain("sec.no-secrets");
    expect(det.indexOf("</details>")).toBeGreaterThan(det.indexOf("cor.tests: right"));
    expect(body.indexOf("- [ ] Missed something")).toBeLessThan(body.indexOf("Rate each flagged check"));
    expect(body.match(/\/mergejudge learn/g)).toHaveLength(1);
  });

  it("omits the details when there is nothing to rate", () => {
    expect(mk([file()])).not.toContain("Rate each flagged check");
  });

  it("parses ticked boxes, including the ones inside the details", () => {
    const fb = parseFeedback(tick(body, "Too strict", "cor.logic: wrong", "cor.tests: right"));
    expect(fb.kinds).toEqual(["too_strict"]);
    expect(fb.rubricVotes).toEqual({ "cor.logic": "down", "cor.tests": "up" });
    expect(parseFeedback(body)).toEqual({ kinds: [], rubricVotes: {} });
  });

  it("reports a change only when the checked set changes", () => {
    const a = tick(body, "Correct");
    expect(feedbackChanged(body, a)).toBe(true);
    expect(feedbackChanged(a, a)).toBe(false);
    expect(feedbackChanged(a, tick(a, "cor.logic: wrong"))).toBe(true);
  });
});

describe("check run summary", () => {
  it("still produces a title and a counted summary", () => {
    const files = [file({ path: "a.py" }), file({ path: "b.py" }), file({ path: "c.md", lane: "auto" })];
    const s = checkSummary({ ...agg, files } as never);
    expect(s.title).toBe("Lane: review");
    expect(s.summary).toContain("Why this lane?");
    expect(s.summary).toContain("Overall lane **review** — 1 auto, 2 review, 0 block file(s).");
  });
});

describe("inline comment label", () => {
  it("says AI and still reads back the old LLM label", () => {
    const body = inlineBody({ path: "a.ts", line: 3, message: "bad <x>" });
    expect(body).toContain("**MergeJudge (AI):**");
    expect(findingText(body)).toBe("bad <x>");
    expect(findingText(body.replace("(AI)", "(LLM)"))).toBe("bad <x>");
  });
});

describe("rules-only suppression of the no-provider note", () => {
  const pf: PrFile = { path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b\n" };
  const run = (o: object) => produceReviewResult({
    pr: { number: 7, title: "t", body: "", node_id: "n", head: { sha: "a".repeat(40) }, user: { login: "u", type: "User" } },
    cfg: parseConfig(""), cfgRef: "main", files: [pf], provider: null,
    noProviderNote: "Rules-only review: no AI provider is set up for this repo.",
    readRepoFile: async () => null,
    contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
    log: { info: () => {}, warning: () => {} },
    ...o,
  });

  it("adds the note when nothing else explains the rules-only run", async () => {
    const r = await run({});
    expect(r.body).toContain("no AI provider is set up");
  });

  it("drops it when a review note (the hosted free-AI skip) already says why", async () => {
    const r = await run({ reviewNotes: ["Free AI review skipped: monthly free AI review limit reached for this repository; rules-only."] });
    expect(r.body).toContain("Free AI review skipped");
    expect(r.body).not.toContain("no AI provider is set up");
    expect(r.body).not.toContain("AI review was not performed");
  });

  it("drops it when skipAi is set", async () => {
    const r = await run({ skipAi: "AI skipped for this PR." });
    expect(r.body).toContain("AI skipped for this PR.");
    expect(r.body).not.toContain("no AI provider is set up");
  });

  it("passes the PR url and lane_map into the learning-branch body too", async () => {
    const cfg = parseConfig("review:\n  lane_map: true\n");
    const r = await run({
      cfg, pr: { number: 7, node_id: "n", head: { sha: "a".repeat(40), ref: cfg.learning.branch }, html_url: "https://github.com/o/r/pull/7" },
    });
    expect(r.kind).toBe("learning-block");
    expect(r.body).toContain("**Overall lane:** 🔴 `block`");
    expect(r.body).toContain("PR labels / holds");
  });
});

describe("sticky report order", () => {
  for (const count of [1, 30]) for (const laneMap of [false, true]) {
    it(`orders ${count} files with lane map ${laneMap}`, () => {
      const files = Array.from({ length: count }, (_, i) => ({
        path: `src/${i}.ts`, lane: "review" as const, reasons: [`review-file-${i}`], additions: 1, deletions: 0,
      }));
      const input = {
        ...agg, lane: "block" as const, files,
        rubric: [
          { id: "info", verdict: "fail" as const, severity: "low" as const, justification: "informational-result", evidence: { path: "src/0.ts", line: 4, quote: "q" } },
          { id: "blocker", verdict: "fail" as const, severity: "high" as const, raiseTo: "block" as const, justification: "block-result" },
        ],
      };
      const before = JSON.stringify(input);
      const body = renderComment({ agg: input, mode: "m", tokensEstimate: 0, laneMap,
        notes: ["AI tool budget exhausted (tokens)", "Diff excluded from AI review: vendor.js", "Known false alarms: 2 findings hidden"],
        fileFindings: [{ path: "src/0.ts", message: "unverified-result" }],
        lineFindings: [{ path: "src/0.ts", line: 9, message: "line-result" }],
      });
      const sections = ["**Overall lane:**", "### What to check", "unverified-result", "<b>Why this lane?</b>", "<summary><b>Files (", "<summary><b>All checks</b>",
        "### Not checked", "AI tool budget exhausted", "\n---\n", FEEDBACK_MARKER, "Run details"];
      for (let i = 1; i < sections.length; i++) {
        expect(body.indexOf(sections[i]!), sections[i]).toBeGreaterThan(body.indexOf(sections[i - 1]!));
      }
      // the summary comes before What to check, and the info/line findings sit under their file
      expect(body.indexOf("\ns\n")).toBeLessThan(body.indexOf("### What to check"));
      const wtc = section(body, "### What to check");
      expect(wtc.indexOf("**Whole PR**")).toBeGreaterThan(wtc.indexOf("**src/0.ts**"));
      expect(wtc).toContain("line-result");
      expect(wtc).toContain("informational-result");
      expect(body.match(/\*\*Overall lane:\*\*/g)).toHaveLength(1);
      expect(body).toContain("Diff excluded from AI review: vendor.js");
      expect(body).toContain("2 findings hidden");
      expect(JSON.stringify(input)).toBe(before);
    });
  }
});

describe("PR #7 fixture (free-test)", () => {
  const PR = "https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7";
  const ws = ".github/workflows/";
  const files = [
    file({ path: `${ws}ci.yml`, reasons: ["protected path"] }),
    file({
      path: `${ws}shepherd.yml`, reasons: ["protected path"], source: "rule + LLM",
      llmReason: "Third-party action with contents/pull-requests/issues/actions write, secrets passed in; SHA pin looks full but should be human-verified.",
    }),
    file({ path: ".mergejudge.yml", reasons: ["MergeJudge config file (.mergejudge.yml): always needs human review", "protected path"] }),
    file({ path: "package.json", reasons: ["dependency manifest or lockfile change"] }),
    file({
      path: "scripts/lint.mjs", reasons: ["code file (always needs human review)"], source: "rule + LLM",
      llmReason: "Local file-rewriting script; readdirSync on src will throw if src is missing, and --fix always reports success.",
    }),
    file({ path: "test/math.test.js", reasons: ["code file (always needs human review)"] }),
  ];
  const rubric = [
    { id: "sec.no-secrets", verdict: "pass", severity: "high", justification: "Only references to secret names are added; no real credentials are committed." },
    { id: "sec.no-exfiltration", verdict: "pass", severity: "high", justification: "Secrets go to the pinned runner action as inputs, not to an unexpected host." },
    { id: "sec.no-unsafe-exec", verdict: "pass", severity: "high", justification: "No eval or shell execution of untrusted input; npm scripts are fixed literals." },
    { id: "sec.input-handling", verdict: "n/a", severity: "medium", justification: "No web input or HTML sinks in the change." },
    { id: "cor.logic", verdict: "fail", severity: "high", justification: "The lint script reports success and exits 0 in --fix mode even when problems remain, and crashes if src/ is absent.", evidence: { path: "scripts/lint.mjs", line: 19, quote: "q" } },
    { id: "cor.errors", verdict: "fail", severity: "medium", justification: "readdirSync on src is unguarded and file writes/reads have no error handling.", evidence: { path: "scripts/lint.mjs", line: 7, quote: "q" } },
    { id: "cor.tests", verdict: "fail", severity: "low", score: 2, justification: "A math test is added but the new lint script and workflow behaviour are untested; the test also imports src/math.js which is not in this PR.", evidence: { path: "test/math.test.js", line: 3, quote: "q" } },
  ];
  const lineFindings = [
    { path: "scripts/lint.mjs", line: 19, message: "The lint script exits 0 in --fix mode even when problems remain." },
    { path: "scripts/lint.mjs", line: 7, message: "readdirSync on src is unguarded." },
    { path: `${ws}shepherd.yml`, line: 26, message: "actions: write allows re-running/cancelling workflows; confirm this is needed and scoped as intended." },
    { path: `${ws}shepherd.yml`, line: 37, message: "issue_comment path does not check commenter permission here; ensure the runner gates on write access before acting." },
    { path: `${ws}shepherd.yml`, line: 55, message: "Third-party action receives App private key and write tokens; verify the pinned SHA corresponds to the reviewed runner code." },
  ];
  const base = {
    agg: {
      lane: "review" as const, files, labelReasons: [], rubric,
      summary: "Adds a CI workflow, a Shepherd workflow pinned to a runner commit, a small dependency-free lint script with --fix, a test file and package.json, and lowers shepherd.max_attempts to 1. The Shepherd workflow uses an App installation token with write permissions and a third-party action pinned by SHA.",
    } as never,
    tokensEstimate: 3980, notes: [] as string[], laneMap: true, prUrl: PR, lineFindings,
  };
  const ai = renderComment({
    ...base, mode: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    breakdown: { system: 421, policy: 0, rubric: 318, diff: 2112, output: 1129, total: 3980 },
  });
  const rulesOnly = renderComment({
    ...base, mode: "rules-only", tokensEstimate: 0, lineFindings: [], laneMap: true,
    agg: { ...(base.agg as object), rubric: [], files: files.map((f) => ({ ...f, llmReason: undefined, source: "rule" })), summary: "6 files changed, +151 / -3 lines." } as never,
    notes: ["Free AI review skipped: monthly free AI review limit reached for this repository; rules-only. Add [your provider key](https://app.mergejudge.si/app/i/170944538/keys) to keep AI reviews."],
  });

  it("renders the layout in order, with counts, grouped findings and links", () => {
    expect(ai).toContain("**Overall lane:** 🟡 `review` · 6 of 6 files need a human look · 3 problems found · 5 line comments");
    expect(ai).toContain("### What to check");
    expect(ai).toContain("**scripts/lint.mjs**");
    expect(ai).toContain("- **Logic (high):** The lint script reports success");
    expect(ai).toContain("- **Tests (low, 2/5):**");
    expect(ai).toContain(`[L55](${PR}/files#diff-${sha(`${ws}shepherd.yml`)}R55)`);
    expect(ai).toContain("- **Protected path:** `.github/workflows/ci.yml`, `.github/workflows/shepherd.yml`, `.mergejudge.yml`");
    expect(ai).toContain("- **Code file:** `scripts/lint.mjs`, `test/math.test.js`");
    expect(ai).toContain("- **Dependency manifest or lockfile change:** `package.json`");
    expect(ai).not.toContain("| Folder |"); // 6 files: no folder table
    expect(ai).not.toMatch(/cor\.logic`: The lint/);
    expect(ai).not.toContain("### Not checked");
    expect(ai.match(LANE_RE)![1]).toBe("review");
  });

  it("matches the committed fixtures", async () => {
    await expect(ai).toMatchFileSnapshot("./fixtures/sticky-pr7-ai.md");
    await expect(rulesOnly).toMatchFileSnapshot("./fixtures/sticky-pr7-rulesonly.md");
  });

  it("rules-only variant: one reason note with a working link, no duplicate or contradictory note", () => {
    expect(rulesOnly).toContain("### Not checked");
    expect(rulesOnly).toContain("[your provider key](https://app.mergejudge.si/app/i/170944538/keys)");
    expect(rulesOnly).not.toContain("AI review was not performed");
    expect(rulesOnly).toContain("Nothing specific flagged.");
    expect(rulesOnly).toContain("<sub>rules-only · ~0 tokens");
  });
});

describe("aggregate integration", () => {
  it("renders a real rules-only aggregate", () => {
    const pf = (path: string): PrFile => ({ path, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" });
    const a = aggregate([pf("src/a.ts"), pf("docs/x.md")], [], parseConfig(""), null);
    const md = renderComment({ agg: a, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true });
    expect(md).toContain("**Overall lane:** 🟡 `review` · 1 of 2 files needs a human look");
    expect(md).toContain("The 1 auto file could go in a separate auto-mergeable PR.");
  });
});
