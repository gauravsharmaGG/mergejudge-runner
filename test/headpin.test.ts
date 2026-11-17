import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../core/config.js";
import { approvePr, createCheckRun } from "../core/github.js";
import { checkSummary, parseReviewedHead, renderComment } from "../core/render.js";
import { postReviewResult, type ReviewResult } from "../core/review.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const agg = { lane: "auto", files: [], summary: "s", explanation: "e", rubric: [], labelReasons: [] } as never;

function setup(get: () => Promise<unknown>, yaml = "") {
  const calls: Record<string, unknown[]> = {};
  const rec = (n: string) => async (a: unknown) => { (calls[n] ??= []).push(a); return { data: [] }; };
  const ok = {
    paginate: async () => [],
    graphql: async (q: string, v: unknown) => { (calls.graphql ??= []).push([q, v]); return {}; },
    rest: {
      pulls: { get, createReview: rec("createReview"), listReviews: rec("listReviews") },
      issues: { listComments: "c", createComment: rec("createComment"), updateComment: rec("updateComment") },
      checks: { create: rec("check") },
    },
  };
  const log = { info: vi.fn(), warning: vi.fn() };
  const onSnapshot = vi.fn();
  const onResult = vi.fn();
  const cfg = parseConfig(yaml);
  const r = { schemaVersion: 1, kind: "review", prNumber: 1, headSha: OLD, prNodeId: "N", lane: "auto", agg, body: "body", findings: [], syncInline: true, usage: { lane: "auto", mode: "rules-only", model: null, cached: false, breakdown: null, tokens: 0 } } as unknown as ReviewResult;
  const post = () => postReviewResult(r, { ok: ok as never, repo: { owner: "o", repo: "r" }, cfg, appToken: true, botLogin: "bot", log, onSnapshot, onResult });
  return { calls, log, onSnapshot, onResult, post };
}
const live = (sha: string, state = "open") => async () => ({ data: { state, head: { sha } } });
const approve = "approval:\n  mode: bot-approve\n  enabled: true\n";

describe("head pin", () => {
  it.each([["moved", live(NEW)], ["closed", live(OLD, "closed")]])("stale when %s: only a neutral check on the old sha", async (_n, get) => {
    const s = setup(get, approve);
    expect(await s.post()).toBe("auto");
    expect(s.calls.check!).toHaveLength(1);
    const c = s.calls.check![0] as { head_sha: string; conclusion: string; output: { title: string } };
    expect(c.head_sha).toBe(OLD);
    expect(c.conclusion).toBe("neutral");
    if (_n === "moved") expect(c.output.title).toBe("Stale: reviewed aaaaaaa, head is now bbbbbbb");
    for (const k of ["createComment", "updateComment", "createReview", "graphql"]) expect(s.calls[k]).toBeUndefined();
    expect(s.onSnapshot).not.toHaveBeenCalled();
    expect(s.onResult).toHaveBeenCalledOnce();
    if (_n === "moved") expect(s.log.warning).toHaveBeenCalledWith("Head moved from aaaaaaa to bbbbbbb during review; result not applied.");
  });

  it("same head: normal flow with approval pinned to the reviewed commit", async () => {
    const s = setup(live(OLD), approve);
    await s.post();
    expect((s.calls.check![0] as { conclusion: string; output: { summary: string } }).conclusion).toBe("success");
    expect((s.calls.check![0] as { output: { summary: string } }).output.summary).toContain("Reviewed commit aaaaaaa");
    expect(s.calls.createComment).toHaveLength(1);
    expect((s.calls.createReview![0] as { commit_id: string }).commit_id).toBe(OLD);
    expect(s.onSnapshot).toHaveBeenCalledOnce();
  });

  it("auto-merge is pinned with expectedHeadOid", async () => {
    const s = setup(live(OLD), "approval:\n  mode: auto-merge-only\n  enabled: true\n");
    await s.post();
    const g = (s.calls.graphql ?? []).find((x) => String((x as string[])[0]).includes("enablePullRequestAutoMerge")) as [string, { expectedHeadOid: string }];
    expect(g[1].expectedHeadOid).toBe(OLD);
  });

  it("a failing pulls.get warns and continues as before", async () => {
    const s = setup(async () => { throw new Error("403"); });
    await s.post();
    expect(s.log.warning).toHaveBeenCalledWith(expect.stringContaining("Could not re-read the PR head"));
    expect(s.calls.createComment).toHaveLength(1);
    expect((s.calls.check![0] as { conclusion: string }).conclusion).toBe("success");
  });

  it("approvePr sends commit_id", async () => {
    const createReview = vi.fn(async () => ({}));
    await approvePr({ rest: { pulls: { createReview } } } as never, { owner: "o", repo: "r" }, 3, OLD);
    expect(createReview).toHaveBeenCalledWith(expect.objectContaining({ commit_id: OLD, event: "APPROVE" }));
  });

  it("sticky comment names the reviewed commit and the marker round-trips", () => {
    const body = renderComment({ agg, headSha: OLD, mode: "rules-only", tokensEstimate: 0, notes: [], approval: parseConfig("").approval, prUrl: "u" } as never);
    expect(body).toContain("<sub>Reviewed commit <code>aaaaaaa</code></sub>");
    expect(parseReviewedHead(body)).toBe(OLD);
    expect(parseReviewedHead("nothing")).toBeNull();
  });

  it("check summary and createCheckRun include the sha", async () => {
    expect(checkSummary(agg, OLD).summary).toContain("Reviewed commit aaaaaaa");
    const create = vi.fn(async () => ({}));
    await createCheckRun({ rest: { checks: { create } } } as never, { owner: "o", repo: "r" }, OLD, agg);
    expect((create.mock.calls[0] as unknown as [{ output: { summary: string } }])[0].output.summary).toContain("aaaaaaa");
  });
});
