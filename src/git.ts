/** Thin git wrapper for the local-code path. Never prompts (GIT_TERMINAL_PROMPT=0), never puts a credential on argv. */
import { spawn } from "node:child_process";
import { redact } from "./redact.js";

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) { super(message); }
}

export interface GitOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  input?: string;
  /** Output cap in bytes (default 64 MB). */
  maxBytes?: number;
  /** Do not throw on a non-zero exit. */
  allowFail?: boolean;
}

/** Hide user:password@ in anything shown to a human or logged. */
export const scrubUrl = (s: string): string => s.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");

/**
 * Git stderr is kept on GitError for local classification (auth failure vs missing commit) after URL and
 * secret scrubbing. It is not part of the Error message: filter output, diff drivers and remote sideband
 * text can contain file contents, so the message that gets logged or nacked is only the subcommand and exit code.
 */

export function runGit(args: string[], o: GitOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...o.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } as Record<string, string>;
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], { cwd: o.cwd, env, stdio: ["pipe", "pipe", "pipe"], signal: o.signal });
    const out: Buffer[] = [], err: Buffer[] = [];
    let size = 0, over = false;
    const max = o.maxBytes ?? 64 * 1024 * 1024;
    child.stdout.on("data", (d: Buffer) => { size += d.length; if (size > max) { over = true; child.kill("SIGKILL"); } else out.push(d); });
    child.stderr.on("data", (d: Buffer) => { if (err.reduce((n, b) => n + b.length, 0) < 64_000) err.push(d); });
    child.on("error", (e) => reject(new GitError(`could not run git: ${(e as Error).message}`, null, "")));
    child.on("close", (code) => {
      const stderr = redact(scrubUrl(Buffer.concat(err).toString("utf8")));
      const sub = args[0] ?? "command";
      if (over) return reject(new GitError(`git ${sub} output exceeded ${max} bytes`, code, stderr));
      const res = { code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr };
      if (res.code !== 0 && !o.allowFail) return reject(new GitError(`git ${sub} failed (${res.code})`, res.code, stderr));
      resolve(res);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}

/** Splits `git diff -U3` output into per-path patches in the GitHub format (starting at the first hunk). Binary files get none. */
export function splitPatches(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of diff.split(/^diff --git /m).slice(1)) {
    const hunk = chunk.indexOf("\n@@ ");
    if (hunk < 0) continue;
    const header = chunk.slice(0, hunk);
    const to = /^\+\+\+ b\/(.+)$/m.exec(header)?.[1] ?? /^rename to (.+)$/m.exec(header)?.[1];
    const from = /^--- a\/(.+)$/m.exec(header)?.[1];
    const path = to ?? from;
    if (!path) continue;
    out.set(path, chunk.slice(hunk + 1).replace(/\n$/, ""));
  }
  return out;
}
