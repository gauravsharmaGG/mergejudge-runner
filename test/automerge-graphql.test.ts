import * as github from "@actions/github";
import { describe, expect, it } from "vitest";
import { enableAutoMerge } from "../core/github.js";

// @octokit/graphql refuses variables named `method` (and `query`, `url`, ...) before sending anything, so the mutation
// must use another variable name. Real Octokit with a fake fetch: checks the request that actually goes out.
describe("enableAutoMerge", () => {
  it("sends the mutation with a mergeMethod variable", async () => {
    const sent: any[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const ok = github.getOctokit("t", { request: { fetch } });
    await enableAutoMerge(ok, "PR_1", "squash", "a".repeat(40));
    expect(sent).toHaveLength(1);
    expect(sent[0].variables).toEqual({ id: "PR_1", mergeMethod: "SQUASH", expectedHeadOid: "a".repeat(40) });
    expect(sent[0].query).toContain("mergeMethod: $mergeMethod");
  });
});
