import { describe, expect, it, vi } from "vitest";
import {
  isAnswered, nextRound, parseRoundsMarker, renderRoundsMarker, unansweredFindings, type FindingThread,
} from "../core/answers.js";
import { parseConfig } from "../core/config.js";
import { DISMISS_RE } from "../core/falsealarm.js";
import { inlineBody, planInline } from "../core/inline.js";
import { produceReviewResult } from "../core/review.js";
import { escapeMd } from "../core/render.js";
import type { PrFile } from "../core/types.js";

const th = (over: Partial<FindingThread> = {}): FindingThread => ({
  rootId: 1, key: "a.md:2", path: "a.md", state: "active", isResolved: false, replies: [], ...over,
});
const human = (body: string) => ({ author: "dev", isBot: false, body });

describe("isAnswered", () => {
  it("needs a resolved thread or a human reason", () => {
    expect(isAnswered(th())).toBe(false);
    expect(isAnswered(th({ isResolved: true }))).toBe(true);
    expect(isAnswered(th({ replies: [human("this is intended, see the docs")] }))).toBe(true);
  });
  it("ignores bot replies, short replies and quoted-only replies", () => {
    expect(isAnswered(th({ replies: [{ author: "bot", isBot: true, body: "a long enough bot reply here" }] }))).toBe(false);
    expect(isAnswered(th({ replies: [human("ok"), human("  fine  ")] }))).toBe(false);
    expect(isAnswered(th({ replies: [human("> the quoted finding text is long\n> more\n\nok")] }))).toBe(false);
    expect(isAnswered(th({ replies: [human("> quoted\nwill fix it later")] }))).toBe(true);
  });
});

describe("unansweredFindings", () => {
  const f = (path: string, line?: number) => ({ path, line, message: "m" });
  it("counts missing and unanswered threads, skips answered ones and file-level findings", () => {
    const threads = [th({ key: "a.md:2", isResolved: true }), th({ key: "a.md:3", rootId: 2 })];
    const r = unansweredFindings([f("a.md", 2), f("a.md", 3), f("a.md", 4), f("a.md")], threads, new Set());
    expect(r).toEqual({ open: 2, keys: ["a.md:3", "a.md:4"] });
  });
  it("counts a bot-resolved thread whose finding came back", () => {
    expect(unansweredFindings([f("a.md", 2)], [th({ state: "resolved", isResolved: true })], new Set()).open).toBe(1);
  });
  it("counts active unanswered threads on kept paths once", () => {
    const threads = [th({ key: "k.md:1", path: "k.md" }), th({ key: "k.md:5", path: "k.md", replies: [human("deliberate choice here")] }),
      th({ key: "o.md:1", path: "o.md" }), th({ key: "k.md:9", path: "k.md", state: "resolved", isResolved: true })];
    expect(unansweredFindings([f("k.md", 1)], threads, new Set(["k.md"]))).toEqual({ open: 1, keys: ["k.md:1"] });
  });
});

describe("rounds marker", () => {
  it("renders and parses", () => {
    const m = renderRoundsMarker(3, "abcdef1234");
    expect(m).toBe("<!-- mergejudge:rounds n=3 sha=abcdef1234 -->");
    expect(parseRoundsMarker(`x\n${m}\ny`)).toEqual({ n: 3, sha: "abcdef1234" });
  });
  it("rejects malformed markers", () => {
    for (const b of [undefined, "", "<!-- mergejudge:rounds n=3 sha=XYZ -->", "<!-- mergejudge:rounds n=3 sha=abc -->",
      "<!-- mergejudge:rounds n=-1 sha=abcdef1 -->", "<!-- mergejudge:rounds n=1001 sha=abcdef1 -->", "<!-- mergejudge:rounds n=1 sha=abcdef1 extra -->"])
      expect(parseRoundsMarker(b)).toBeNull();
  });
  it("counts rounds per head", () => {
    expect(nextRound(null, "aaaaaaa")).toBe(1);
    expect(nextRound({ n: 2, sha: "aaaaaaa" }, "aaaaaaa")).toBe(2);
    expect(nextRound({ n: 2, sha: "aaaaaaa" }, "bbbbbbb")).toBe(3);
  });
});

describe("dismiss replies", () => {
  it("counts a leading dismiss:/dismissed:/won't fix: as a dismissal", () => {
    for (const s of ["dismiss: legacy path", "Dismissed: not used", "  Won't fix: old code"]) expect(DISMISS_RE.test(s)).toBe(true);
    expect(DISMISS_RE.test("we should dismiss this later")).toBe(false);
  });
});

