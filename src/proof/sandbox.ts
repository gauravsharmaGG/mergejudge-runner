/**
 * Where a proof test runs. The test is model-written code that executes next to code from a pull request, on the runner
 * owner's machine, so it only runs inside a sandbox that has no network and cannot write outside its scratch directory.
 * v1 supports bubblewrap (`bwrap`, Linux). Without a working sandbox proof tests are skipped and the review is posted as usual.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";

export interface SandboxSpec {
  /** Directory holding the exported commit. Mounted read-only; the test sees it as the working directory. */
  root: string;
  /** Directory inside `root` that the test may write to (the test file lives here). */
  scratch: string;
  /** Absolute path of the interpreter. */
  bin: string;
  args: string[];
  /** Extra environment for the test process. `$SCRATCH` in a value stands for the scratch directory as the test sees it. */
  env?: Record<string, string>;
}

export interface SandboxCommand { cmd: string; args: string[]; env: Record<string, string>; cwd: string }

export interface Sandbox {
  name: string;
  command(spec: SandboxSpec): SandboxCommand;
  /** Where `root` is seen from inside the sandbox (coverage URLs and trace paths use it). */
  mountOf(root: string): string;
}

const withScratch = (env: Record<string, string> | undefined, scratch: string): [string, string][] =>
  Object.entries(env ?? {}).map(([k, v]) => [k, v.replaceAll("$SCRATCH", scratch)]);

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc"];
const underSystem = (p: string) => SYSTEM_DIRS.some((d) => p === d || p.startsWith(`${d}/`));

/** The interpreter's install prefix when it lives outside the system directories (nvm, pyenv, Homebrew): bound read-only too. */
export function interpreterPrefix(bin: string): string | null {
  let real = bin;
  try { real = realpathSync(bin); } catch { /* use as given */ }
  if (underSystem(real)) return null;
  const prefix = dirname(dirname(real));
  const home = process.env.HOME;
  // Never expose a whole home directory (or root) because a binary sits in ~/bin.
  return prefix === sep || prefix === home || (!!home && home.startsWith(`${prefix}${sep}`)) ? dirname(real) : prefix;
}

export function bwrapArgs(spec: SandboxSpec): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session"];
  for (const d of SYSTEM_DIRS) if (existsSync(d)) args.push("--ro-bind", d, d);
  const prefix = interpreterPrefix(spec.bin);
  if (prefix) args.push("--ro-bind", prefix, prefix);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push("--ro-bind", spec.root, "/work", "--bind", spec.scratch, "/work/.mj-proof");
  return args;
}

/** Network (`--unshare-all`) and filesystem (everything read-only except the scratch directory and a private /tmp) isolation. */
export function bwrapSandbox(bwrapBin = "bwrap"): Sandbox {
  return {
    name: "bubblewrap",
    mountOf: () => "/work",
    command(spec) {
      const path = [dirname(spec.bin), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
      return {
        cmd: bwrapBin,
        args: [...bwrapArgs(spec), "--chdir", "/work", "--clearenv", "--setenv", "PATH", path, "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "LANG", "C", "--setenv", "PYTHONPATH", "/work", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", ...withScratch(spec.env, "/work/.mj-proof").flatMap(([k, v]) => ["--setenv", k, v]), "--", spec.bin, ...spec.args],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        cwd: "/",
      };
    },
  };
}

/**
 * No isolation at all. Exists so unit tests can run real interpreters on machines (CI) where unprivileged namespaces are
 * disabled. It is never returned by `detectSandbox`.
 */
export function unsandboxedForTests(): Sandbox {
  return {
    name: "none (tests only)",
    mountOf: (root) => root,
    command(spec) {
      return { cmd: spec.bin, args: spec.args, env: { ...Object.fromEntries(withScratch(spec.env, spec.scratch)), PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: spec.scratch, TMPDIR: spec.scratch, PYTHONPATH: spec.root, PYTHONDONTWRITEBYTECODE: "1", LANG: "C" }, cwd: spec.root };
    },
  };
}

/** Runs `bwrap` with the real isolation flags around `true`; a machine that forbids unprivileged namespaces fails here, not in the middle of a review. */
export function detectSandbox(o: { bwrapBin?: string; platform?: string; probe?: (cmd: string, args: string[]) => Promise<boolean> } = {}): Promise<Sandbox | null> {
  if ((o.platform ?? process.platform) !== "linux") return Promise.resolve(null);
  const bin = o.bwrapBin ?? "bwrap";
  const probe = o.probe ?? defaultProbe;
  const trueBin = ["/usr/bin/true", "/bin/true"].find((p) => existsSync(p));
  if (!trueBin) return Promise.resolve(null);
  const args = ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", ...(existsSync("/lib") ? ["--ro-bind", "/lib", "/lib"] : []), ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []), ...(existsSync("/bin") ? ["--ro-bind", "/bin", "/bin"] : []), "--proc", "/proc", "--dev", "/dev", "--", trueBin];
  return probe(bin, args).then((ok) => (ok ? bwrapSandbox(bin) : null));
}

let memo: Promise<Sandbox | null> | null = null;
/** detectSandbox once per process: the answer does not change while the runner is up. */
export const detectSandboxCached = (): Promise<Sandbox | null> => (memo ??= detectSandbox());

function defaultProbe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: "ignore" }); } catch { return resolve(false); }
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(false); }, 5000);
    child.on("error", () => { clearTimeout(t); resolve(false); });
    child.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

/** Absolute path of `name` on `pathVar`, or null. */
export function findOnPath(name: string, pathVar: string | undefined = process.env.PATH): string | null {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  for (const d of (pathVar ?? "").split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}
