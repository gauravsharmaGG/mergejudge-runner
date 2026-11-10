import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseConfig } from "../core/config.js";
import { isProtectedPath } from "../core/shepherd.js";
import {
  buildCommitMessage, classifyFailure, countFailingChecks, countFailingTests, decide, extractFailureSection, failureCount, firstFailureLine, fingerprintFailure, isGreen, isShepherdCommitMessage,
  normalizeError, parseAttemptCommit, referencedFiles, shepherdHistory, tailLog, type DecideInput, type Fingerprint,
} from "../core/shepherdfail.js";
import { classifyConflictFile, isLockfile, mergeImportHunk, parseConflicts, unionLines } from "../core/shepherdconflict.js";
import { HANDOFF_MARKER, renderHandoff, reviewGuard } from "../core/shepherdhandoff.js";
import { routeAutoMode } from "../core/shepherdroute.js";
import { RULE, RULE_QUESTION, RULE_TITLE } from "../core/shepherdrules.js";
import { parseFixReply } from "../src/shepherd.js";

const root = join(import.meta.dirname, "..");
const cfg = parseConfig("");

describe("rule IDs", () => {
  it("the L1 question offers /mergejudge shepherd retry", () => expect(RULE_QUESTION.L1).toContain("`/mergejudge shepherd retry`"));
  it("every rule has a title and a single question", () => {
    for (const id of Object.values(RULE)) {
      expect(RULE_TITLE[id]).toContain(id);
      expect(RULE_QUESTION[id].match(/\?/g)).toHaveLength(1);
    }
  });
});