const patch = "@@ -1 +1,3 @@\n keep\n+TODO fix this later\n+second line here";
const pf = (path: string): PrFile => ({ path, status: "modified", additions: 2, deletions: 0, patch });
const reply = (findings: object[], paths: string[] = ["a.md"]) => JSON.stringify({
  summary: "s", files: paths.map((p) => ({ path: p, lane: "auto", reason: "docs", findings })),
});
const run = async (yaml: string, extra: Record<string, unknown> = {}, paths = ["a.md"], findings: object[] = [{ line: 2, quote: "TODO fix this later", message: "left a TODO" }]) => {
  const reqs: string[] = [];
  const provider = { label: "fake", complete: async (req: unknown) => { reqs.push(JSON.stringify(req)); return reply(findings, paths); } };
  const warn = vi.fn();
  const r = await produceReviewResult({
    pr: { number: 1, node_id: "n", head: { sha: "abc1234" } }, cfgRef: "main", files: paths.map(pf),
    cfg: parseConfig(`provider:\n  type: openai\n${yaml}`), provider, log: { info: vi.fn(), warning: warn },
    readRepoFile: async () => null, contextSource: { listPaths: async () => null, readFile: async () => null, searchSymbol: async () => [] },
    ...extra,
  } as never);
  return { r, reqs };
};
const NOT_ANSWERED = "1 AI finding(s) not answered yet: fix the code or reply on the thread with a reason";

describe("answer gate", () => {
  const on = "review:\n  answer_findings: true\n";
  it("raises auto to review while a finding is unanswered, and says why", async () => {
    const { r } = await run(on, { threads: [] });
    expect(r.lane).toBe("review");
    expect(r.agg.labelReasons).toContain(NOT_ANSWERED);
    expect(r.agg.explanation?.summary).toContain("not answered yet");
    expect(r.body).toContain(escapeMd(NOT_ANSWERED)); // the rendered comment escapes markdown
  });
  it("stays auto when the finding is answered", async () => {
    const { r } = await run(on, { threads: [th({ replies: [human("intended, tracked in #12")] })] });
    expect(r.lane).toBe("auto");
    expect(r.body).not.toContain("not answered yet");
  });
  it("changes nothing when off", async () => {
    const { r } = await run("", { threads: [] });
    expect(r.lane).toBe("auto");
    expect(r.body).not.toContain("not answered yet");
  });
  it("notes and keeps the lane when threads could not be read", async () => {
    const { r } = await run(on);
    expect(r.lane).toBe("auto");
    expect(r.body).toContain("Could not read review threads; answer check skipped.");
  });
});

describe("round cap", () => {
  const cap = "review:\n  max_rounds: 2\n";
  it("sends only reviewPaths to the model and notes it", async () => {
    const { r, reqs } = await run(cap, { round: { n: 3, sinceSha: "1234567890", reviewPaths: ["b.md"] } }, ["a.md", "b.md"]);
    expect(reqs.join()).toContain("b.md");
    expect(reqs.join()).not.toContain("a.md");
    expect(r.body).toContain(escapeMd("Round 3 (cap 2): AI reviewed only the 1 file(s) changed since 1234567"));
    expect(r.keepInlinePaths).toEqual(["a.md"]);
    expect(r.agg.files.map((x) => x.path).sort()).toEqual(["a.md", "b.md"]);
  });
  it("counts open threads on files that were not re-reviewed", async () => {
    const t = th({ key: "a.md:2", path: "a.md" });
    const { r } = await run("review:\n  max_rounds: 2\n  answer_findings: true\n", { threads: [t], round: { n: 3, sinceSha: "1234567", reviewPaths: ["b.md"] } }, ["a.md", "b.md"], []);
    expect(r.lane).toBe("review");
    expect(r.agg.labelReasons).toContain(NOT_ANSWERED);
  });
  it("reviews everything and keeps nothing without reviewPaths", async () => {
    const { r, reqs } = await run(cap, { round: { n: 1 } }, ["a.md", "b.md"]);
    expect(reqs.join()).toContain("a.md");
    expect(r.keepInlinePaths).toBeUndefined();
  });
});

describe("planInline keepPaths", () => {
  it("leaves comments on kept paths alone", () => {
    const ex = (id: number, path: string, line: number) => ({ id, isBot: true, body: inlineBody({ path, line, message: "old" }) });
    const existing = [ex(1, "a.md", 2), ex(2, "b.md", 2)];
    const findings = [{ path: "a.md", line: 2, message: "new text" }, { path: "c.md", line: 1, message: "n" }];
    const plain = planInline(findings, existing);
    expect(plain.update.map((u) => u.id).sort()).toEqual([1, 2]);
    const kept = planInline(findings, existing, {}, new Set(["a.md", "b.md"]));
    expect(kept.update).toEqual([]);
    expect(kept.create.map((c) => c.path)).toEqual(["c.md"]);
  });
});
