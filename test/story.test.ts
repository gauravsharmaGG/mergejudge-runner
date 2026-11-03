import { STORY_SYSTEM_PROMPT } from "../core/storycall.js";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import type { LlmProvider } from "../core/llm/provider.js";
import { MAX_COMMENT_CHARS, renderComment } from "../core/render.js";
import { produceReviewResult } from "../core/review.js";
import {
  MAX_STORY_EDGES, MAX_STORY_STEPS, renderStorySection, sanitizeStoryText, storyMermaid, validateStory, type StoryFile,
} from "../core/story.js";
import { buildSystemPrompt, parseTriageOutput, runTriage, validateAgainstFiles } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const files: StoryFile[] = [
  { path: "a.ts", lines: new Set([1, 2, 3, 10]) },
  { path: "b.ts", lines: new Set([5]) },
  { path: "nolines.ts", lines: null },
];
const step = (id: string, label: string, extra: object = {}) => ({ id, label, refs: [{ path: "a.ts", line: 1 }], ...extra });

describe("validateStory", () => {
  it("drops steps whose refs are empty, unknown, or on lines outside the diff", () => {
    const s = validateStory({
      steps: [
        step("s1", "ok one"),
        { id: "s2", label: "no refs", refs: [] },
        { id: "s3", label: "unknown path", refs: [{ path: "zzz.ts" }] },
        { id: "s4", label: "bad line", refs: [{ path: "a.ts", line: 99 }] },
        { id: "s5", label: "fractional", refs: [{ path: "a.ts", line: 1.5 }] },
        { id: "s6", label: "path only", refs: [{ path: "b.ts" }] },
        { id: "s7", label: "no line info", refs: [{ path: "nolines.ts", line: 42 }] },
        { id: "s8", label: "one bad one good ref", refs: [{ path: "a.ts", line: 99 }, { path: "a.ts", line: 10 }] },
      ],
    }, files);
    expect(s?.steps.map((x) => x.title)).toEqual(["ok one", "path only", "no line info", "one bad one good ref"]);
    expect(s?.steps[3]?.refs).toEqual([{ path: "a.ts", line: 10 }]);
  });

  it("reassigns ids, chains steps without edges and ignores model ids", () => {
    const s = validateStory({ steps: [step("zz", "first"), step("zz", "second"), step("q", "third")] }, files)!;
    expect(s.steps.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(s.edges.map((e) => [e.id, e.from, e.to])).toEqual([["e1", "s1", "s2"], ["e2", "s2", "s3"]]);
  });

  it("drops edges to unknown or dropped steps, self-loops and duplicates", () => {
    const s = validateStory({
      steps: [step("a", "one"), { id: "gone", label: "gone", refs: [] }, step("b", "two"), step("c", "three")],
      edges: [
        { from: "a", to: "b" }, { from: "a", to: "b" }, { from: "b", to: "b" },
        { from: "a", to: "gone" }, { from: "nope", to: "c" }, { from: "b", to: "c", change: "bogus" },
      ],
    }, files)!;
    expect(s.edges.map((e) => [e.id, e.from, e.to])).toEqual([["e1", "s1", "s2"], ["e2", "s2", "s3"]]);
  });

  it("falls back to a chain when no edge survives", () => {
    const s = validateStory({ steps: [step("a", "one"), step("b", "two")], edges: [{ from: "x", to: "y" }] }, files)!;
    expect(s.edges.map((e) => [e.from, e.to])).toEqual([["s1", "s2"]]);
  });

  it("caps steps and edges", () => {
    const steps = Array.from({ length: 20 }, (_, i) => step(`n${i}`, `step ${i}`));
    const edges = steps.flatMap((a, i) => steps.slice(i + 1).map((b) => ({ from: a.id, to: b.id })));
    const s = validateStory({ steps, edges }, files)!;
    expect(s.steps).toHaveLength(MAX_STORY_STEPS);
    expect(s.edges.length).toBeLessThanOrEqual(MAX_STORY_EDGES);
  });

  it("caps titles/subtitles, derives refs, and maps positional edge ids after a dropped step", () => {
    const s = validateStory({ title: "x".repeat(100), steps: [
      { title: "dropped", refs: [] },
      { title: "t".repeat(100), sub: "s".repeat(100), refs: [{ path: "a.ts", line: 1 }] },
      { label: "Click handler", refs: [{ path: "b.ts", line: 5 }] },
    ], edges: [{ from: "s2", to: "s3", change: "same" }] }, files)!;
    expect(s.title).toHaveLength(40); expect(s.steps[0]!.title).toHaveLength(48); expect(s.steps[0]!.sub).toHaveLength(60);
    expect(s.steps[1]!.title).toBe("Click handler"); expect(s.steps[1]!.sub).toBe("b.ts:5");
    expect(s.edges[0]).toMatchObject({ from: "s1", to: "s2", change: "same" });
  });
  it("returns null with fewer than two valid steps or garbage input", () => {
    expect(validateStory({ steps: [step("a", "only")] }, files)).toBeNull();
    expect(validateStory({ steps: [step("a", "ok"), { id: "b", label: "x", refs: [{ path: "nope" }] }] }, files)).toBeNull();
    for (const bad of [undefined, null, "story", 7, [], [step("a", "x"), step("b", "y")], { steps: "x" }, { steps: [null, 3, "x"] }])
      expect(validateStory(bad, files)).toBeNull();
  });

  it("keeps before/after only for changed steps and defaults change", () => {
    const s = validateStory({
      steps: [step("a", "x", { change: "new", before: "b", after: "a" }), step("b", "y", { before: "old", after: "new" }), step("c", "z")],
    }, files)!;
    expect(s.steps.map((x) => [x.change, x.before, x.after])).toEqual([["new", undefined, "a"], ["changed", "old", "new"], ["same", undefined, undefined]]);
  });
});

describe("sanitizeStoryText", () => {
  const evil = [
    `"]; click s1 href "javascript:alert(1)"`,
    "<script>alert(1)</script>",
    "%%{init: {'theme':'x'}}%%",
    "a --> b --- c ::: d",
    "`code` and ```fence```",
    "line one\nline two\r\n\tx",
    "&lt;b&gt; &amp; &#x3C;",
    "[link](http://evil.example) www.evil.example @user #1 {a} (b) | c ; d",
    "x\u0000y‮z​",
  ];
  it("emits only the allowlisted charset and none of the mermaid or markdown triggers", () => {
    for (const e of evil) {
      const out = sanitizeStoryText(e, 60);
      expect(out).toMatch(/^[\p{L}\p{N} .,:;/_+\-=*'"!?()[\]{}]*$/u);
      for (const bad of ["javascript:", "<", ">", "-->", "---", ":::", "%%", "`", "@", "&", "\n", "://", "www."])
        expect(out.toLowerCase()).not.toContain(bad);
    }
  });
  it("keeps normal text, unicode letters and caps the length", () => {
    expect(sanitizeStoryText("Validate user's input, then save: ok!", 60)).toBe("Validate user's input, then save: ok!");
    expect(sanitizeStoryText("Prüfe Eingabe 検証", 60)).toBe("Prüfe Eingabe 検証");
    expect(sanitizeStoryText("a".repeat(100_000), 60)).toHaveLength(60);
    expect(sanitizeStoryText({ x: 1 }, 60)).toBe("");
  });
  it("keeps brackets, semicolons and quotes and escapes them per output", () => {
    const t = 'Test checks [1, 2, NaN, Infinity, 3] gives 4';
    expect(sanitizeStoryText(t, 60)).toBe(t);
    expect(sanitizeStoryText('total() returns "4"; sum({a}) skips', 60)).toBe('total() returns "4"; sum({a}) skips');
    const s = validateStory({ steps: [step("a", t, { change: "changed", before: 'list "x" (any)', after: "only [numbers]; else throw" }), step("b", `say "hi" it's`)] }, files)!;
    const md = renderComment({ agg: agg as never, mode: "m", tokensEstimate: 0, notes: [], story: s, storyStyle: "svg", storyImageUrl: "https://example.com/s.svg" });
    expect(md).toContain("1. Test checks \\[1, 2, NaN, Infinity, 3\\] gives 4 (list \"x\" \\(any\\) -> only \\[numbers\\]; else throw)\n2. say \"hi\" it's\n</details>");
    expect(md).not.toContain("Steps:");
    expect(md).toContain('alt="PR story: 1. Test checks [1, 2, NaN, Infinity, 3] gives 4 (list &quot;x&quot; (any) -&gt; only [numbers]; else throw). 2. say &quot;hi&quot; it&#39;s."');
    const alt = md.match(/alt="([^"]*)"/)![1]!;
    expect(alt).not.toMatch(/["<>]/);
    const m = storyMermaid(s);
    for (const l of m.split("\n").filter((x) => /^ {2}s\d\[/.test(x))) expect(l).toMatch(/^ {2}s\d\["[^"\]\[(){};]*"\]$/);
    expect(m).toContain('s1["Test checks 1, 2, NaN, Infinity, 3 gives 4<br/>before: list x any<br/>after: only numbers else throw"]');
  });
  it("cannot break out of a quoted mermaid label end to end", () => {
    const s = validateStory({
      steps: [step("a", evil[0]!, { before: evil[1]!, after: evil[2]! }), step("b", evil[3]!)],
    }, files)!;
    const m = storyMermaid(s);
    expect(m).not.toMatch(/javascript|<script|%%|`/i);
    // a node line is exactly: id["text"] with one pair of quotes
    for (const l of m.split("\n").filter((x) => /^ {2}s\d\[/.test(x))) expect(l).toMatch(/^ {2}s\d\["[^"\]\[]*"\]$/);
  });
});

const story = validateStory({
  steps: [
    step("a", "Parse request"),
    step("b", "Validate input", { change: "new" }),
    step("c", "Reply", { change: "changed", before: "old", after: "new" }),
  ],
  edges: [{ from: "a", to: "b", change: "new" }, { from: "b", to: "c", change: "changed" }, { from: "a", to: "c", change: "same" }],
}, files)!;

describe("storyMermaid", () => {
  it("animates only new and changed edges", () => {
    expect(storyMermaid(story, true)).toBe([
      "flowchart TD",
      `  s1["Parse request"]`,
      `  s2["Validate input"]`,
      `  s3["Reply<br/>before: old<br/>after: new"]`,
      "  s1 e1@--> s2",
      "  s2 e2@--> s3",
      "  s1 --> s3",
      "  e1@{ animate: true }",
      "  e2@{ animate: true }",
      "  classDef added stroke-width:3px",
      "  class s2 added",
      "  classDef changed stroke-width:2px",
      "  class s3 changed",
    ].join("\n"));
  });
  it("has no @ at all with animation off", () => {
    const m = storyMermaid(story, false);
    expect(m).not.toContain("@");
    expect(m).toContain("  s1 --> s2\n  s2 --> s3\n  s1 --> s3");
  });
});

const agg = { lane: "review" as const, files: [], labelReasons: [], summary: "s", rubric: [] };
const open = (extra: object = {}) => renderComment({
  agg: { ...agg, rubric: [{ id: "cor.logic", verdict: "fail", severity: "high", justification: "bad", evidence: { path: "a.ts", line: 1 } }] } as never,
  mode: "m", tokensEstimate: 0, notes: [], story, storyStyle: "mermaid", ...extra,
});

describe("sticky rendering", () => {
  it("puts an open chart with a text fallback right after What to check", () => {
    const md = open();
    const i = md.indexOf("### What to check"), j = md.indexOf("<details open><summary>What this PR does (AI-drawn, may be incomplete)</summary>");
    const k = md.indexOf("<details><summary><b>Why this lane?");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    expect(k).toBeGreaterThan(j);
    expect(md).toContain("```mermaid\nflowchart TD");
    expect(md).toContain("<details><summary>Steps as text</summary>\n\n1. Parse request\n2. Validate input\n3. Reply (old -> new)\n</details>");
    expect(md).not.toContain("Steps:");
    expect(md).toContain("e1@{ animate: true }");
  });
  it("renders plain edges when storyAnimate is false", () => {
    const md = open({ storyAnimate: false });
    expect(md).not.toContain("animate");
    expect(md).not.toContain("e1@");
  });
  it("renders nothing without a story", () => {
    expect(open({ story: null })).not.toContain("What this PR does");
    expect(open({ story: undefined })).not.toContain("mermaid");
  });
  it("drops the image before the list when over the cap", () => {
    const md = open({ storyStyle: "svg", storyImageUrl: "https://example.com/" + "a".repeat(MAX_COMMENT_CHARS) });
    expect(md).not.toContain("<img"); expect(md).toContain("\n1. Parse request\n2. Validate input"); expect(md).not.toContain("Steps as text");
    expect(md).not.toContain("shortened to fit");
  });
  it("drops the chart first when over the size cap", () => {
    const mkFindings = (len: number) => Array.from({ length: 100 }, (_, n) => ({ path: `f${n}.ts`, message: "x".repeat(len) }));
    // Grow the findings until the comment is just under the cap without the chart.
    let len = 0;
    while (len < 1_000 && !open({ story: null, fileFindings: mkFindings(len + 1) }).includes("shortened to fit")) len++;
    const fileFindings = mkFindings(len);
    const without = open({ story: null, fileFindings });
    const md = open({ fileFindings });
    expect(without.length).toBeGreaterThan(MAX_COMMENT_CHARS - 150);
    expect(without.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(open({ fileFindings: mkFindings(len - 100) })).toContain("What this PR does");
    expect(md).not.toContain("What this PR does");
    expect(md.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(md).not.toContain("shortened to fit");
  });
});

const pf: PrFile = { path: "a.ts", status: "modified", additions: 3, deletions: 0, patch: "@@ -1,0 +1,3 @@\n+one\n+two\n+three\n" };
const pf2: PrFile = { path: "b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,0 +1,1 @@\n+x\n" };
const storyJson = {
  steps: [
    { id: "s1", label: "Read config", refs: [{ path: "a.ts", line: 2 }], change: "new" },
    { id: "s2", label: "Apply it", refs: [{ path: "b.ts", line: 1 }], change: "changed", before: "ignored", after: "used" },
  ],
};
const reply = (extra: object = {}) => JSON.stringify({ summary: "ok", files: [{ path: "a.ts", lane: "review", reason: "logic", findings: [] }], ...extra });
const mkProvider = (seen: string[], answer: string): LlmProvider => ({
  label: "fake", providerId: "openai", complete: async (req) => { seen.push(`${req.system}\n${req.user}`); return answer; },
});
const pr = { number: 7, title: "t", body: "", node_id: "n", head: { sha: "a".repeat(40) }, user: { login: "u", type: "User" } };
const review = (yml: string, provider: LlmProvider) => produceReviewResult({
  pr, cfg: parseConfig(`provider:\n  type: openai\n  model: m\n${yml}`), cfgRef: "main", files: [pf, pf2], provider,
  readRepoFile: async () => null,
  contextSource: { listPaths: async () => [], readFile: async () => null, searchSymbol: async () => [] },
  log: { info: () => {}, warning: () => {} },
});

describe("config and separate call", () => {
  it("defaults to SVG, text-only hosting, off, animation on", () => {
    expect(parseConfig("").comment).toEqual({ flow_chart: false, flow_chart_animate: true, flow_chart_style: "svg", flow_chart_host: "none", where_it_sits: false });
    expect(parseConfig("comment:\n  flow_chart_style: mermaid\n  flow_chart_host: branch").comment).toMatchObject({ flow_chart_style: "mermaid", flow_chart_host: "branch" });
    expect(sanitizeStoryText("Click handler", 48)).toBe("Click handler");
  });
  it("leaves the full review request byte-identical and makes zero extra calls when off", async () => {
    const off: string[] = [], on: string[] = [];
    const provider = (seen: string[]): LlmProvider => ({ label: "fake", complete: async req => {
      seen.push(JSON.stringify(req)); return req.system === STORY_SYSTEM_PROMPT ? JSON.stringify(storyJson) : reply();
    } });
    const a = await review("", provider(off));
    const b = await review("comment:\n  flow_chart: true\n", provider(on));
    expect(off).toHaveLength(1); expect(on).toHaveLength(2);
    expect(on[0]).toBe(off[0]);
    expect(JSON.parse(on[0]!).system).toBe(JSON.parse(off[0]!).system);
    expect(buildSystemPrompt()).not.toContain(STORY_SYSTEM_PROMPT);
    expect(b.body).toContain("1. Read config\n2. Apply it");
    expect(b.body).not.toContain("```mermaid");
    expect(b.lane).toBe(a.lane); expect(b.findings).toEqual(a.findings);
  });
  it("ignores review JSON story and isolates failed story calls", async () => {
    const ignored = await review("", mkProvider([], reply({ story: storyJson })));
    expect(ignored.body).not.toContain("What this PR does");
    const a = await review("", mkProvider([], reply()));
    const lines: Record<string, string> = { throw: "provider error", garbage: "invalid reply", truncate: "reply cut off at the output limit" };
    for (const failure of ["throw", "garbage", "truncate"]) {
      const p: LlmProvider = { label: "fake", complete: async () => reply(), completeEx: async req => {
        if (req.system !== STORY_SYSTEM_PROMPT) return { text: reply(), truncated: false };
        if (failure === "throw") throw new Error("failure");
        return { text: failure === "garbage" ? "not json" : JSON.stringify(storyJson), truncated: failure === "truncate" };
      } };
      const b = await review("comment:\n  flow_chart: true\n", p);
      expect(b.agg).toEqual(a.agg); expect(b.findings).toEqual(a.findings);
      // The footer differs (a failed story call still counts what was sent) and one Not-checked line says why.
      expect(b.body).toContain(`- PR story: not drawn \\(${lines[failure]!.replace(/ /g, " ")}\\)`);
      expect(b.body.replace(/- PR story: not drawn[^\n]*\n/, "").replace(/ \(story \d+\)/, "").replace(/~\d+ tokens/, "")).toBe(a.body.replace(/~\d+ tokens/, ""));
      expect(b.body).toMatch(/ \(story \d+\)/);
    }
  });
  it("renders hosted images or text only, and supports explicit mermaid", () => {
    const image = open({ storyStyle: "svg", storyImageUrl: "https://example.com/story.svg" });
    expect(image).toContain('<img src="https://example.com/story.svg" alt="PR story:');
    expect(image).toContain('width="440">');
    const plain = open({ storyStyle: "svg" });
    expect(plain).toContain("\n1. "); expect(plain).not.toContain("<img"); expect(plain).not.toContain("```mermaid");
    expect(open({ storyStyle: "svg", storyImageUrl: 'https://bad/" onerror="x' })).not.toContain("<img");
  });
});

describe("sanitizeStoryText cap", () => {
  it("cuts long text at a word boundary and marks the cut", () => {
    const out = sanitizeStoryText("very long title that should wrap nicely onto a second line", 30);
    expect(out).toBe("very long title that should...");
    expect(out.length).toBeLessThanOrEqual(30);
    expect(sanitizeStoryText("short title", 30)).toBe("short title");
    expect(sanitizeStoryText("x".repeat(40), 30)).toBe("x".repeat(27) + "...");
  });
});

describe("steps fallback text", () => {
  const mk = (n: number, title = "Step") => validateStory({ steps: Array.from({ length: n }, (_, i) => ({ title: `${title} ${i + 1} ${"w".repeat(40)}`, change: "changed", before: 'a "b"', after: "<c>", refs: [{ path: "a.ts" }] })) }, files)!;
  const url = "https://example.com/s.svg";
  it("puts numbered steps in the alt text and a collapsed list under the image, no visible Steps: line", () => {
    const lines = renderStorySection(mk(2), true, "svg", url);
    const md = lines.join("\n");
    expect(md).toMatch(/<img src="https:\/\/example.com\/s.svg" alt="PR story: 1\. Step 1 w+ \(a &quot;b&quot; -&gt; c\)\. 2\. Step 2/);
    expect(md).toContain('width="440">\n\n<details><summary>Steps as text</summary>\n\n1. Step 1');
    expect(md).toContain("\n2. Step 2");
    expect(md).not.toContain("Steps:");
  });
  it("caps the alt text on a step boundary with an ellipsis and never cuts an entity", () => {
    const alt = renderStorySection(mk(6), true, "svg", url).join("\n").match(/alt="([^"]*)"/)![1]!;
    expect(alt.length).toBeLessThanOrEqual(400);
    expect(alt).toMatch(/\.\.\.$/);
    expect(alt).not.toMatch(/&[a-z#0-9]*(?!;)[^;&]*\.\.\.$/);
    expect(alt).toMatch(/\. 3\. Step 3/);
    for (const m of alt.matchAll(/&([^;\s]*)(;?)/g)) expect(m[2]).toBe(";");
    // a first step longer than the cap is still cut cleanly
    const long = validateStory({ steps: [{ title: "x".repeat(48), change: "changed", before: "q".repeat(50), after: "r".repeat(50), refs: [{ path: "a.ts" }] }, { title: "y", refs: [{ path: "a.ts" }] }] }, files)!;
    expect(renderStorySection(long, true, "svg", url).join("\n").match(/alt="([^"]*)"/)![1]!.length).toBeLessThanOrEqual(400);
  });
  it("keeps the steps visible without an image, and collapsed beside a mermaid block", () => {
    for (const lines of [renderStorySection(mk(2), true, "svg", null), renderStorySection(mk(2), true, "svg", "http://bad"), renderStorySection(mk(2), true, "svg", url, false)]) {
      const md = lines.join("\n");
      expect(md).toContain("\n1. Step 1"); expect(md).not.toContain("Steps as text"); expect(md).not.toContain("<img"); expect(md).not.toContain("Steps:");
    }
    const m = renderStorySection(mk(2), true, "mermaid", null).join("\n");
    expect(m).toContain("```mermaid"); expect(m).toContain("<details><summary>Steps as text</summary>\n\n1. Step 1");
  });
});