describe("error fingerprint normalisation", () => {
  it("strips ANSI, timestamps, line:col, durations, hashes, paths and numbers", () => {
    const a = "2026-10-29T10:00:00.123Z \x1b[31mError: expected 3 to equal 4 in /home/runner/work/r/r/src/a.ts:12:5 after 1.2s (abc1234def)\x1b[0m";
    const b = "2026-11-02T01:02:03.999Z \x1b[31mError: expected 8 to equal 9 in /home/runner/work/other/other/src/a.ts:99:1 after 340ms (ffee998877)\x1b[0m";
    expect(normalizeError(a)).toBe(normalizeError(b));
    expect(normalizeError(a)).not.toMatch(/\d{2,}|\x1b/);
  });
  it("keeps what identifies the failure", () => {
    expect(normalizeError("error TS2345: Argument of type 'x'")).toContain("TS2345");
    expect(normalizeError("AssertionError: foo")).not.toBe(normalizeError("AssertionError: bar"));
  });
  it("picks the first failure-pattern line, else the last lines", () => {
    expect(firstFailureLine("ok\nok\n FAIL src/a.test.ts\nError: boom")).toBe("FAIL src/a.test.ts | Error: boom");
    expect(firstFailureLine("FAIL a.test.ts")).toBe("FAIL a.test.ts");
    expect(firstFailureLine("a\nsrc/x.ts(3,4): error TS2304: Cannot find name 'q'.\nb")).toContain("error TS2304");
    expect(firstFailureLine("  12:5  error  'x' is defined but never used  no-unused-vars\n")).toContain("no-unused-vars");
    expect(firstFailureLine("--- FAIL: TestX (0.00s)\n")).toContain("--- FAIL");
    expect(firstFailureLine("FAILED tests/test_a.py::test_x - assert 1 == 2")).toContain("FAILED");
    expect(firstFailureLine("one\ntwo\nthree\nfour\n##[error]Process completed with exit code 1.")).toBe("two | three | four");
  });
  it("same failure in two runs hashes the same; another job or message differs", () => {
    const l1 = "2026-10-29T10:00:00Z FAIL a\nAssertionError: expected 1 to be 2\n";
    const l2 = "2026-10-30T11:11:11Z FAIL a\nAssertionError: expected 5 to be 6\n";
    expect(fingerprintFailure("test", l1).hash).toBe(fingerprintFailure("test", l2).hash);
    expect(fingerprintFailure("lint", l1).hash).not.toBe(fingerprintFailure("test", l1).hash);
    expect(fingerprintFailure("test", "FAIL b\nTypeError: x is not a function").hash).not.toBe(fingerprintFailure("test", l1).hash);
  });
  describe("failing step section of a real job log", () => {
    const pr8 = readFileSync(join(root, "test/fixtures/shepherd/pr8-lint-job.txt"), "utf8");
    const pr12 = readFileSync(join(root, "test/fixtures/shepherd/pr12-lint-job.txt"), "utf8");
    const CLEANUP = /Post job cleanup|\[command\]|git submodule foreach|Cleaning up orphan|Node\.js 20 is deprecated|##\[|^\d{4}-\d\d-\d\dT/m;
    it("extracted failure text holds its own error line and no cleanup lines", () => {
      const a = extractFailureSection(pr8), b = extractFailureSection(pr12);
      expect(a).toContain("src/mul.js:5: use let or const, not var");
      expect(b).toContain("src/max.js:12: use let or const, not var");
      expect(a).not.toContain("max.js");
      expect(b).not.toContain("mul.js");
      expect(a).not.toMatch(CLEANUP);
      expect(b).not.toMatch(CLEANUP);
      expect(fingerprintFailure("lint", a).raw).toContain("src/mul.js:5");
    });
    it("two different lint errors get different fingerprints, the same log twice the same one", () => {
      const fp = (log: string) => fingerprintFailure("lint", tailLog(extractFailureSection(log), 200, 20_000));
      expect(fp(pr8).hash).not.toBe(fp(pr12).hash);
      expect(fp(pr8).hash).toBe(fp(pr8).hash);
      expect(fp(pr12).hash).toBe(fingerprintFailure("lint", extractFailureSection(pr12)).hash);
    });
    it("the old whole-log tail is what collided", () => {
      expect(fingerprintFailure("lint", tailLog(pr8, 200, 20_000)).hash).toBe(fingerprintFailure("lint", tailLog(pr12, 200, 20_000)).hash);
    });
    it("a log without a post-job section or step header is kept, minus noise", () => {
      expect(extractFailureSection("2026-10-29T10:00:00.1Z ##[group]x\n2026-10-29T10:00:00.2Z boom: bad\n##[endgroup]")).toBe("boom: bad");
      expect(extractFailureSection("")).toBe("");
    });
    it("keeps the same message in two files apart", () => {
      expect(normalizeError("src/a.js:5: use let or const, not var")).not.toBe(normalizeError("src/b.js:5: use let or const, not var"));
      expect(normalizeError("/tmp/x/a.js:5: bad")).not.toBe(normalizeError("/tmp/x/b.js:5: bad"));
      expect(normalizeError("/home/runner/work/r/r/src/a.js:5: bad")).toBe(normalizeError("/home/runner/work/o/o/src/a.js:9: bad"));
    });
  });
  it("counts failing tests from common runners", () => {
    expect(countFailingTests("Tests:       3 failed, 10 passed")).toBe(3);
    expect(countFailingTests("=== 2 failed, 5 passed in 1s ===")).toBe(2);
    expect(countFailingTests("  4 failing")).toBe(4);
    expect(countFailingTests("--- FAIL: A\n--- FAIL: B\n")).toBe(2);
    expect(countFailingTests("all good")).toBeNull();
    expect(failureCount([{ tests: 3 }, { tests: null }])).toBe(5);
  });
  it("tailLog keeps the end and caps size", () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    expect(tailLog(log, 200).split("\n")).toHaveLength(200);
    expect(tailLog("x".repeat(50_000), 200, 1000)).toHaveLength(1000);
  });
  it("lists files a log references", () => {
    expect(referencedFiles("at /home/runner/work/r/r/src/a.ts:3:4\n./lib/b.py:9 failed\nnode_modules/x/y.js")).toEqual(["src/a.ts", "lib/b.py"]);
  });
});

