import { filterTestSource, type Language } from "./filter.js";
import { classify, interpreterFor, runSandboxed, snapshotTree, treeChanges, writeTest, type Verdict } from "./run.js";
import type { Sandbox } from "./sandbox.js";

export type ProofStatus = "proven" | "not-proven";
export interface ProofVerdict { status: ProofStatus; reason: string }

export interface ProveInput {
  sandbox: Sandbox;
  language: Language;
  code: string;
  baseRoot: string;
  headRoot: string;
  timeoutMs: number;
  signal?: AbortSignal;
  pathVar?: string;
}

const no = (reason: string): ProofVerdict => ({ status: "not-proven", reason });

/**
 * The classification. A finding is proven only when the generated test
 *   1. passes the static rule filter,
 *   2. PASSES on base and FAILS (assertion failure) on head,
 *   3. gives the same two verdicts on a rerun (deterministic), and
 *   4. leaves both checkouts untouched outside the scratch directory.
 * Anything else is "not-proven" and the finding posts as it always did. Never throws.
 */
export async function proveTest(i: ProveInput): Promise<ProofVerdict> {
  try {
    const f = filterTestSource(i.language, i.code);
    if (!f.ok) return no(`rule filter: ${f.reasons.join("; ")}`);
    const itp = interpreterFor(i.language, i.pathVar);
    if (!itp) return no(`no ${i.language} interpreter on this runner`);
    const before = [snapshotTree(i.baseRoot), snapshotTree(i.headRoot)];
    writeTest(i.baseRoot, itp.file, i.code);
    writeTest(i.headRoot, itp.file, i.code);
    const run = async (root: string): Promise<Verdict> => {
      const r = await runSandboxed(i.sandbox, root, itp, { timeoutMs: i.timeoutMs, signal: i.signal });
      if (r.status === "aborted") throw new Error("aborted");
      return classify(i.language, r);
    };
    const base1 = await run(i.baseRoot);
    if (base1 !== "pass") return no(`test does not pass on base (${base1})`);
    const head1 = await run(i.headRoot);
    if (head1 === "pass") return no("test passes on head too");
    if (head1 !== "fail") return no("test errored on head (not an assertion failure)");
    const base2 = await run(i.baseRoot);
    const head2 = await run(i.headRoot);
    if (base2 !== "pass" || head2 !== "fail") return no("result changed on rerun (not deterministic)");
    const touched = [...treeChanges(before[0]!, snapshotTree(i.baseRoot)), ...treeChanges(before[1]!, snapshotTree(i.headRoot))];
    if (touched.length) return no(`test wrote outside its scratch directory (${touched.slice(0, 3).join(", ")})`);
    return { status: "proven", reason: "passes on base, fails on head, same result on rerun" };
  } catch (e) {
    return no(`could not run (${(e as Error).message.slice(0, 120)})`);
  }
}
