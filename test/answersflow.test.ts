import { describe, expect, it, vi } from "vitest";
import { renderRoundsMarker, parseRoundsMarker } from "../core/answers.js";
import { parseConfig } from "../core/config.js";
import { inlineBody } from "../core/inline.js";
import { escapeMd, MARKER } from "../core/render.js";
import { runReview } from "../core/review.js";

const HEAD = "b".repeat(40);
const PREV = "a".repeat(40);
const patch = "@@ -1 +1,3 @@\n keep\n+TODO fix this later\n+second line here";
const finding = { path: "a.md", line: 2, quote: "TODO fix this later", message: "left a TODO" };
const root = { databaseId: 11, body: inlineBody(finding, { sha: PREV }), author: { login: "mj[bot]", __typename: "Bot" } };
const thread = (replies: object[] = [], resolved = false) => ({ isResolved: resolved, path: "a.md", comments: { nodes: [root, ...replies] } });

interface Opts { yaml?: string; threads?: object[]; sticky?: string; changed?: string[]; status?: string; compareFails?: boolean; threadsFail?: boolean; paths?: string[]; review?: object[] }

/** A fake Octokit (tagged list endpoints, recorded writes) plus a fake Workers AI binding as the model. */
function setup(o: Opts = {}) {
  const paths = o.paths ?? ["a.md"];
  const calls: Record<string, unknown[][]> = {};
  const rec = (n: string, ...a: unknown[]) => { (calls[n] ??= []).push(a); };
  const prompts: string[] = [];
  const data: Record<string, unknown[]> = {
    files: paths.map((p) => ({ filename: p, status: "modified", additions: 2, deletions: 0, patch })),
    comments: o.sticky === undefined ? [] : [{ id: 5, body: o.sticky, user: { type: "Bot" } }],
    reviewComments: o.review ?? [],
  };
  const ok = {
    paginate: async (tag: string) => { rec("paginate", tag); return data[tag]; },
    graphql: async (q: string, v: unknown) => {
      rec("graphql", q, v);
      if (q.includes("reviewThreads") && o.threadsFail) throw new Error("graphql down");
      if (q.includes("reviewThreads")) return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: o.threads ?? [] } } } };
      return {};
    },
    rest: {
      pulls: { listFiles: "files", listReviewComments: "reviewComments", createReview: async (a: unknown) => rec("createReview", a), updateReviewComment: async (a: unknown) => rec("updateReviewComment", a) },
      issues: { listComments: "comments", createComment: async (a: unknown) => rec("createComment", a), updateComment: async (a: unknown) => rec("updateComment", a) },
      checks: { create: async (a: unknown) => rec("check", a) },
      repos: {
        compareCommitsWithBasehead: async (a: unknown) => {
          rec("compare", a);
          if (o.compareFails) throw new Error("boom");
          return { data: { status: o.status ?? "ahead", files: (o.changed ?? ["b.md"]).map((f) => ({ filename: f, status: "modified" })) } };
        },
        getContent: async () => { throw Object.assign(new Error("nf"), { status: 404 }); },
      },
    },
  };
  const ai = {
    run: async (_m: string, input: { messages: { content: string }[] }) => {
      prompts.push(JSON.stringify(input.messages));
      return { response: JSON.stringify({ summary: "s", files: paths.map((p) => ({ path: p, lane: "auto", reason: "docs", findings: [finding] })) }) };
    },
  };
  const warn = vi.fn();
  const run = () => runReview({
    ok: ok as never, repo: { owner: "o", repo: "r" }, appToken: false, botLogin: null, cfgRef: "main", bindings: { ai },
    pr: { number: 1, node_id: "n", head: { sha: HEAD, ref: "feat" }, labels: [] } as never,
    cfg: parseConfig(`provider:\n  type: workers-ai\n  model: m\n${o.yaml ?? ""}`),
    contextSource: { listPaths: async () => null, readFile: async () => null, searchSymbol: async () => [] },
    log: { info: vi.fn(), warning: warn },
  });
  const sticky = () => {
    const w = [...(calls.updateComment ?? []), ...(calls.createComment ?? [])].at(-1)?.[0] as { body: string } | undefined;
    return w?.body ?? "";
  };
  return { run, calls, prompts, sticky, warn };
}
const n = (s: ReturnType<typeof setup>, k: string) => (s.calls[k] ?? []).length;
const listThreadQueries = (s: ReturnType<typeof setup>) => (s.calls.graphql ?? []).filter((c) => String(c[0]).includes("reviewThreads"));
const NOT_ANSWERED = escapeMd("1 AI finding(s) not answered yet: fix the code or reply on the thread with a reason");
const answerOn = "review:\n  answer_findings: true\n";

describe("runReview defaults (both options off)", () => {
  it("makes no extra GitHub calls and writes no rounds marker", async () => {
    const s = setup({ sticky: `${MARKER}\nold` });
    expect(await s.run()).toBe("auto");
    expect(listThreadQueries(s)).toHaveLength(0);
    expect(n(s, "compare")).toBe(0);
    // files, one sticky read inside upsert, existing review comments: nothing else.
    expect((s.calls.paginate ?? []).map((c) => c[0])).toEqual(["files", "comments", "reviewComments"]);
    expect(s.sticky()).not.toContain("mergejudge:rounds");
  });
});