describe("countFailingChecks (L4 baseline)", () => {
  const run = (name: string, conclusion: string | null, id?: number, status = conclusion ? "completed" : "in_progress") => ({ id, name, status, conclusion });
  const st = (context: string, state: string, id?: number) => ({ id, context, state });

  it("counts failing required checks across check runs and statuses", () => {
    const runs = [run("build", "failure"), run("lint", "success"), run("docs", "failure")];
    const statuses = [st("ext/ci", "error"), st("ext/other", "success")];
    expect(countFailingChecks(runs, statuses, ["build", "lint", "ext/ci", "ext/other"])).toEqual({ failing: 2, pending: 0 });
    expect(countFailingChecks(runs, statuses, ["lint"])).toEqual({ failing: 0, pending: 0 });
  });
  it("failing means failure, timed_out, cancelled, action_required, startup_failure (runs) or failure, error (statuses)", () => {
    const runs = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "success", "skipped", "neutral"].map((c, i) => run(`r${i}`, c));
    expect(countFailingChecks(runs, [], null).failing).toBe(5);
    expect(countFailingChecks([], ["failure", "error", "success"].map((x, i) => st(`s${i}`, x)), null).failing).toBe(2);
  });
  it("without required checks every check counts except Shepherd's own", () => {
    const runs = [run("build", "failure"), run("shepherd-job", "failure"), run("other", "failure")];
    expect(countFailingChecks(runs, [st("ext/ci", "failure")], null, [])).toEqual({ failing: 4, pending: 0 });
    expect(countFailingChecks(runs, [st("ext/ci", "failure")], null, ["shepherd-job"])).toEqual({ failing: 3, pending: 0 });
  });
  it("the latest check run per name and the latest status per context win", () => {
    const runs = [run("build", "failure", 1), run("build", "success", 2), run("lint", "success", 5), run("lint", "failure", 3)];
    expect(countFailingChecks(runs, [], null).failing).toBe(0);
    expect(countFailingChecks([run("build", "success", 2), run("build", "failure", 1)], [], null).failing).toBe(0);
    expect(countFailingChecks([run("build", "success", 1), run("build", "failure", 2)], [], null).failing).toBe(1);
    expect(countFailingChecks([], [st("ci", "failure", 1), st("ci", "success", 2)], null).failing).toBe(0);
    expect(countFailingChecks([], [st("ci", "success", 4), st("ci", "failure", 3)], null).failing).toBe(0);
  });
  it("unfinished check runs and pending statuses are pending, not failing", () => {
    expect(countFailingChecks([run("a", null), run("b", "failure")], [st("ext", "pending")], null)).toEqual({ failing: 1, pending: 2 });
    expect(countFailingChecks([run("a", null)], [], ["b"])).toEqual({ failing: 0, pending: 0 });
    expect(countFailingChecks([run("a", null)], [], null, ["a"])).toEqual({ failing: 0, pending: 0 });
  });
});

describe("decide() with checks on the head", () => {
  const fp: Fingerprint = { job: "test", hash: "new", line: "new", raw: "new", tests: null };
  const latest = { sha: "H", attempt: 1, kind: "ci" as const, fingerprints: ["old"], failures: 3 };
  const base: DecideInput = {
    needsHuman: false, on: true, maxAttempts: 3, history: { records: [latest], attempts: 1, latest }, headSha: "H", runAttempt: 2, conclusion: "failure",
    failures: [fp], cantFix: { kind: "code" }, rerunRequested: false,
  };
  it("L4 compares the failing checks on the head, not this run's failures", () => {
    expect(decide({ ...base, checks: { failing: 3, pending: 0 } })).toMatchObject({ action: "handoff", rule: RULE.L4 });
    expect(decide({ ...base, checks: { failing: 2, pending: 0 } })).toEqual({ action: "fix", attempt: 2 });
    expect(decide({ ...base, failures: [fp, { ...fp, hash: "n2" }, { ...fp, hash: "n3" }], checks: { failing: 1, pending: 0 } }).action).toBe("fix");
  });
  it("pending checks mean skip, after the loop breakers that need no full picture", () => {
    expect(decide({ ...base, checks: { failing: 1, pending: 1 } })).toMatchObject({ action: "skip" });
    expect(decide({ ...base, history: { ...base.history, latest: null, records: [], attempts: 0 }, checks: { failing: 1, pending: 2 } }).action).toBe("skip");
    expect(decide({ ...base, failures: [{ ...fp, hash: "old" }], checks: { failing: 1, pending: 1 } })).toMatchObject({ rule: RULE.L2 });
    expect(decide({ ...base, grants: 0, maxAttempts: 1, checks: { failing: 1, pending: 1 } })).toMatchObject({ action: "skip" });
  });
});

