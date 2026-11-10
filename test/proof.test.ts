import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { parseConfig } from "../core/config.js";
import type { ReviewResult } from "../core/review.js";
import type { PrFile } from "../core/types.js";
import type { RunnerJobPayload } from "../core/protocol.js";
import { produceResult } from "../src/job.js";
import { resolveLocalCode } from "../src/localcode.js";
import { PROOF_BADGE, applyProofTests, insertProofSection, isProofBadged, type ProofDeps } from "../src/proof/index.js";
import { filterTestSource, languageOf } from "../src/proof/filter.js";
import { parseSensitivePaths, proofGate, sensitiveFromPolicyFiles } from "../src/proof/gate.js";
import { resolveProofOptions } from "../src/proof/options.js";
import { parseIntent, parseTest } from "../src/proof/prompts.js";
import { proveTest } from "../src/proof/prove.js";
import { classify, interpreterFor, runSandboxed, SCRATCH, type RunResult } from "../src/proof/run.js";
import { bwrapArgs, bwrapSandbox, detectSandbox, unsandboxedForTests, type Sandbox } from "../src/proof/sandbox.js";
import { main } from "../src/cli.js";
import { captureLog, FakeWorker, makeFakeClaude, tmp, tok, writeCfg } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
const put = (root: string, p: string, t: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); };

