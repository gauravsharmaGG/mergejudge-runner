/** Exporting a commit into a temp directory and running one test file against it, with a hard time limit. */
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GitSource, LOCAL_LIMITS } from "../localcode.js";
import { runGit } from "../git.js";
import type { Language } from "./filter.js";
import { PY_TRACE_HARNESS, TRACE_HARNESS_FILE } from "./exercise.js";
import { findOnPath, type Sandbox } from "./sandbox.js";

export const SCRATCH = ".mj-proof";
export const MAX_TREE_FILES = 20_000;
const MAX_OUTPUT = 200_000;

export class ProofRunError extends Error {}

/** The commit's files in `dest` (a plain directory, no .git, nothing in the clone's own state changes). Blobs the partial clone lacks are fetched in one batch first. */
export async function exportTree(gitDir: string, sha: string, dest: string, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new ProofRunError("invalid commit id");
  const src = new GitSource(gitDir, sha, env, LOCAL_LIMITS, signal);
  try {
    const paths = await src.listPaths();
    if (paths.length > MAX_TREE_FILES) throw new ProofRunError(`checkout has ${paths.length} files (limit ${MAX_TREE_FILES})`);
    await src.prefetch(paths);
  } finally { src.close(); }
  mkdirSync(dest, { recursive: true });
  const index = `${dest}.index`;
  const e = { ...env, GIT_INDEX_FILE: index };
  await runGit(["--git-dir", gitDir, "read-tree", sha], { env: e, signal });
  await runGit(["--git-dir", gitDir, "--work-tree", dest, "checkout-index", "-a", "-f"], { env: e, signal });
}

export interface Interpreter { bin: string; args: string[]; file: string }

/** The interpreter and the test file name for a language, or null when it is not installed. Node always uses the runner's own binary. */
export function interpreterFor(language: Language, pathVar?: string, traced = false): Interpreter | null {
  if (language === "javascript") return { bin: process.execPath, args: ["--test", `${SCRATCH}/proof.test.mjs`], file: "proof.test.mjs" };
  const py = findOnPath("python3", pathVar);
  if (!py) return null;
  return { bin: py, args: traced ? [`${SCRATCH}/${TRACE_HARNESS_FILE}`, `${SCRATCH}/proof_test.py`] : [`${SCRATCH}/proof_test.py`], file: "proof_test.py" };
}

export function writeTest(root: string, file: string, code: string): void {
  const dir = join(root, SCRATCH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), code);
  if (file.endsWith(".py")) writeFileSync(join(dir, TRACE_HARNESS_FILE), PY_TRACE_HARNESS);
}

export type RunStatus = "exit" | "timeout" | "spawn-error" | "aborted";
export interface RunResult { status: RunStatus; code: number | null; output: string }

export function runSandboxed(sb: Sandbox, root: string, itp: Interpreter, o: { timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<RunResult> {
  const c = sb.command({ root, scratch: join(root, SCRATCH), bin: itp.bin, args: itp.args, ...(o.env ? { env: o.env } : {}) });
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ status: "aborted", code: null, output: "" });
    let out = "";
    let done = false;
    let child: ReturnType<typeof spawn>;
    const finish = (r: RunResult) => { if (done) return; done = true; clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); resolve(r); };
    const kill = () => { const pid = child?.pid; if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const onAbort = () => { kill(); finish({ status: "aborted", code: null, output: out }); };
    const timer = setTimeout(() => { kill(); finish({ status: "timeout", code: null, output: out }); }, o.timeoutMs);
    try {
      child = spawn(c.cmd, c.args, { cwd: c.cwd, env: c.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch { return finish({ status: "spawn-error", code: null, output: "" }); }
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const take = (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString("utf8"); };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    child.on("error", () => finish({ status: "spawn-error", code: null, output: out }));
    // "close" waits for the pipes, so a grandchild that outlives the test is still bounded by the timer (the group is killed).
    child.on("close", (code) => { kill(); finish({ status: "exit", code, output: out }); });
  });
}

export type Verdict = "pass" | "fail" | "error";

const JS_BROKEN = /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|ERR_PACKAGE_PATH|ERR_INVALID_MODULE|ReferenceError/;
const PY_BROKEN = /ModuleNotFoundError|ImportError|SyntaxError|IndentationError|NameError/;

/**
 * pass = exit 0. fail = a real assertion failure (not a crash, not an import or syntax error, not a timeout): only that
 * counts as the PR breaking something. Everything else is "error": the test could not tell us anything.
 */
export function classify(language: Language, r: RunResult): Verdict {
  if (r.status !== "exit") return "error";
  if (r.code === 0) return "pass";
  const o = r.output;
  if (language === "javascript") return /ERR_ASSERTION|AssertionError/.test(o) && !JS_BROKEN.test(o) ? "fail" : "error";
  return /^FAIL: /m.test(o) && !/^ERROR: /m.test(o) && !PY_BROKEN.test(o) ? "fail" : "error";
}

/** path -> "size:mtime:mode" for every entry under `root` except the scratch directory. */
export function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relative(root, p);
      if (rel === SCRATCH) continue;
      const st = lstatSync(p);
      out.set(rel, `${st.size}:${st.mtimeMs}:${st.mode}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

export function treeChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [k, v] of after) if (before.get(k) !== v) changed.push(k);
  for (const k of before.keys()) if (!after.has(k)) changed.push(k);
  return changed.sort();
}