describe("H3 classifyFailure (can't-fix classes)", () => {
  const job = (log: string, conclusion = "failure") => classifyFailure([{ name: "j", conclusion }], { j: log }, (p) => isProtectedPath(p, cfg));
  it("a plain test failure is code", () => expect(job("FAIL src/a.test.ts\nAssertionError: x")).toEqual({ kind: "code" }));
  it.each([
    ["Error: Resource not accessible by integration"],
    ["Error: secret NPM_TOKEN is not set"],
    ["Input required and not supplied: token"],
    ["git@github.com: Permission denied (publickey)."],
    ["remote: Bad credentials"],
    ["npm ERR! code E403"],
    ["npm error 401 Unauthorized - GET https://registry.npmjs.org/x"],
    ["The runner has received a shutdown signal"],
    ["Error: lost communication with the server"],
    ["System.IO.IOException: No space left on device"],
    ["The job running on runner exceeded the maximum execution time of 360 minutes."],
    ["npm ERR! code ETIMEDOUT"],
    ["npm ERR! code EAI_AGAIN"],
    ["npm ERR! code E503"],
    ["503 Service Unavailable from https://pypi.org/simple/x"],
  ])("%s is cant-fix", (log) => {
    const r = job(`FAIL x\n${log}\n`);
    expect(r.kind).toBe("cant-fix");
  });
  it.each(["timed_out", "cancelled", "startup_failure"])("job conclusion %s is cant-fix", (c) => expect(job("FAIL", c).kind).toBe("cant-fix"));
  it("an invalid workflow file or protected-only files is cant-fix (H1)", () => {
    expect(job("Invalid workflow file: .github/workflows/ci.yml#L3")).toMatchObject({ kind: "cant-fix", rule: RULE.H1 });
    expect(job("error in .github/workflows/ci.yml")).toMatchObject({ kind: "cant-fix", rule: RULE.H1 });
    expect(job("error in .github/workflows/ci.yml and src/a.ts").kind).toBe("code");
  });
  it("one code failure among infra failures is still fixable", () => {
    const r = classifyFailure([{ name: "a", conclusion: "timed_out" }, { name: "b", conclusion: "failure" }], { a: "", b: "FAIL x" });
    expect(r.kind).toBe("code");
    expect(classifyFailure([], {}).kind).toBe("cant-fix");
  });
});

describe("commit trailers and attempt history", () => {
  const msg = buildCommitMessage({ subject: "shepherd: fix test (attempt 2/3)", attempt: 2, kind: "ci", fingerprints: ["aaaa111122", "bbbb333344"], failures: 2 });
  it("round-trips", () => {
    expect(msg.endsWith("\nMergeJudge-Actor: agent\n")).toBe(true);
    expect(msg).not.toContain("Co-Authored-By");
    expect(parseAttemptCommit("s", msg)).toEqual({ sha: "s", attempt: 2, kind: "ci", fingerprints: ["aaaa111122", "bbbb333344"], failures: 2 });
    expect(parseAttemptCommit("s", buildCommitMessage({ subject: "x", attempt: 1, kind: "conflict" }))?.kind).toBe("conflict");
    expect(isShepherdCommitMessage(msg)).toBe(true);
    expect(isShepherdCommitMessage("fix: thing")).toBe(false);
  });
  it("L1: counts Shepherd's own commits only, whatever the comment says", () => {
    const h = shepherdHistory([{ sha: "1", message: "human" }, { sha: "2", message: msg }, { sha: "3", message: "human" }, { sha: "4", message: msg }]);
    expect(h.attempts).toBe(2);
    expect(h.latest?.sha).toBe("4");
    expect(shepherdHistory([]).latest).toBeNull();
  });
});

