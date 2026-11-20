import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../core/config.js";
import type { LlmProvider, LlmRequest } from "../core/llm/provider.js";
import { buildSystemPrompt, estimateTokens, runTriage, SYSTEM_PROMPT, WORKFLOW_RULES, workflowPrompt } from "../core/triage.js";
import type { PrFile } from "../core/types.js";

const cfg = parseConfig("provider:\n  type: openai\n  model: fake\n");

const file = (path: string, extra: Partial<PrFile> = {}): PrFile =>
  ({ path, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+x", ...extra });

/** Records the prompts runTriage sends and answers with minimal valid triage JSON. */
function fakeReview(paths: string[]): { calls: LlmRequest[]; provider: LlmProvider } {
  const calls: LlmRequest[] = [];
  const text = JSON.stringify({ summary: "s", files: paths.map((path) => ({ path, lane: "review", reason: "logic", findings: [] })) });
  return { calls, provider: { label: "fake", providerId: "openai", complete: async (req) => { calls.push(req); return text; } } };
}

const patch = readFileSync(new URL("./fixtures/workflow-ci/inventory-scan.patch", import.meta.url), "utf8").trimEnd();
const scan: PrFile = { path: ".github/workflows/inventory-scan.yml", status: "modified", additions: 8, deletions: 2, patch };

describe("workflow rubric prompt", () => {
  it("stays out of the base system prompt", () => {
    expect(buildSystemPrompt()).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({})).toBe(SYSTEM_PROMPT);
    expect(buildSystemPrompt({})).not.toContain(WORKFLOW_RULES);
  });

  it("is appended for workflow files, nested ones, and renames away from workflows", () => {
    expect(workflowPrompt([scan])).toBe(`\n\n${WORKFLOW_RULES}`);
    expect(workflowPrompt([file(".github/workflows/foo/bar.yaml"), file("src/app.ts")])).toContain(WORKFLOW_RULES);
    expect(workflowPrompt([{ path: "src/renamed.ts", previousPath: ".github/workflows/old.yml", status: "renamed", additions: 0, deletions: 0 }])).toContain(WORKFLOW_RULES);
    expect(workflowPrompt([])).toBe("");
  });

  it("is not appended for non-workflow files", () => {
    for (const p of ["src/app.ts", ".github/dependabot.yml", ".github/workflows/README.md", "docker-compose.yml", "docs/ci.md"])
      expect(workflowPrompt([file(p)])).toBe("");
  });

  it("runTriage sends it only when a workflow file is in the files list", async () => {
    const wf = fakeReview([".github/workflows/inventory-scan.yml", "src/app.ts"]);
    await runTriage(wf.provider, { title: "T", body: "", files: [scan, file("src/app.ts")] }, cfg);
    expect(wf.calls[0]!.system).toContain(WORKFLOW_RULES);

    const code = fakeReview(["src/app.ts"]);
    await runTriage(code.provider, { title: "T", body: "", files: [file("src/app.ts")] }, cfg);
    expect(code.calls[0]!.system).not.toContain(WORKFLOW_RULES);
  });

  it("costs at most 220 estimated tokens", () => {
    expect(estimateTokens(WORKFLOW_RULES)).toBeLessThanOrEqual(220);
  });
});

describe("workflow-ci fixture", () => {
  const base = readFileSync(new URL("./fixtures/workflow-ci/inventory-scan.base.yml", import.meta.url), "utf8");
  const expected = readFileSync(new URL("./fixtures/workflow-ci/expected-findings.md", import.meta.url), "utf8");

  it("only fixes the concurrency group and adds the artifact upload", () => {
    expect(patch).toContain("-  group: inventory-scan-${{ github.run_id }}");
    expect(patch).toContain("+  group: inventory-scan");
    expect(patch).toContain("+  cancel-in-progress: false");
    expect(patch).toContain("+        uses: actions/upload-artifact@v4");
    expect(patch).toContain("+          if-no-files-found: error");
    expect(patch).not.toContain("continue-on-error");
    expect(patch).not.toContain("queue: max"); // the exact fix the review must propose
  });

  it("leaves the stale summary line outside the changed hunks", () => {
    expect(base).toContain('echo "Detailed inventory publication is disabled." >> "$GITHUB_STEP_SUMMARY"');
    expect(patch).not.toContain("Detailed inventory publication");
  });

  it("records the three expected finding themes for the eval", () => {
    const flat = expected.replace(/\s+/g, " "); // prose wrapping must not hide a theme
    for (const theme of ["queue: max", "if-no-files-found: error", "Detailed inventory publication is disabled."])
      expect(flat).toContain(theme);
  });
});