// ---------------------------------------------------------------- fixtures
const BASE_CALC = "export const add = (a, b) => a + b;\n";
const HEAD_CALC = "export const add = (a, b) => a - b;\n";
const GOOD_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/calc.mjs";
test("add sums its arguments", () => { assert.equal(add(2, 3), 5); });
`;

function makeTrees(base = BASE_CALC, head = HEAD_CALC) {
  const root = tmp("mjr-proof-trees-");
  const baseRoot = join(root, "base"), headRoot = join(root, "head");
  put(baseRoot, "src/calc.mjs", base);
  put(headRoot, "src/calc.mjs", head);
  return { baseRoot, headRoot };
}
const prove = (code: string, trees = makeTrees(), over: Partial<Parameters<typeof proveTest>[0]> = {}) =>
  proveTest({ sandbox: unsandboxedForTests(), language: "javascript", code, timeoutMs: 15_000, ...trees, ...over });

/** An origin with a base commit and a head commit that breaks `add`, as a bare clone the proof step can read. */
function makeRepo() {
  const work = tmp("mjr-proof-work-");
  git(work, "init", "-q", "-b", "main");
  put(work, "src/calc.mjs", BASE_CALC);
  put(work, "src/other.mjs", "export const id = (x) => x;\n");
  put(work, "REVIEW.md", "## Sensitive paths\n- `src/**`\n");
  git(work, "add", "-A"); git(work, "commit", "-qm", "base");
  const base = git(work, "rev-parse", "HEAD");
  put(work, "src/calc.mjs", HEAD_CALC);
  put(work, "src/other.mjs", "export const id = (x) => x + 0;\n");
  git(work, "add", "-A"); git(work, "commit", "-qm", "head");
  const head = git(work, "rev-parse", "HEAD");
  const gitDir = join(tmp("mjr-proof-bare-"), "app.git");
  git(work, "clone", "-q", "--bare", work, gitDir);
  return { work, gitDir, base, head };
}

const patchOf = (path: string) => `@@ -1 +1 @@\n-old\n+new ${path}`;
const FILES: PrFile[] = [
  { path: "src/calc.mjs", status: "modified", additions: 1, deletions: 1, patch: patchOf("calc") },
  { path: "src/other.mjs", status: "modified", additions: 1, deletions: 1, patch: patchOf("other") },
];

function makeResult(over: Partial<ReviewResult> = {}): ReviewResult {
  const cfg = parseConfig("");
  const agg = aggregate(FILES, [], cfg, null);
  const body = "## MergeJudge\n\nfindings here\n\n---\n\nfooter";
  return {
    schemaVersion: 1, kind: "review", prNumber: 5, headSha: "x", prNodeId: "PR_x", lane: "block", agg, body, syncInline: true,
    findings: [
      { path: "src/calc.mjs", line: 1, message: "add now subtracts" },
      { path: "src/other.mjs", line: 1, message: "id adds zero, harmless" },
    ],
    usage: { lane: "block", mode: "diff", model: "m", cached: false, breakdown: null, tokens: 1 },
    ...over,
  } as ReviewResult;
}

const INTENT_HIGH_FIRST = JSON.stringify({ intent: "Refactors arithmetic helpers", risk: "add could return wrong sums", findings: [{ id: 0, severity: "high", testable: true }, { id: 1, severity: "low", testable: true }] });
const TEST_REPLY = (code = GOOD_TEST) => JSON.stringify({ test: code, asserts: "add(2, 3) is 5" });

function deps(over: Partial<ProofDeps> & { llm?: ProofDeps["llm"] } = {}): ProofDeps & { lines: string[]; llm: ReturnType<typeof vi.fn> } {
  const repo = (over as { repo?: ReturnType<typeof makeRepo> }).repo ?? makeRepo();
  const cap = captureLog();
  const llm = vi.fn(async (req: { system: string; user: string }) => (req.user.includes("Rate every") || req.user.includes("rate every") ? INTENT_HIGH_FIRST : TEST_REPLY()));
  return {
    opts: { enabled: true, maxPerPr: 3, timeoutMs: 15_000 },
    llm,
    sandbox: async () => unsandboxedForTests(),
    gitDir: repo.gitDir, baseSha: repo.base, headSha: repo.head,
    pr: { title: "Refactor math", body: "tidy" },
    sensitive: [], files: FILES,
    readFileAt: async () => HEAD_CALC,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    log: cap.log, lines: cap.lines,
    ...over,
  } as ProofDeps & { lines: string[]; llm: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------- settings
describe("settings (owner side, default OFF)", () => {
  it("is off by default and bounded when on", () => {
    expect(resolveProofOptions({})).toEqual({ enabled: false, maxPerPr: 3, timeoutMs: 20_000 });
    expect(resolveProofOptions({ MERGEJUDGE_PROOF_TESTS: "1", MERGEJUDGE_PROOF_TESTS_MAX: "500", MERGEJUDGE_PROOF_TESTS_TIMEOUT_SECONDS: "0.1" })).toEqual({ enabled: true, maxPerPr: 10, timeoutMs: 2000 });
  });
  it("flag > env > config file; junk is skipped; off wins when written as off", () => {
    expect(resolveProofOptions({ MERGEJUDGE_PROOF_TESTS: "0" }, { enabled: true }).enabled).toBe(false);
    expect(resolveProofOptions({}, { enabled: true }).enabled).toBe(true);
    expect(resolveProofOptions({ MERGEJUDGE_PROOF_TESTS: "0" }, { enabled: false }, { enabled: true }).enabled).toBe(true);
    expect(resolveProofOptions({ MERGEJUDGE_PROOF_TESTS: "maybe" }).enabled).toBe(false);
    expect(resolveProofOptions({ MERGEJUDGE_PROOF_TESTS_MAX: "x" }, { maxPerPr: 2 }).maxPerPr).toBe(2);
  });
  it("the reviewed repo's .mergejudge.yml has no key for it", () => {
    const cfg = parseConfig("runner:\n  proof_tests: true\nproof_tests: true\n") as unknown as Record<string, unknown>;
    expect(JSON.stringify(cfg)).not.toMatch(/proof/);
  });
});

// ---------------------------------------------------------------- flag off
describe("flag off is a no-op", () => {
  it("applyProofTests does nothing at all: no model call, no sandbox probe, no temp dir, no log, result untouched", async () => {
    const d = deps({ opts: { enabled: false, maxPerPr: 3, timeoutMs: 1000 } });
    const sandbox = vi.fn(async () => unsandboxedForTests());
    const r = makeResult();
    const before = JSON.stringify(r);
    const sum = await applyProofTests(r, { ...d, sandbox });
    expect(sum).toEqual({ ran: false, reason: "off", attempted: 0, proven: 0 });
    expect(d.llm).not.toHaveBeenCalled();
    expect(sandbox).not.toHaveBeenCalled();
    expect(d.lines).toEqual([]);
    expect(JSON.stringify(r)).toBe(before);
  });
});

// ---------------------------------------------------------------- gate
describe("gate", () => {
  it("parses globs from a 'sensitive' REVIEW.md section only", () => {
    const md = [
      "# REVIEW", "## What matters", "- `src/not-this/**`", "## Sensitive paths", "- `src/auth/**`", "* `billing/` and `db/migrations/*.sql`", "1. `./infra/**`", "- no backticks here", "- `/etc/passwd` `../up` `!neg`", "```", "- `fenced/**`", "```", "## Other", "- `after/**`",
    ].join("\n");
    expect(parseSensitivePaths(md)).toEqual(["src/auth/**", "billing/**", "db/migrations/*.sql", "infra/**"]);
    expect(parseSensitivePaths("no headings, `src/**`")).toEqual([]);
    expect(parseSensitivePaths("### Sensitive\n- `a/**`")).toEqual(["a/**"]);
  });
  it("only REVIEW.md counts, wherever it is read from", () => {
    expect(sensitiveFromPolicyFiles({ "REVIEW.md": "## Sensitive\n- `a/**`", "AGENTS.md": "## Sensitive\n- `b/**`" })).toEqual(["a/**"]);
  });
  it("runs for the red lane, or when a sensitive path is touched; never for an amber or green PR without one", () => {
    expect(proofGate({ lane: "block", paths: ["README.md"], sensitive: [] })).toMatchObject({ run: true, reason: "red lane (block)" });
    expect(proofGate({ lane: "review", paths: ["src/auth/login.ts"], sensitive: ["src/auth/**"] })).toMatchObject({ run: true });
    expect(proofGate({ lane: "auto", paths: ["old/name.ts", "src/auth/x.ts"], sensitive: ["src/auth/**"] })).toMatchObject({ run: true });
    expect(proofGate({ lane: "review", paths: ["src/ui/button.ts"], sensitive: ["src/auth/**"] })).toMatchObject({ run: false });
    expect(proofGate({ lane: "auto", paths: ["src/a.ts"], sensitive: [] })).toMatchObject({ run: false });
    expect(proofGate({ lane: "review", paths: [".github/x"], sensitive: [".github/**"] })).toMatchObject({ run: true });
  });
  it("applyProofTests: a gated-out PR costs nothing (no model call, no sandbox)", async () => {
    const d = deps({ sensitive: [] });
    const sandbox = vi.fn(async () => unsandboxedForTests());
    const r = makeResult({ lane: "review" });
    const before = JSON.stringify(r);
    const sum = await applyProofTests(r, { ...d, sandbox });
    expect(sum.ran).toBe(false);
    expect(d.llm).not.toHaveBeenCalled();
    expect(sandbox).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).toBe(before);
    expect(d.lines.join("\n")).toMatch(/not run \(lane review/);
  });
  it("a sensitive path lets an amber PR through", async () => {
    const d = deps({ sensitive: ["src/**"] });
    const r = makeResult({ lane: "review" });
    const sum = await applyProofTests(r, d);
    expect(sum).toMatchObject({ ran: true, proven: 1 });
  });
});

// ---------------------------------------------------------------- classification
describe("base-pass / head-fail classification (real node, real files)", () => {
  it("passes on base and fails on head, twice: proven", async () => {
    const v = await prove(GOOD_TEST);
    expect(v).toEqual({ status: "proven", reason: "passes on base, fails on head, same result on rerun" });
  });
  it("passes on both: not proven", async () => {
    expect(await prove(GOOD_TEST, makeTrees(BASE_CALC, BASE_CALC))).toMatchObject({ status: "not-proven", reason: "test passes on head too" });
  });
  it("fails on base too (the test is wrong, or the bug was already there): not proven", async () => {
    expect(await prove(GOOD_TEST, makeTrees(HEAD_CALC, HEAD_CALC))).toMatchObject({ status: "not-proven", reason: expect.stringContaining("does not pass on base") });
  });
  it("head that no longer loads (import error) is an error, not a proof", async () => {
    const t = makeTrees(BASE_CALC, "export const renamed = 1;\n");
    expect(await prove(GOOD_TEST, t)).toMatchObject({ status: "not-proven", reason: expect.stringContaining("not an assertion failure") });
  });
  it("head that throws instead of failing an assertion is not a proof", async () => {
    const t = makeTrees(BASE_CALC, "export const add = () => { throw new Error('boom'); };\n");
    expect(await prove(GOOD_TEST, t)).toMatchObject({ status: "not-proven" });
  });
  it("head that hangs hits the time limit: not proven, and the run ends", async () => {
    const t = makeTrees(BASE_CALC, "export const add = () => { for (;;) {} };\n");
    const t0 = Date.now();
    const v = await prove(GOOD_TEST, t, { timeoutMs: 700 });
    expect(v.status).toBe("not-proven");
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
  it("a result that flips on rerun is not deterministic: not proven", async () => {
    const flaky = [
      'import fs from "node:fs";',
      'const f = new URL("../.mj-proof/count", import.meta.url);',
      "let n = 0; try { n = Number(fs.readFileSync(f)); } catch {}",
      "fs.writeFileSync(f, String(n + 1));",
      "export const add = (a, b) => (n === 0 ? a - b : a + b);",
    ].join("\n");
    expect(await prove(GOOD_TEST, makeTrees(BASE_CALC, flaky))).toMatchObject({ status: "not-proven", reason: expect.stringContaining("not deterministic") });
  });
  it("code under test that writes outside the scratch directory is caught (no side effects outside the temp dir)", async () => {
    const leaky = ['import fs from "node:fs";', 'fs.writeFileSync(new URL("../leak.txt", import.meta.url), "x");', HEAD_CALC].join("\n");
    const t = makeTrees(BASE_CALC, leaky);
    const v = await prove(GOOD_TEST, t);
    expect(v).toMatchObject({ status: "not-proven", reason: expect.stringContaining("wrote outside its scratch directory") });
  });
  it("a test the rule filter rejects never runs", async () => {
    const t = makeTrees();
    const sandbox: Sandbox = { name: "spy", command: vi.fn(() => { throw new Error("must not run"); }) };
    const v = await proveTest({ sandbox, language: "javascript", code: `${GOOD_TEST}\nfetch("http://x");`, timeoutMs: 1000, ...t });
    expect(v).toMatchObject({ status: "not-proven", reason: expect.stringContaining("network API") });
    expect(sandbox.command).not.toHaveBeenCalled();
  });
  it("never throws: a broken sandbox is just 'not proven'", async () => {
    const sandbox: Sandbox = { name: "broken", command: () => { throw new Error("no bwrap"); } };
    const v = await proveTest({ sandbox, language: "javascript", code: GOOD_TEST, timeoutMs: 1000, ...makeTrees() });
    expect(v).toMatchObject({ status: "not-proven", reason: expect.stringContaining("could not run") });
  });

  const py = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();
  it.skipIf(!py)("python: unittest assertion failure on head only is proven", async () => {
    const root = tmp("mjr-proof-py-");
    const baseRoot = join(root, "base"), headRoot = join(root, "head");
    put(baseRoot, "calc.py", "def add(a, b):\n    return a + b\n");
    put(headRoot, "calc.py", "def add(a, b):\n    return a - b\n");
    const code = "import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\nif __name__ == '__main__':\n    unittest.main()\n";
    expect(await proveTest({ sandbox: unsandboxedForTests(), language: "python", code, timeoutMs: 15_000, baseRoot, headRoot })).toMatchObject({ status: "proven" });
    put(headRoot, "calc.py", "import nonexistent_module_zzz\n");
    expect(await proveTest({ sandbox: unsandboxedForTests(), language: "python", code, timeoutMs: 15_000, baseRoot, headRoot })).toMatchObject({ status: "not-proven" });
  });

  it("classify: only an assertion failure counts as 'fail'", () => {
    const r = (code: number | null, output: string, status: RunResult["status"] = "exit"): RunResult => ({ status, code, output });
    expect(classify("javascript", r(0, ""))).toBe("pass");
    expect(classify("javascript", r(1, "AssertionError [ERR_ASSERTION]: 3 !== 5"))).toBe("fail");
    expect(classify("javascript", r(1, "Error [ERR_MODULE_NOT_FOUND]: Cannot find module"))).toBe("error");
    expect(classify("javascript", r(1, "TypeError: x is not a function"))).toBe("error");
    expect(classify("javascript", r(null, "AssertionError", "timeout"))).toBe("error");
    expect(classify("python", r(1, "FAIL: test_add (x.T)\nAssertionError: 3 != 5"))).toBe("fail");
    expect(classify("python", r(1, "ERROR: test_add (x.T)\nImportError"))).toBe("error");
  });
});

// ---------------------------------------------------------------- rule filter + parsing
describe("rule filter", () => {
  it("accepts a plain node:test file and rejects network, process, filesystem and oversize tests", () => {
    expect(filterTestSource("javascript", GOOD_TEST)).toEqual({ ok: true, reasons: [] });
    const bad = (code: string) => filterTestSource("javascript", `${GOOD_TEST}\n${code}`).reasons.join(",");
    expect(bad('import http from "node:http";')).toMatch(/network or process/);
    expect(bad('const cp = await import("child_process");')).toMatch(/network or process/);
    expect(bad('await fetch("http://example.com");')).toMatch(/network API/);
    expect(bad('import { writeFileSync } from "node:fs"; writeFileSync("x", "y");')).toMatch(/writes to the filesystem/);
    expect(bad('readFileSync("/etc/passwd");')).toMatch(/absolute system path/);
    expect(bad("eval('1')")).toMatch(/eval/);
    expect(filterTestSource("javascript", "x".repeat(9000)).ok).toBe(false);
    expect(filterTestSource("javascript", 'import test from "node:test";\ntest("x", () => {});').reasons).toContain("has no assertion");
    expect(filterTestSource("python", "import subprocess\nimport unittest\nself.assertTrue(1)").reasons.join()).toMatch(/network or process/);
    expect(filterTestSource("python", "import unittest\nopen('f', 'w')\nself.assertTrue(1)").reasons.join()).toMatch(/for writing/);
  });
  it("languages: js and python only", () => {
    expect([languageOf("a/b.mjs"), languageOf("x.js"), languageOf("m.py"), languageOf("a.ts"), languageOf("a.go")]).toEqual(["javascript", "javascript", "python", null, null]);
  });
  it("intent and test replies are parsed defensively", () => {
    expect(parseIntent("garbage", 2)).toBeNull();
    expect(parseIntent(INTENT_HIGH_FIRST, 2)?.findings).toHaveLength(2);
    const i = parseIntent(`Sure!\n\`\`\`json\n${JSON.stringify({ intent: "a\nb", risk: "r", findings: [{ id: 9, severity: "high" }, { id: 0, severity: "nope" }, { id: 1, severity: "high", testable: false }, { id: 1, severity: "low" }] })}\n\`\`\``, 2)!;
    expect(i.intent).toBe("a b");
    expect(i.findings).toEqual([{ id: 1, severity: "high", testable: false }]);
    expect(parseTest("nope")).toBeNull();
    expect(parseTest(JSON.stringify({ test: "```js\ncode\n```", asserts: "x" }))?.code).toBe("code");
  });
});

// ---------------------------------------------------------------- orchestration
describe("applyProofTests (real git repo, real node, unsandboxed test sandbox)", () => {
  it("proven finding: badge on the finding, test in a collapsed block above the footer; unproven finding untouched", async () => {
    const d = deps({ sensitive: [] });
    const r = makeResult();
    const sum = await applyProofTests(r, d);
    expect(sum).toEqual({ ran: true, attempted: 1, proven: 1 });
    expect(r.findings[0]!.message).toBe(`${PROOF_BADGE}add now subtracts`);
    expect(isProofBadged(r.findings[0]!.message)).toBe(true);
    expect(r.findings[1]!.message).toBe("id adds zero, harmless");
    expect(r.body).toContain("Proof tests (beta)");
    expect(r.body).toContain("<details><summary>Test that passes on the base commit and fails on the head");
    expect(r.body).toContain('import { add } from "../src/calc.mjs";');
    expect(r.body.indexOf("Proof tests (beta)")).toBeLessThan(r.body.indexOf("\n---\n"));
    expect(r.body).toContain("footer");
    expect(r.body).toContain("Refactors arithmetic helpers");
    expect(r.lane).toBe("block"); // a proof never changes the lane
    expect(d.lines.join("\n")).toMatch(/src\/calc\.mjs:1: proven/);
  });
  it("only high-severity, testable findings are tried, at most the configured cap, in finding order", async () => {
    const intent = JSON.stringify({ intent: "i", risk: "r", findings: [{ id: 0, severity: "high", testable: true }, { id: 1, severity: "high", testable: true }] });
    const d = deps({ opts: { enabled: true, maxPerPr: 1, timeoutMs: 15_000 } });
    d.llm.mockImplementation(async (req: { user: string }) => (/rate every/i.test(req.user) ? intent : TEST_REPLY()));
    const r = makeResult();
    const sum = await applyProofTests(r, d);
    expect(sum.attempted).toBe(1);
    expect(d.llm).toHaveBeenCalledTimes(2); // intent + one test
    const d2 = deps({});
    d2.llm.mockImplementation(async (req: { user: string }) => (/rate every/i.test(req.user) ? JSON.stringify({ intent: "i", risk: "r", findings: [{ id: 0, severity: "medium", testable: true }, { id: 1, severity: "high", testable: false }] }) : TEST_REPLY()));
    const r2 = makeResult();
    expect(await applyProofTests(r2, d2)).toMatchObject({ ran: true, attempted: 0, proven: 0 });
    expect(d2.llm).toHaveBeenCalledTimes(1);
    expect(r2.findings.map((f) => f.message)).toEqual(["add now subtracts", "id adds zero, harmless"]);
  });
  it("findings without a verified line, or in languages with no harness, are never sent for a test", async () => {
    const d = deps({});
    const r = makeResult({ findings: [{ path: "src/calc.mjs", message: "file-level" }, { path: "docs/a.md", line: 3, message: "md" }, { path: "src/a.ts", line: 3, message: "ts" }] });
    expect(await applyProofTests(r, d)).toMatchObject({ ran: false, reason: "no eligible finding" });
    expect(d.llm).not.toHaveBeenCalled();
  });
  it("a finding that already carries the badge is not tested again", async () => {
    const d = deps({});
    const r = makeResult({ findings: [{ path: "src/calc.mjs", line: 1, message: `${PROOF_BADGE}x` }] });
    expect((await applyProofTests(r, d)).ran).toBe(false);
  });
  it("temp checkouts are removed afterwards", async () => {
    const root = tmp("mjr-proof-tmproot-");
    await applyProofTests(makeResult(), deps({ tmpRoot: root }));
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("fallback: a proof test that cannot run never changes or fails the review", () => {
  const unchanged = async (mut: (d: ReturnType<typeof deps>) => void | Promise<void>, expectLog?: RegExp) => {
    const d = deps({});
    await mut(d);
    const r = makeResult();
    const before = JSON.stringify(r);
    const sum = await applyProofTests(r, d);
    expect(JSON.stringify(r), "result must be untouched").toBe(before);
    if (expectLog) expect(d.lines.join("\n")).toMatch(expectLog);
    return sum;
  };
  it("no sandbox on this machine", async () => { expect((await unchanged((d) => { d.sandbox = async () => null; }, /no usable sandbox/)).reason).toBe("no sandbox"); });
  it("the model call throws (engine down, timeout)", async () => { await unchanged((d) => { d.llm.mockRejectedValue(new Error("engine timeout")); }, /stopped \(engine timeout\)/); });
  it("the intent answer is garbage", async () => { await unchanged((d) => { d.llm.mockResolvedValue("sorry, no JSON"); }, /intent step gave no usable answer/); });
  it("the test reply is garbage", async () => { await unchanged((d) => { d.llm.mockImplementation(async (req: { user: string }) => (/rate every/i.test(req.user) ? INTENT_HIGH_FIRST : "nope")); }, /no usable test/); });
  it("the test fails the rule filter (network)", async () => { await unchanged((d) => { d.llm.mockImplementation(async (req: { user: string }) => (/rate every/i.test(req.user) ? INTENT_HIGH_FIRST : TEST_REPLY(`${GOOD_TEST}\nawait fetch("http://x");`))); }, /rule filter/); });
  it("the test passes on head as well", async () => {
    await unchanged((d) => { d.llm.mockImplementation(async (req: { user: string }) => (/rate every/i.test(req.user) ? INTENT_HIGH_FIRST : TEST_REPLY(GOOD_TEST.replace("add(2, 3), 5", "add(2, 3), add(2, 3)")))); }, /passes on head too/);
  });
  it("the commits cannot be exported (clone gone)", async () => { await unchanged((d) => { d.gitDir = join(tmp(), "missing.git"); }, /stopped/); });
  it("a job without a local clone", async () => { expect((await unchanged((d) => { d.gitDir = null; }, /needs a job with a local clone/)).reason).toBe("no local clone"); });
  it("an aborted job stops the step quietly", async () => {
    const ac = new AbortController(); ac.abort();
    const d = deps({ signal: ac.signal });
    const r = makeResult(); const before = JSON.stringify(r);
    await applyProofTests(r, d);
    expect(JSON.stringify(r)).toBe(before);
  });
  it("a learning-block result is left alone", async () => {
    const r = makeResult({ kind: "learning-block" }); const before = JSON.stringify(r);
    expect((await applyProofTests(r, deps({}))).ran).toBe(false);
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe("comment size", () => {
  it("the section goes above the footer, or at the end without one", () => {
    expect(insertProofSection("a\n\n---\n\nfoot", "SEC")).toBe("a\n\nSEC\n\n---\n\nfoot");
    expect(insertProofSection("a", "SEC")).toBe("a\n\nSEC\n");
  });
  it("drops the test blocks, then the section, when the comment would be too long (badges stay)", async () => {
    const r = makeResult({ body: `${"x".repeat(63_900)}\n---\nf` });
    const d = deps({});
    const sum = await applyProofTests(r, d);
    expect(sum.proven).toBe(1);
    expect(r.body).not.toContain("Proof tests (beta)");
    expect(r.body.length).toBeLessThan(65_536);
    expect(r.findings[0]!.message.startsWith(PROOF_BADGE)).toBe(true);
    expect(d.lines.join("\n")).toMatch(/badges only/);
    // between the size of the section without and with the test code: tests are dropped, the badge section stays
    const probe = makeResult();
    await applyProofTests(probe, deps({}));
    const full = probe.body.length - makeResult().body.length;
    const r2 = makeResult({ body: `${"x".repeat(64_000 - Math.round(full / 2))}\n---\nf` });
    await applyProofTests(r2, deps({}));
    expect(r2.body).toContain("Proof tests (beta)");
    expect(r2.body).not.toContain("<details>");
  });
});

// ---------------------------------------------------------------- the real sandbox (skipped where namespaces are unavailable)
describe("bubblewrap sandbox", () => {
  let sb: Sandbox | null = null;
  beforeAll(async () => { sb = await detectSandbox(); });

  it("detectSandbox is null off Linux and when the probe fails", async () => {
    expect(await detectSandbox({ platform: "darwin" })).toBeNull();
    expect(await detectSandbox({ platform: "linux", probe: async () => false })).toBeNull();
    expect((await detectSandbox({ platform: "linux", probe: async () => true }))?.name).toBe("bubblewrap");
  });
  it("arguments: no network, read-only checkout, writable scratch only, no home directory", () => {
    const args = bwrapArgs({ root: "/r/head", scratch: "/r/head/.mj-proof", bin: process.execPath, args: [] });
    expect(args).toContain("--unshare-all");
    expect(args.join(" ")).toContain("--ro-bind /r/head /work --bind /r/head/.mj-proof /work/.mj-proof");
    expect(args.join(" ")).not.toMatch(/--bind \/ |--ro-bind \/ /);
    expect(args).not.toContain(process.env.HOME ?? "\0");
    expect(bwrapSandbox().command({ root: "/r", scratch: "/r/.mj-proof", bin: "/usr/bin/node", args: ["a"] }).args).toEqual(expect.arrayContaining(["--clearenv", "--chdir", "/work"]));
  });

  it("the whole proof works inside the sandbox; the test cannot reach the network or write outside", async (ctx) => {
    if (!sb) return ctx.skip();
    const hits: string[] = [];
    const server = createServer((s) => { hits.push("connect"); s.end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const outside = join(tmp("mjr-proof-outside-"), "escaped.txt");
    try {
      const nasty = [
        'import net from "node:net"; import fs from "node:fs";',
        `try { net.connect(${port}, "127.0.0.1").on("error", () => {}); } catch {}`,
        `try { fs.writeFileSync(${JSON.stringify(outside)}, "x"); } catch {}`,
        'try { fs.writeFileSync(new URL("../src/leak.txt", import.meta.url), "x"); } catch {}',
        HEAD_CALC,
      ].join("\n");
      const t = makeTrees(BASE_CALC, nasty);
      const v = await prove(GOOD_TEST, t, { sandbox: sb });
      expect(v.status).toBe("proven");
      await new Promise((r) => setTimeout(r, 200));
      expect(hits).toEqual([]);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(join(t.headRoot, "src", "leak.txt"))).toBe(false);
      // control: the same code, unsandboxed, does reach the server and the outside path (so the assertions above can fail)
      await prove(GOOD_TEST, makeTrees(BASE_CALC, nasty));
      await new Promise((r) => setTimeout(r, 200));
      expect(hits.length).toBeGreaterThan(0);
      expect(existsSync(outside)).toBe(true);
    } finally { server.close(); }
  }, 60_000);

  it("a test in the sandbox cannot read the runner's home directory", async (ctx) => {
    if (!sb) return ctx.skip();
    const home = process.env.HOME!;
    const t = makeTrees();
    put(t.headRoot, `${SCRATCH}/probe.mjs`, `import fs from "node:fs"; console.log("HOME_VISIBLE=" + fs.existsSync(${JSON.stringify(home)} + "/.config"));\n`);
    const r = await runSandboxed(sb, t.headRoot, { bin: process.execPath, args: [`${SCRATCH}/probe.mjs`], file: "x" }, { timeoutMs: 10_000 });
    expect(r.output).toContain("HOME_VISIBLE=false");
  }, 30_000);

  it("the interpreter for javascript is the runner's own node", () => {
    expect(interpreterFor("javascript")?.bin).toBe(process.execPath);
  });
});

// ---------------------------------------------------------------- job path
describe("job path: produceResult with a real local clone and a scripted engine", () => {
  const origin = (() => {
    const root = tmp("mjr-proof-origin-");
    const dir = join(root, "acme", "app.git");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "uploadpack.allowFilter", "true");
    git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    put(dir, "src/calc.mjs", BASE_CALC);
    put(dir, "REVIEW.md", "## Sensitive paths\n- `src/**`\n");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "init");
    const base = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "feature");
    put(dir, "src/calc.mjs", HEAD_CALC);
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "feature");
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "main");
    return { root, base, head, template: `file://${root}/{owner}/{repo}.git` };
  })();

  /** A claude that answers by what it is asked: triage, intent, or test. Records every prompt. */
  function scriptedClaude(triageLane: string) {
    const fc = makeFakeClaude();
    const bin = fc.bin;
    const triage = JSON.stringify({ summary: "Changes calc", files: [{ path: "src/calc.mjs", lane: triageLane, reason: "logic", findings: [{ line: 1, quote: "a - b", message: "add now subtracts instead of adding" }] }] });
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(__dirname, "record.jsonl"), JSON.stringify({ stdin }) + "\\n");
  const env = (result) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 1, output_tokens: 1 } });
  const rep = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
  if (/rate every numbered finding/i.test(stdin)) { if (rep.intent === "FAIL") process.exit(1); return process.stdout.write(env(rep.intent)); }
  if (/write one small executable test/i.test(stdin)) return process.stdout.write(env(rep.test));
  process.stdout.write(env(rep.triage));
});
`);
    const set = (r: Record<string, string>) => writeFileSync(join(fc.dir, "replies.json"), JSON.stringify(r));
    set({ triage, intent: JSON.stringify({ intent: "Tidy calc", risk: "wrong sums", findings: [{ id: 0, severity: "high", testable: true }] }), test: TEST_REPLY() });
    return { ...fc, set, prompts: () => fc.records().map((x) => x.stdin) };
  }

  const payload = (_home: string, cfgText = "policy_files: [REVIEW.md]\nreview:\n  mode: deep\nrunner:\n  code_source: local\n"): RunnerJobPayload => {
    const cfg = parseConfig(cfgText);
    const files = [{ path: "src/calc.mjs", status: "modified", additions: 1, deletions: 1 }];
    const agg = aggregate(files, [], cfg, null);
    return {
      v: 2, codeSource: "local", repo: { owner: "acme", repo: "app" },
      pr: { number: 5, title: "Tidy calc", body: "refactor", author: "alice", labels: [], node_id: "PR_x", head: { sha: origin.head, ref: "feature" }, base: { sha: origin.base, ref: "main" } },
      mode: "deep", cfg, cfgRef: origin.base, files, policyFiles: {}, policy: { text: "", used: [] },
      rules: { lane: agg.lane, files: agg.files, labelReasons: agg.labelReasons, stripped: [] },
    } as unknown as RunnerJobPayload;
  };
  const noPolicy = "policy_files: []\nreview:\n  mode: deep\nrunner:\n  code_source: local\n";
  const run = async (fc: ReturnType<typeof scriptedClaude>, ...rest: [(string | Parameters<typeof produceResult>[3]["proof"] | undefined)?, Parameters<typeof produceResult>[3]["proof"]?]) => {
    const cfgText = typeof rest[0] === "string" ? rest[0] : undefined;
    const proof = typeof rest[0] === "string" ? rest[1] : rest[0];
    const home = tmp("mjr-proof-home-");
    const env = { PATH: `${fc.dir}:${process.env.PATH}`, HOME: home, USER: "u", LANG: "C", MERGEJUDGE_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const local = resolveLocalCode(env, { remoteUrlTemplate: origin.template });
    const cap = captureLog();
    const out = await produceResult(
      { id: "j1", repo: "acme/app", pr: 5, headSha: origin.head, baseSha: origin.base, mode: "deep-local", attempt: 1, payload: payload(home, cfgText) },
      new AbortController().signal, cap.log,
      { caps: [{ engine: "claude-code", models: [], defaultModel: null, billing: "subscription" } as never], options: () => ({ bin: fc.bin, env, killGraceMs: 100 }), local, ...(proof ? { proof } : {}) },
    );
    return { ...out, lines: cap.lines };
  };

  it("flag off (no proof context): exactly one engine call, no badge, no proof section", async () => {
    const fc = scriptedClaude("block");
    const { result, calls } = await run(fc);
    expect(calls).toBe(1);
    expect(fc.prompts()).toHaveLength(1);
    expect(result.findings[0]!.message).toBe("add now subtracts instead of adding");
    expect(result.body).not.toContain("Proof tests");
  });
  it("flag present but disabled behaves the same", async () => {
    const fc = scriptedClaude("block");
    const { result, calls } = await run(fc, { opts: { enabled: false, maxPerPr: 3, timeoutMs: 15_000 }, sandbox: async () => unsandboxedForTests() });
    expect(calls).toBe(1);
    expect(result.body).not.toContain("Proof tests");
  });
  it("flag on, red lane: intent + test generated by the engine, run on base and head, finding proven", async () => {
    const fc = scriptedClaude("block");
    const { result, calls, lines } = await run(fc, { opts: { enabled: true, maxPerPr: 3, timeoutMs: 15_000 }, sandbox: async () => unsandboxedForTests() });
    expect(result.lane).toBe("block");
    expect(calls).toBe(3);
    expect(result.findings[0]!.message).toBe(`${PROOF_BADGE}add now subtracts instead of adding`);
    expect(result.body).toContain("Proof tests (beta)");
    expect(result.body).toContain("../src/calc.mjs");
    const prompts = fc.prompts();
    expect(prompts[2]).toContain("a - b");
    expect(prompts[2]).toContain("Claims: Tidy calc");
    expect(lines.join("\n")).toMatch(/proof tests: src\/calc\.mjs:1: proven/);
  }, 60_000);
  it("flag on, amber lane and nothing sensitive: no extra engine call", async () => {
    const fc = scriptedClaude("review");
    const { result, calls } = await run(fc, noPolicy, { opts: { enabled: true, maxPerPr: 3, timeoutMs: 15_000 }, sandbox: async () => unsandboxedForTests() });
    expect(result.lane).toBe("review");
    expect(calls).toBe(1);
    expect(result.body).not.toContain("Proof tests");
  });
  it("flag on, amber lane but REVIEW.md in the clone marks src/** sensitive: proof tests run", async () => {
    const fc = scriptedClaude("review");
    const { result, calls } = await run(fc, { opts: { enabled: true, maxPerPr: 3, timeoutMs: 15_000 }, sandbox: async () => unsandboxedForTests() });
    expect(result.lane).toBe("review");
    expect(calls).toBe(3);
    expect(result.findings[0]!.message.startsWith(PROOF_BADGE)).toBe(true);
  }, 60_000);
  it("flag on but the proof engine call fails: the review is still produced, unbadged", async () => {
    const fc = scriptedClaude("block");
    fc.set({ ...JSON.parse(readFileSync(join(fc.dir, "replies.json"), "utf8")), intent: "FAIL" });
    const { result, lines } = await run(fc, { opts: { enabled: true, maxPerPr: 3, timeoutMs: 15_000 }, sandbox: async () => unsandboxedForTests() });
    expect(result.findings[0]!.message).toBe("add now subtracts instead of adding");
    expect(result.lane).toBe("block");
    expect(lines.join("\n")).toMatch(/proof tests: stopped/);
  });
  it("flag on but no sandbox: review unchanged", async () => {
    const fc = scriptedClaude("block");
    const { result, calls } = await run(fc, { opts: { enabled: true, maxPerPr: 3, timeoutMs: 15_000 }, sandbox: async () => null });
    expect(calls).toBe(1);
    expect(result.body).not.toContain("Proof tests");
  });
});

describe("CLI wiring", () => {
  const runCli = async (extra: string[], env: Record<string, string> = {}) => {
    const w = await new FakeWorker().start();
    w.validAuth.add(tok("A"));
    try {
      const dir = tmp();
      const { path } = writeCfg(dir, w.url);
      const errs: string[] = [];
      const code = await main(["run", "--config", path, "--once", "--wait", "0", ...extra], { err: (l) => errs.push(l), out: () => {}, env: { PATH: process.env.PATH ?? "", HOME: dir, ...env }, exec: () => ({ status: 1 }) });
      return { code, errs: errs.join("\n") };
    } finally { await w.stop(); }
  };
  it("--proof-tests turns it on and says so; the cap flag is honoured", async () => {
    const r = await runCli(["--proof-tests", "--proof-tests-max", "2"]);
    expect(r.code).toBe(0);
    expect(r.errs).toContain("proof tests (beta) are ON");
    expect(r.errs).toContain("up to 2 generated test(s)");
  }, 30_000);
  it("the environment variable turns it on too", async () => {
    expect((await runCli([], { MERGEJUDGE_PROOF_TESTS: "1" })).errs).toContain("proof tests (beta) are ON");
  }, 30_000);
  it("default: nothing about proof tests is logged", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.errs).not.toMatch(/proof tests/);
  }, 30_000);
  it("help documents the flags", async () => {
    const out: string[] = [];
    await main(["run", "--help"], { out: (l) => out.push(l) });
    expect(out.join("\n")).toMatch(/--proof-tests-max/);
  });
});