describe("decide()", () => {
  const fp = (hash: string, tests: number | null = null): Fingerprint => ({ job: "test", hash, line: hash, raw: hash, tests });
  const rec = (sha: string, attempt: number, fingerprints: string[], failures: number | null) => ({ sha, attempt, kind: "ci" as const, fingerprints, failures });
  const hist = (...records: ReturnType<typeof rec>[]) => ({ records, attempts: records.length, latest: records[records.length - 1] ?? null });
  const base: DecideInput = {
    needsHuman: false, on: true, maxAttempts: 3, history: hist(), headSha: "H", runAttempt: 2, conclusion: "failure",
    failures: [fp("new")], cantFix: { kind: "code" }, rerunRequested: false,
  };
  const d = (o: Partial<DecideInput>) => decide({ ...base, ...o });

  it("fixes a fresh code failure and numbers the attempt from commits", () => {
    expect(d({})).toEqual({ action: "fix", attempt: 1 });
    expect(d({ history: hist(rec("a", 1, ["x"], 5)) })).toEqual({ action: "fix", attempt: 2 });
  });
  it("needs-human and off block everything", () => {
    expect(d({ needsHuman: true }).action).toBe("skip");
    expect(d({ on: false }).action).toBe("skip");
    expect(d({ needsHuman: true, conclusion: "success" }).action).toBe("skip");
  });
  it("L1: at the cap it hands off with no fix", () => {
    const h = hist(rec("a", 1, ["x"], 5), rec("b", 2, ["y"], 4), rec("c", 3, ["z"], 3));
    expect(d({ history: h })).toMatchObject({ action: "handoff", rule: RULE.L1 });
  });
  it("L2: the same fingerprint after a fix stops right away, even on a first run attempt", () => {
    expect(d({ history: hist(rec("H", 1, ["same"], 5)), failures: [fp("same")], runAttempt: 1 })).toMatchObject({ action: "handoff", rule: RULE.L2 });
  });
  it("L3: an earlier attempt's fingerprint coming back is ping-pong", () => {
    const h = hist(rec("a", 1, ["A"], 2), rec("H", 2, ["B"], 1));
    expect(d({ history: h, failures: [fp("A")] })).toMatchObject({ action: "handoff", rule: RULE.L3 });
  });
  it("L2/L3 only judge a failure on Shepherd's own fix commit", () => {
    expect(d({ history: hist(rec("other", 1, ["same"], 5)), failures: [fp("same")] }).action).toBe("fix");
  });
  it("L4: equal or more failures than before the fix stops; strictly fewer continues", () => {
    const h = (n: number) => hist(rec("H", 1, ["old"], n));
    expect(d({ history: h(1), failures: [fp("new")] })).toMatchObject({ action: "handoff", rule: RULE.L4 });
    expect(d({ history: h(1), failures: [fp("n1"), fp("n2")] })).toMatchObject({ action: "handoff", rule: RULE.L4 });
    expect(d({ history: h(2), failures: [fp("new")] }).action).toBe("fix");
    expect(d({ history: h(4), failures: [fp("new", 2)] }).action).toBe("fix");
    expect(d({ history: h(3), failures: [fp("new", 2)] })).toMatchObject({ rule: RULE.L4 });
  });
  it("L1: grants raise the cap by exactly their number", () => {
    const h = hist(rec("a", 1, ["x"], 5), rec("b", 2, ["y"], 4), rec("c", 3, ["z"], 3));
    expect(d({ history: h, grants: 1 })).toEqual({ action: "fix", attempt: 4 });
    expect(d({ history: hist(...h.records, rec("d", 4, ["w"], 2)), grants: 1 })).toMatchObject({ action: "handoff", rule: RULE.L1, reason: expect.stringContaining("4/4") });
    expect(d({ history: h, grants: 0 })).toMatchObject({ rule: RULE.L1 });
  });
  it("H3: cant-fix hands off before any attempt", () => {
    expect(d({ cantFix: { kind: "cant-fix", reason: "missing secret", rule: RULE.H3 } })).toMatchObject({ action: "handoff", rule: RULE.H3 });
    expect(d({ cantFix: { kind: "cant-fix", reason: "workflow file", rule: RULE.H1 } })).toMatchObject({ rule: RULE.H1 });
  });
  it("H3 flaky: first failure re-runs; a pass on re-run hands off with the flaky reason", () => {
    expect(d({ runAttempt: 1 })).toMatchObject({ action: "rerun" });
    expect(d({ runAttempt: 1, rerunRequested: true }).action).toBe("fix");
    const pass = d({ conclusion: "success", runAttempt: 2, rerunRequested: true, failures: [] });
    expect(pass).toMatchObject({ action: "handoff", rule: RULE.H3 });
    expect(pass.action === "handoff" && pass.reason).toContain("flaky test (passed on rerun with no change)");
    expect(d({ conclusion: "success", runAttempt: 1, failures: [] }).action).toBe("green");
    expect(d({ conclusion: "success", runAttempt: 2, failures: [] }).action).toBe("green");
  });
  it("a known fingerprint is not re-run as flaky", () => {
    expect(d({ runAttempt: 1, history: hist(rec("old", 1, ["new"], 3)) }).action).toBe("fix");
  });
});