describe("runReview answer_findings", () => {
  it("reads threads and raises auto to review while the finding is unanswered", async () => {
    const s = setup({ yaml: answerOn, threads: [thread()] });
    expect(await s.run()).toBe("review");
    expect(listThreadQueries(s)).toHaveLength(1);
    expect(s.sticky()).toContain(NOT_ANSWERED);
    expect(String((s.calls.check![0]![0] as { output: { summary: string } }).output.summary)).toContain("not answered yet");
  });
  it("keeps auto when a person replied with a reason", async () => {
    const reply = { databaseId: 12, body: "intended, tracked in #12", author: { login: "dev", __typename: "User" } };
    const s = setup({ yaml: answerOn, threads: [thread([reply])] });
    expect(await s.run()).toBe("auto");
    expect(s.sticky()).not.toContain("not answered yet");
  });
  it("ignores threads that are not ours (human root, no marker)", async () => {
    const human = { isResolved: false, path: "a.md", comments: { nodes: [{ ...root, author: { login: "dev", __typename: "User" } }] } };
    const plain = { isResolved: false, path: "a.md", comments: { nodes: [{ ...root, body: "no marker here" }] } };
    const s = setup({ yaml: answerOn, threads: [human, plain] });
    expect(await s.run()).toBe("review"); // no thread of ours answers the finding
  });
  it("keeps auto when the thread was resolved", async () => {
    const s = setup({ yaml: answerOn, threads: [thread([], true)] });
    expect(await s.run()).toBe("auto");
  });
  it("notes and keeps the lane when the thread query fails", async () => {
    const s = setup({ yaml: answerOn, threadsFail: true });
    expect(await s.run()).toBe("auto");
    expect(s.sticky()).toContain("Could not read review threads; answer check skipped.");
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining("Could not read review threads"));
  });
});

describe("runReview max_rounds", () => {
  const cap = "review:\n  max_rounds: 2\n";
  const stickyAt = (nn: number) => `${MARKER}\nold\n${renderRoundsMarker(nn, PREV)}`;
  it("reads the marker, diffs since the last reviewed commit and sends only those files to the model", async () => {
    const existing = [{ id: 21, body: inlineBody({ ...finding, path: "a.md" }, { sha: PREV }), user: { type: "Bot" } }];
    const s = setup({ yaml: cap, sticky: stickyAt(2), paths: ["a.md", "b.md"], changed: ["b.md"], review: existing });
    await s.run();
    expect(s.calls.compare![0]![0]).toMatchObject({ basehead: `${PREV}...${HEAD}` });
    const sent = s.prompts.join();
    expect(sent).toContain("b.md");
    expect(sent).not.toContain("a.md");
    const body = s.sticky();
    expect(body).toContain(escapeMd("Round 3 (cap 2): AI reviewed only the 1 file(s) changed since aaaaaaa"));
    expect(parseRoundsMarker(body)).toEqual({ n: 3, sha: HEAD });
    // The earlier comment on a.md is neither resolved nor updated.
    expect(n(s, "updateReviewComment")).toBe(0);
  });
  it("does not diff before the cap and still appends the marker", async () => {
    const s = setup({ yaml: cap, sticky: stickyAt(1), paths: ["a.md", "b.md"] });
    await s.run();
    expect(n(s, "compare")).toBe(0);
    expect(s.prompts.join()).toContain("a.md");
    expect(parseRoundsMarker(s.sticky())).toEqual({ n: 2, sha: HEAD });
  });
  it("starts at round 1 with no sticky comment", async () => {
    const s = setup({ yaml: cap });
    await s.run();
    expect(parseRoundsMarker(s.sticky())).toEqual({ n: 1, sha: HEAD });
  });
  it("reviews the full PR and says so when the compare is not usable", async () => {
    for (const o of [{ status: "diverged" }, { compareFails: true }, { changed: [] }]) {
      const s = setup({ yaml: cap, sticky: stickyAt(2), paths: ["a.md", "b.md"], ...o });
      await s.run();
      expect(s.prompts.join()).toContain("a.md");
      expect(s.sticky()).toContain(escapeMd(`Round 3: could not diff against aaaaaaa; reviewed the full PR.`));
      expect(parseRoundsMarker(s.sticky())).toEqual({ n: 3, sha: HEAD });
    }
  });
  it("keeps the same round on a re-run of the same head", async () => {
    const s = setup({ yaml: cap, sticky: `${MARKER}\n${renderRoundsMarker(3, HEAD)}`, paths: ["a.md", "b.md"] });
    await s.run();
    expect(n(s, "compare")).toBe(0);
    expect(parseRoundsMarker(s.sticky())).toEqual({ n: 3, sha: HEAD });
  });
});
