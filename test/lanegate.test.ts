import { describe, expect, it, vi } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { parseConfig } from "../core/config.js";
import { createCheckRun } from "../core/github.js";
import { postReviewResult, type ReviewResult } from "../core/review.js";
import { CHECK_CONCLUSION, checkConclusion, renderComment } from "../core/render.js";
import type { Lane } from "../core/types.js";

const LANES: Lane[] = ["auto", "review", "block"];
const repo = { owner: "o", repo: "r" };
const mkAgg = (lane: Lane) => ({ lane, files: [], labelReasons: [], summary: "s", rubric: [] }) as never;

describe("lane_gate config", () => {
  it("defaults to enforce and accepts each value", () => {
    expect(parseConfig("").lane_gate).toBe("enforce");
    for (const v of ["off", "observe", "enforce"]) expect(parseConfig(`lane_gate: ${v}`).lane_gate).toBe(v);
  });
  it("rejects other values", () => {
    expect(() => parseConfig("lane_gate: warn")).toThrow(/Invalid \.mergejudge\.yml: lane_gate/);
  });
});

describe("checkConclusion", () => {
  it("matrix", () => {
    for (const l of LANES) expect(checkConclusion(l, "enforce")).toBe(CHECK_CONCLUSION[l]);
    expect(LANES.map((l) => checkConclusion(l, "observe"))).toEqual(["success", "neutral", "neutral"]);
    expect(LANES.map((l) => checkConclusion(l, "off"))).toEqual(["success", "success", "success"]);
    expect(checkConclusion("block")).toBe("failure");
  });
});

describe("createCheckRun per mode", () => {
  const run = async (lane: Lane, mode?: "off" | "observe" | "enforce") => {
    const create = vi.fn(async () => ({}));
    await createCheckRun({ rest: { checks: { create } } } as never, repo, "sha", mkAgg(lane), mode);
    return (create.mock.calls[0] as unknown as [{ conclusion: string; output: { title: string; summary: string } }])[0];
  };
  it("enforce is unchanged", async () => {
    const c = await run("block");
    expect(c.conclusion).toBe("failure");
    expect(c.output.title).toBe("Lane: block");
  });
  it("observe never fails and says what it would have been", async () => {
    const c = await run("block", "observe");
    expect(c.conclusion).toBe("neutral");
    expect(c.output.title).toBe("Observe: would block");
    expect(c.output.summary).toContain("would have been `block`");
    expect((await run("review", "observe")).output.title).toBe("Observe: would review");
    expect((await run("auto", "observe")).conclusion).toBe("success");
  });
  it("off always passes", async () => {
    const c = await run("block", "off");
    expect(c.conclusion).toBe("success");
    expect(c.output.title).toBe("Lane gate off (lane: block)");
  });
});

describe("renderComment notes", () => {
  const md = (lane: Lane, laneGate?: "off" | "observe" | "enforce") =>
    renderComment({ agg: mkAgg(lane), mode: "rules-only", tokensEstimate: 0, notes: [], ...(laneGate ? { laneGate } : {}) });
  it("per mode", () => {
    expect(md("block", "observe")).toContain("*Observe mode (`lane_gate: observe`): the `mergejudge/lane` check never fails; this PR would have been `block`.*");
    expect(md("block", "observe")).not.toContain("fails the `mergejudge/lane` check.*");
    expect(md("block", "off")).toContain("*Lane gate off (`lane_gate: off`): the check always passes.*");
    expect(md("block", "enforce")).toBe(md("block"));
    expect(md("block")).toContain("*`block` fails the `mergejudge/lane` check.*");
  });
});

describe("postReviewResult", () => {
  const post = async (yaml: string, lane: Lane, kind: "review" | "learning-block" = "review") => {
    const cfg = parseConfig(`approval:\n  enabled: true\n  mode: bot-approve\n${yaml}`);
    const calls: string[] = [];
    const checks: { conclusion: string }[] = [];
    const ok = {
      paginate: async () => [],
      graphql: async () => { calls.push("graphql"); return {}; },
      rest: {
        issues: { createComment: async () => ({}), updateComment: async () => ({}), listComments: "c" },
        pulls: { createReview: async () => { calls.push("approve"); return {}; } },
        checks: { create: async (a: { conclusion: string }) => { checks.push(a); return {}; } },
      },
    };
    const logs: string[] = [];
    const r = { schemaVersion: 1, kind, prNumber: 1, headSha: "sha", prNodeId: "n", lane, agg: mkAgg(lane), body: "b", findings: [], syncInline: false,
      usage: { lane, mode: "rules-only", model: null, cached: false, breakdown: null, tokens: 0 } } as unknown as ReviewResult;
    const log = { info: (m: string) => logs.push(m), warning: (m: string) => logs.push(m) };
    await postReviewResult(r, { ok: ok as never, repo, cfg, log, appToken: true } as never);
    return { calls, checks, logs };
  };
  it("enforce still approves an auto PR", async () => {
    const x = await post("", "auto");
    expect(x.calls).toContain("approve");
    expect(x.logs.some((l) => l.includes("lane_gate"))).toBe(false);
  });
  it.each(["observe", "off"])("%s skips approval and auto-merge", async (mode) => {
    const x = await post(`lane_gate: ${mode}\n`, "auto");
    expect(x.calls).toEqual([]);
    expect(x.logs).toContain(`lane_gate ${mode}: approval and auto-merge skipped`);
  });
  it("learning-block still fails in observe and off", async () => {
    for (const mode of ["observe", "off"]) expect((await post(`lane_gate: ${mode}\n`, "block", "learning-block")).checks[0]!.conclusion).toBe("failure");
  });
});
