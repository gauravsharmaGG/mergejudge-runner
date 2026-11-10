/**
 * Does the failing test actually run the finding's line? A test that fails on head because of some other bug in the same
 * file proves nothing about this finding, so a proof only counts when the head run executed the line the finding is about.
 *  - JavaScript: V8 block coverage (`NODE_V8_COVERAGE`), every non-blank character of the line must sit in an executed range.
 *  - Python: a line tracer (`sys.settrace`) around the test; a `def` line counts as executed only when its body ran.
 * Both fail closed: no coverage data means "not executed".
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Language } from "./filter.js";

export interface FindingTarget { path: string; line: number }

export const COVERAGE_DIR = "cov";
export const TRACE_FILE = "trace.json";
export const TRACE_HARNESS_FILE = "_trace.py";

export const PY_TRACE_HARNESS = `import ast, json, os, runpy, sys, threading
ROOT = os.path.realpath(os.getcwd())
SCRATCH = os.path.join(ROOT, ".mj-proof")
TARGET = os.environ.get("MJ_PROOF_TARGET", "")
events = set()

def local(frame, event, arg):
    if event == "line":
        events.add((frame.f_code.co_filename, frame.f_lineno))
    return local

def tracer(frame, event, arg):
    fn = os.path.realpath(frame.f_code.co_filename)
    if fn.startswith(ROOT + os.sep) and not fn.startswith(SCRATCH + os.sep):
        return local
    return None

def executed():
    path, _, line = TARGET.rpartition(":")
    line = int(line)
    full = os.path.realpath(os.path.join(ROOT, path))
    lines = {l for (f, l) in events if os.path.realpath(f) == full}
    with open(full, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    best = None
    for n in ast.walk(tree):
        if isinstance(n, ast.stmt) and n.lineno <= line <= (n.end_lineno or n.lineno):
            if best is None or (n.end_lineno - n.lineno) <= (best.end_lineno - best.lineno):
                best = n
    if best is None:
        return line in lines
    if isinstance(best, (ast.FunctionDef, ast.AsyncFunctionDef)) and line == best.lineno:
        return any(best.lineno < l <= best.end_lineno for l in lines)
    return best.lineno in lines or line in lines

def finish():
    sys.settrace(None)
    threading.settrace(None)
    try:
        ok = bool(executed())
    except Exception:
        ok = False
    with open(os.path.join(SCRATCH, "trace.json"), "w") as out:
        json.dump({"executed": ok}, out)

target = sys.argv[1]
sys.argv = [target]
sys.settrace(tracer)
threading.settrace(tracer)
try:
    runpy.run_path(target, run_name="__main__")
finally:
    finish()
`;

/** Environment (with the `$SCRATCH` token) that makes the run record what it executed. */
export function traceEnv(language: Language, t: FindingTarget): Record<string, string> {
  return language === "javascript" ? { NODE_V8_COVERAGE: `$SCRATCH/${COVERAGE_DIR}` } : { MJ_PROOF_TARGET: `${t.path}:${t.line}` };
}

/** Clears what an earlier run left, so only the run being checked counts. */
export function resetTrace(scratch: string): void {
  rmSync(join(scratch, COVERAGE_DIR), { recursive: true, force: true });
  rmSync(join(scratch, TRACE_FILE), { force: true });
  mkdirSync(join(scratch, COVERAGE_DIR), { recursive: true });
}

interface V8Range { startOffset: number; endOffset: number; count: number }

/** Is every non-blank character of `line` (1-based) in a range V8 counted as executed? Exported for tests. */
export function lineCovered(source: string, line: number, ranges: V8Range[]): boolean {
  const rows = source.split("\n");
  if (line < 1 || line > rows.length) return false;
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += rows[i]!.length + 1;
  const text = rows[line - 1]!.slice(0, 400);
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) continue;
    const off = start + i;
    let best: V8Range | null = null;
    for (const r of ranges) {
      if (r.startOffset <= off && off < r.endOffset && (!best || r.endOffset - r.startOffset <= best.endOffset - best.startOffset)) best = r;
    }
    if (!best || best.count <= 0) return false;
    seen++;
  }
  return seen > 0;
}

function jsExecuted(root: string, mount: string, t: FindingTarget): boolean {
  const dir = join(root, ".mj-proof", COVERAGE_DIR);
  if (!existsSync(dir)) return false;
  let source: string;
  try { source = readFileSync(join(root, t.path), "utf8"); } catch { return false; }
  const want = `${mount}/${t.path}`;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let doc: { result?: { url?: string; functions?: { ranges?: V8Range[] }[] }[] };
    try { doc = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    for (const script of doc.result ?? []) {
      if (!script.url?.startsWith("file://")) continue;
      let p: string;
      try { p = fileURLToPath(script.url); } catch { continue; }
      if (p !== want) continue;
      if (lineCovered(source, t.line, (script.functions ?? []).flatMap((fn) => fn.ranges ?? []))) return true;
    }
  }
  return false;
}

function pyExecuted(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, ".mj-proof", TRACE_FILE), "utf8")).executed === true; } catch { return false; }
}

/** After a traced run in `root` (seen as `mount` inside the sandbox): did it execute the finding's line? */
export function targetExecuted(language: Language, root: string, mount: string, t: FindingTarget): boolean {
  return language === "javascript" ? jsExecuted(root, mount, t) : pyExecuted(root);
}