describe("isGreen", () => {
  const runs = (...c: [string, string, string | null][]) => c.map(([name, status, conclusion]) => ({ name, status, conclusion }));
  it("needs every check done and passing and the lane check not failing", () => {
    expect(isGreen(runs(["ci", "completed", "success"], ["mergejudge/lane", "completed", "neutral"]), "mergejudge/lane")).toBe(true);
    expect(isGreen(runs(["ci", "completed", "success"], ["mergejudge/lane", "completed", "failure"]), "mergejudge/lane")).toBe(false);
    expect(isGreen(runs(["ci", "in_progress", null]), "mergejudge/lane")).toBe(false);
    expect(isGreen(runs(["ci", "completed", "failure"]), "mergejudge/lane")).toBe(false);
    expect(isGreen([], "mergejudge/lane")).toBe(false);
  });
});

describe("conflict hunk classifier", () => {
  const file = (ours: string, theirs: string, base?: string) =>
    `top\n<<<<<<< HEAD\n${ours}${base != null ? `||||||| base\n${base}` : ""}=======\n${theirs}>>>>>>> origin/main\nbottom\n`;
  it("unions distinct import lines, deduplicated, ours first", () => {
    const v = classifyConflictFile("src/a.ts", file("import a from \"a\";\nimport c from \"c\";\n", "import a from \"a\";\nimport b from \"b\";\n"));
    expect(v).toEqual({ kind: "resolved", hunks: 1, text: "top\nimport a from \"a\";\nimport c from \"c\";\nimport b from \"b\";\nbottom\n" });
  });
  it("honours a line one side removed when the base is known", () => {
    const v = classifyConflictFile("a.py", file("import os\nimport sys\n", "import os\nimport json\nimport sys\n", "import os\nimport re\nimport sys\n"));
    expect(v).toMatchObject({ kind: "resolved", text: "top\nimport os\nimport sys\nimport json\nbottom\n" });
  });
  it("handles require and rust use lines", () => {
    expect(mergeImportHunk(["const a = require(\"a\");"], ["const b = require('b');"], null)).toEqual(["const a = require(\"a\");", "const b = require('b');"]);
    expect(mergeImportHunk(["use std::io;"], ["use std::fs;"], null)).toHaveLength(2);
  });
  it("H4: both sides changing the same logic is not resolved and lists the hunk", () => {
    const v = classifyConflictFile("src/a.ts", file("return a + 1;\n", "return a + 2;\n"));
    expect(v).toMatchObject({ kind: "logic", hunks: [{ line: 2, ours: "return a + 1;", theirs: "return a + 2;" }] });
  });
  it("one logic hunk among import hunks still needs a human", () => {
    const two = `<<<<<<< HEAD\nimport a from "a";\n=======\nimport b from "b";\n>>>>>>> x\nmid\n<<<<<<< HEAD\nx = 1\n=======\nx = 2\n>>>>>>> x\n`;
    expect(classifyConflictFile("a.ts", two)).toMatchObject({ kind: "logic", hunks: [{ index: 1 }] });
  });
  it("a multi-line import or a malformed or hunk-less file is logic", () => {
    expect(mergeImportHunk(["import {"], ["import b from 'b';"], null)).toBeNull();
    expect(classifyConflictFile("a.ts", "<<<<<<< HEAD\nx\n").kind).toBe("logic");
    expect(classifyConflictFile("a.ts", "no markers (deleted on one side)\n").kind).toBe("logic");
  });
  it("lockfiles are recognised; go.sum is a sorted union", () => {
    for (const f of ["package-lock.json", "a/yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "go.sum"]) expect(isLockfile(f)).toBe(true);
    expect(isLockfile("package.json")).toBe(false);
    expect(classifyConflictFile("package-lock.json", "<<<<<<< HEAD\n=======\n>>>>>>> x\n")).toEqual({ kind: "lockfile" });
    expect(unionLines("b 1\na 1\n", "a 1\nc 1\n")).toBe("a 1\nb 1\nc 1\n");
  });
  it("parseConflicts reads diff3 markers", () => {
    const segs = parseConflicts(file("o\n", "t\n", "b\n"))!;
    expect(segs.find((s) => s.type === "conflict")).toMatchObject({ ours: ["o"], theirs: ["t"], base: ["b"] });
  });
});

describe("model reply protocol", () => {
  it("parses files JSON, fenced JSON, cannot_fix and CANNOT_FIX text", () => {
    expect(parseFixReply('{"files":[{"path":"a.ts","content":"x"}],"explanation":"e"}')).toEqual({ files: [{ path: "a.ts", content: "x" }], explanation: "e" });
    expect(parseFixReply('```json\n{"files":[{"path":"a.ts","content":"x"}]}\n```')).toMatchObject({ files: [{ path: "a.ts" }] });
    expect(parseFixReply('{"cannot_fix":"design question"}')).toEqual({ cannotFix: "design question" });
    expect(parseFixReply("CANNOT_FIX: needs product decision")).toEqual({ cannotFix: "needs product decision" });
    expect(parseFixReply("nope")).toHaveProperty("invalid");
    expect(parseFixReply('{"files":[]}')).toHaveProperty("invalid");
  });
});

describe("hand-off comment", () => {
  const html = (o: Partial<Parameters<typeof renderHandoff>[0]> = {}) => renderHandoff({
    rule: RULE.L3, reason: "the fix brought back an earlier failure", question: RULE_QUESTION.L3, repoUrl: "https://github.com/o/r",
    attempts: [{ sha: "a".repeat(40), attempt: 1, kind: "ci", fingerprints: [], failures: 2, run: "https://github.com/o/r/actions/runs/9" }], ...o,
  });
  it("names the rule, the attempts with links, and the one decision", () => {
    const t = html({ failures: [{ job: "test", hash: "abc", raw: "AssertionError: nope" }], paths: ["src/a.ts"] });
    expect(t).toContain(HANDOFF_MARKER);
    expect(t).toContain("Loop breaker L3: ping-pong");
    expect(t).toContain("https://github.com/o/r/commit/" + "a".repeat(40));
    expect(t).toContain("https://github.com/o/r/actions/runs/9");
    expect(t).toContain("**The one decision needed from you:**");
    expect(t).toContain("`src/a.ts`");
    expect(t).not.toMatch(/[—–→]/);
  });
  it("says nothing was pushed when there are no attempts, and redacts secrets", () => {
    const t = html({ attempts: [], failures: [{ job: "j", hash: "h", raw: "token ghp_" + "a".repeat(30) }] });
    expect(t).toContain("Nothing was pushed.");
    expect(t).not.toContain("ghp_" + "a".repeat(30));
  });
});

describe("L5 review guard", () => {
  const shepherdMsg = buildCommitMessage({ subject: "s", attempt: 1, kind: "ci", fingerprints: ["aaaaaa"] });
  const f = (path: string) => ({ path, line: 3, message: "m" });
  it("a normal head is reviewed as usual", () => {
    expect(reviewGuard("fix: x", ["a.ts"], [f("a.ts")])).toEqual({ suggestions: true, syncInline: true, pingPong: [] });
    expect(reviewGuard(null, [], [])).toMatchObject({ suggestions: true });
  });
  it("a Shepherd head gets no suggestions and no new inline findings", () => {
    expect(reviewGuard(shepherdMsg, ["a.ts"], [])).toEqual({ suggestions: false, syncInline: false, pingPong: [] });
  });
  it("L3: findings on files the Shepherd commit touched are ping-pong", () => {
    expect(reviewGuard(shepherdMsg, ["a.ts"], [f("a.ts"), f("b.ts")]).pingPong).toEqual([f("a.ts")]);
  });
});

describe("auto routing", () => {
  const c = (body: string, extra = {}) => ({ comment: { body, user: { type: "User" } }, issue: { pull_request: {} }, ...extra });
  it("sends Shepherd commands on PRs to shepherd, other comments to feedback", () => {
    expect(routeAutoMode("issue_comment", c("/mergejudge shepherd"))).toBe("shepherd");
    expect(routeAutoMode("issue_comment", c("/mergejudge shepherd off"))).toBe("shepherd");
    expect(routeAutoMode("issue_comment", c("lgtm"))).toBe("feedback");
    expect(routeAutoMode("issue_comment", { comment: { body: "/mergejudge shepherd" }, issue: {} })).toBe("feedback");
    expect(routeAutoMode("issue_comment", { comment: { body: "/mergejudge shepherd", user: { type: "Bot" } }, issue: { pull_request: {} } })).toBe("feedback");
    expect(routeAutoMode("issue_comment", c("<!-- mergejudge:shepherd-handoff -->\n/mergejudge shepherd"))).toBe("feedback");
  });
  it("labels, workflow_run and check_suite go to shepherd; the rest keeps its route", () => {
    expect(routeAutoMode("push", {})).toBe("shepherd");
    expect(routeAutoMode("schedule", {})).toBe("propose");
    expect(routeAutoMode("pull_request", { action: "labeled", label: { name: "Shepherd" } })).toBe("shepherd");
    expect(routeAutoMode("pull_request", { action: "unlabeled", label: { name: "needs-human" } })).toBe("shepherd");
    expect(routeAutoMode("pull_request", { action: "labeled", label: { name: "bug" } })).toBe("triage");
    expect(routeAutoMode("pull_request", { action: "synchronize" })).toBe("triage");
    expect(routeAutoMode("workflow_run", {})).toBe("shepherd");
    expect(routeAutoMode("check_suite", {})).toBe("shepherd");
    expect(routeAutoMode("status", {})).toBe("shepherd");
    expect(routeAutoMode("schedule", {})).toBe("propose");
    expect(routeAutoMode("workflow_dispatch", {})).toBe("propose");
  });
});

describe("config and files", () => {
  it("size caps default to 50 lines and 3 files and validate", () => {
    expect(cfg.shepherd.max_fix_lines).toBe(50);
    expect(cfg.shepherd.max_fix_files).toBe(3);
    expect(parseConfig("shepherd:\n  max_fix_lines: 10\n  max_fix_files: 1\n").shepherd).toMatchObject({ max_fix_lines: 10, max_fix_files: 1 });
    expect(() => parseConfig("shepherd:\n  max_fix_lines: 0\n")).toThrow();
  });
  it("action.yml has the shepherd inputs", () => {
    const m = parse(readFileSync(join(root, "action.yml"), "utf8")) as { inputs: Record<string, unknown> };
    for (const k of ["shepherd_fix_command", "shepherd_commit_name", "shepherd_commit_email"]) expect(m.inputs).toHaveProperty(k);
  });
  it("the example workflow is valid, lives outside .github/ and has the needed triggers and permissions", () => {
    const y = parse(readFileSync(join(root, "examples/shepherd-workflow.yml"), "utf8")) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { if?: string }> };
    expect(Object.keys(y.on)).toEqual(expect.arrayContaining(["issue_comment", "pull_request", "workflow_run"]));
    expect(y.permissions).toMatchObject({ contents: "write", "pull-requests": "write", checks: "read" });
    expect(JSON.stringify(y.jobs)).toContain("head.repo.full_name");
  });
  it("README and CHANGELOG avoid em dashes, en dashes and arrows in the Shepherd text", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const sec = readme.slice(readme.indexOf("## Shepherd (Watch and auto-fix)"), readme.indexOf("## Quiet by default"));
    expect(sec).not.toMatch(/[—–→]/);
    expect(sec).toContain("max_fix_lines");
    const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const unreleased = log.slice(log.indexOf("## 0.8.0"), log.indexOf("## 0.6.1"));
    expect(unreleased).not.toMatch(/[—–→]/);
    expect(unreleased).toContain("tier 2");
  });
});
