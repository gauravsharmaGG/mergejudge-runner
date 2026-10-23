/**
 * Engines, each a plain completion backend for the shared MergeJudge prompt/parse code (src/triage.ts):
 *  - `claude-code`: the official `claude -p` CLI on the user's own subscription login.
 *  - `codex`: `codex exec` (read-only sandbox) on the user's own ChatGPT login.
 *  - `glm`: the same `claude -p` pointed at z.ai's Anthropic-compatible endpoint with an API key (billing: api-key).
 * The prompt goes in on stdin, never argv. The child gets a minimal allowlist copy of the environment, an empty temp
 * cwd and no tools / a read-only sandbox: PR content is untrusted and must not drive a tool. API keys never reach
 * argv and are set only in the child's env, only for the engine that needs them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineLabel, ENGINE_BILLING, MODEL_RE, type Billing } from "../core/engines.js";
import type { LlmProvider, LlmRequest } from "../core/llm/provider.js";
import type { ReviewStyle } from "../core/single.js";

export type EngineErrorKind = "timeout" | "cancelled" | "shutdown" | "spawn" | "exit" | "malformed" | "is_error";
export class EngineError extends Error {
  constructor(readonly kind: EngineErrorKind, message: string) { super(message); }
}

/** Why a job's AbortController fired; carried as the abort reason. */
export class JobAbort extends Error {
  constructor(readonly kind: "timeout" | "cancelled" | "shutdown", message?: string) { super(message ?? kind); }
}

export type EngineId = "claude-code" | "codex" | "glm";
export const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

const ENV_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
  "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ComSpec", "PATHEXT",
];
/** Login locations, per engine: only the one the engine needs is passed. */
const ENV_ENGINE: Record<EngineId, string[]> = {
  "claude-code": ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"], // the user's own subscription login (`claude setup-token`)
  codex: ["CODEX_HOME"], // where `codex login` keeps the ChatGPT login
  glm: ["CLAUDE_CONFIG_DIR"], // never the subscription token: this engine talks to z.ai, not Anthropic
};
/** Never passed, even if somebody adds it to the allowlist later. */
const ENV_DENY = /^(ANTHROPIC_|MERGEJUDGE_|OPENAI_|CODEX_API|ZAI_|AWS_|GITHUB_|GH_|CLAUDE_CODE_USE_)|(_API_KEY|_AUTH_TOKEN|_SECRET)$/;
const ENV_OWN_LOGIN = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Child environment for one engine. Subscription engines bill the user's login, never an API key, so the key
 * variables are removed on top of the allowlist/denylist. glm is the one case that gets a key, and only
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL in the child (the runner's own process env is never touched).
 */
export function engineEnv(src: Record<string, string | undefined> = process.env, engine: EngineId = "claude-code", glmKey?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...ENV_ALLOW, ...ENV_ENGINE[engine]]) {
    const v = src[k];
    if (v !== undefined && !(ENV_DENY.test(k) && !ENV_OWN_LOGIN.has(k))) out[k] = v;
  }
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY", "ZAI_API_KEY"]) delete out[k];
  if (engine === "glm") {
    if (!glmKey) throw new EngineError("spawn", "glm engine needs a z.ai API key (runner config or ZAI_API_KEY)");
    out.ANTHROPIC_AUTH_TOKEN = glmKey;
    out.ANTHROPIC_BASE_URL = ZAI_BASE_URL;
  }
  return out;
}

const safeModel = (model?: string | null): string | null => {
  if (!model) return null;
  if (!MODEL_RE.test(model)) throw new EngineError("spawn", "model name has unsupported characters");
  return model;
};

/** Codex reasoning effort (`-c model_reasoning_effort=...`). Lower = faster reviews; the CLI's own default is slow for this one-shot JSON task. */
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const DEFAULT_CODEX_EFFORT = "low";
export const isCodexEffort = (s: string): boolean => (CODEX_EFFORTS as readonly string[]).includes(s);
const safeEffort = (e: string): string => {
  if (!isCodexEffort(e)) throw new EngineError("spawn", `unsupported codex reasoning effort (use ${CODEX_EFFORTS.join(", ")})`);
  return e;
};

/** Claude Code reasoning effort (`--effort <level>`). Absent = no flag (the CLI's own default). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const isClaudeEffort = (s: string): boolean => (CLAUDE_EFFORTS as readonly string[]).includes(s);

export function claudeArgs(model?: string | null, effort?: string | null): string[] {
  const m = safeModel(model);
  if (effort && !isClaudeEffort(effort)) throw new EngineError("spawn", `unsupported claude reasoning effort (use ${CLAUDE_EFFORTS.join(", ")})`);
  return [
    "-p", "--output-format", "json", "--no-session-persistence", "--disable-slash-commands",
    ...(m ? ["--model", m] : []),
    ...(effort ? ["--effort", effort] : []),
    "--tools", "", // no tools at all: the model only answers with JSON
  ];
}

/** `codex exec` (codex-cli 0.162): prompt on stdin (`-`), read-only sandbox, no session files, final message to a file, answer shape pinned by a JSON schema. */
export function codexArgs(o: { model?: string | null; effort?: string | null; schemaFile: string; outFile: string }): string[] {
  const m = safeModel(o.model);
  const e = o.effort ? safeEffort(o.effort) : null;
  return [
    "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--ignore-user-config",
    ...(m ? ["-m", m] : []),
    ...(e ? ["-c", `model_reasoning_effort=${e}`] : []),
    "--output-schema", o.schemaFile, "-o", o.outFile, "-",
  ];
}

/** Strict JSON Schema (every property required, no extras) for Codex structured output; mirrors triageOutputSchema in src/triage.ts. */
export const CODEX_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "files", "rubric"],
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["path", "lane", "reason", "findings"],
        properties: {
          path: { type: "string" }, lane: { type: "string", enum: ["auto", "review", "block"] }, reason: { type: "string" },
          findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["line", "message"], properties: { line: { type: "integer" }, message: { type: "string" } } } },
        },
      },
    },
    rubric: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "result", "justification", "evidence"],
        properties: {
          id: { type: "string" }, result: { anyOf: [{ type: "string", enum: ["pass", "fail", "n/a"] }, { type: "integer" }] }, justification: { type: "string" },
          evidence: { type: "object", additionalProperties: false, required: ["path", "line", "quote"], properties: { path: { type: "string" }, line: { type: "integer" }, quote: { type: "string" } } },
        },
      },
    },
  },
} as const;

/**
 * Codex schema for the experimental `review.style: single` (mirrors singleOutputSchema in core/single.ts): lanes per file,
 * top-level findings with path, line, quote and severity.
 */
export const CODEX_SINGLE_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "files", "findings", "rubric"],
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["path", "lane", "reason"],
        properties: { path: { type: "string" }, lane: { type: "string", enum: ["auto", "review", "block"] }, reason: { type: "string" } },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["path", "line", "quote", "severity", "message"],
        properties: { path: { type: "string" }, line: { type: "integer" }, quote: { type: "string" }, severity: { type: "string", enum: ["high", "medium", "low"] }, message: { type: "string" } },
      },
    },
    rubric: CODEX_OUTPUT_SCHEMA.properties.rubric,
  },
} as const;

/** The strict output schema for a review style. */
export const codexSchemaFor = (style?: ReviewStyle | null): typeof CODEX_OUTPUT_SCHEMA | typeof CODEX_SINGLE_OUTPUT_SCHEMA =>
  style === "single" ? CODEX_SINGLE_OUTPUT_SCHEMA : CODEX_OUTPUT_SCHEMA;

export interface EngineOptions {
  bin?: string;
  model?: string | null;
  /** codex: reasoning effort (default DEFAULT_CODEX_EFFORT). claude-code: `--effort` level (absent = no flag). Ignored for glm. */
  effort?: string | null;
  /** Review style (experimental `single`): picks the codex output schema. Absent = triage. */
  style?: ReviewStyle | null;
  /** Environment to copy the allowlist from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Wait between SIGTERM and SIGKILL of the process group. */
  killGraceMs?: number;
  /** glm only: the z.ai API key. */
  apiKey?: string;
}
export type ClaudeOptions = EngineOptions;

function killTree(child: ChildProcess, sig: NodeJS.Signals) {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, sig);
  } catch { try { child.kill(sig); } catch { /* already gone */ } }
}
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

const MAX_STDOUT = 8 * 1024 * 1024;

/** Extracts the answer text from `claude -p --output-format json` (an object, or an array of events ending in a result). */
export function parseClaudeEnvelope(stdout: string): { text: string; inputTokens?: number; outputTokens?: number } {
  let v: unknown;
  try { v = JSON.parse(stdout); } catch { throw new EngineError("malformed", "engine output was not JSON"); }
  const ev = Array.isArray(v) ? [...v].reverse().find((x) => x && typeof x === "object" && (x as { type?: unknown }).type === "result") : v;
  if (!ev || typeof ev !== "object") throw new EngineError("malformed", "engine output had no result");
  const r = ev as { is_error?: unknown; subtype?: unknown; result?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  if (r.is_error === true || (typeof r.subtype === "string" && r.subtype !== "success")) throw new EngineError("is_error", `engine reported an error (${typeof r.subtype === "string" ? r.subtype : "is_error"})`);
  if (typeof r.result !== "string" || !r.result.trim()) throw new EngineError("malformed", "engine result was empty");
  return { text: r.result, inputTokens: r.usage?.input_tokens, outputTokens: r.usage?.output_tokens };
}

/**
 * The last message `codex exec -o` wrote. With --output-schema it is one JSON object; Codex's strict schema forces
 * empty `evidence` objects on rubric items without evidence, which are dropped here so the shared parser sees "no evidence".
 */
export function parseCodexLastMessage(text: string): string {
  const t = text.trim();
  if (!t) throw new EngineError("malformed", "engine result was empty");
  let v: unknown;
  try { v = JSON.parse(t); } catch { return t; } // not pure JSON: the shared parser extracts / the repair retry handles it
  const rubric = (v as { rubric?: unknown } | null)?.rubric;
  if (Array.isArray(rubric)) {
    for (const item of rubric) {
      const ev = (item as { evidence?: { path?: unknown; line?: unknown } } | null)?.evidence;
      if (ev && typeof ev === "object" && !ev.path) delete (item as { evidence?: unknown }).evidence;
      else if (ev && ev.line === 0) delete (ev as { line?: unknown }).line;
    }
    return JSON.stringify(v);
  }
  return t;
}

function abortReason(signal: AbortSignal): EngineError {
  const r = signal.reason;
  return r instanceof JobAbort ? new EngineError(r.kind, r.message) : new EngineError("cancelled", "cancelled");
}

interface SpawnSpec { bin: string; args: string[]; env: Record<string, string>; cwd: string; stdin: string; signal: AbortSignal; killGraceMs?: number }

/** Spawns a CLI in its own process group and resolves with stdout on exit 0. Abort (timeout / cancel / shutdown) kills the whole group. stderr is counted, never logged. */
function spawnCli(sp: SpawnSpec): Promise<string> {
  const { signal } = sp;
  const abortError = () => abortReason(signal);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<string>((resolve, reject) => {
    const child = spawn(sp.bin, sp.args, {
      cwd: sp.cwd, env: sp.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    });
    let out = "", errBytes = 0, settled = false, aborted = false;
    const finish = (f: () => void) => { if (settled) return; settled = true; signal.removeEventListener("abort", onAbort); f(); };
    const onAbort = () => {
      aborted = true;
      killTree(child, "SIGTERM");
      const t = setTimeout(() => { if (child.pid && groupAlive(child.pid)) killTree(child, "SIGKILL"); }, sp.killGraceMs ?? 1500);
      t.unref();
      // Do not wait for pipes held open by stray grandchildren.
      setTimeout(() => finish(() => reject(abortError())), (sp.killGraceMs ?? 1500) + 500).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => finish(() => reject(new EngineError("spawn", `could not start ${sp.bin}: ${(e as NodeJS.ErrnoException).code ?? "error"}`))));
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > MAX_STDOUT) { out = ""; killTree(child, "SIGKILL"); finish(() => reject(new EngineError("malformed", "engine output too large"))); }
    });
    child.stderr!.on("data", (d: Buffer) => { errBytes += d.length; }); // counted, never logged
    child.stdin!.on("error", () => { /* EPIPE if the child exits early; the exit code reports it */ });
    child.stdin!.end(sp.stdin);
    child.on("close", (code) => finish(() => {
      if (aborted) return reject(abortError());
      if (code !== 0) return reject(new EngineError("exit", `engine exited with code ${code} (${errBytes} bytes on stderr)`));
      resolve(out);
    }));
  });
}

/** One `claude -p` invocation (claude-code, or glm when `engine` is "glm"). */
export async function runClaude(prompt: string, signal: AbortSignal, o: EngineOptions = {}, engine: "claude-code" | "glm" = "claude-code"): Promise<string> {
  if (signal.aborted) throw abortReason(signal);
  const args = claudeArgs(o.model, engine === "claude-code" ? o.effort : null);
  const env = engineEnv(o.env, engine, o.apiKey);
  const cwd = await mkdtemp(join(tmpdir(), "mjr-claude-"));
  try {
    const stdout = await spawnCli({ bin: o.bin ?? "claude", args, env, cwd, stdin: prompt, signal, killGraceMs: o.killGraceMs });
    return parseClaudeEnvelope(stdout).text;
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** One `codex exec` invocation; the schema and the last-message file live in a private temp dir that is the child's cwd. */
export async function runCodex(prompt: string, signal: AbortSignal, o: EngineOptions = {}): Promise<string> {
  if (signal.aborted) throw abortReason(signal);
  const cwd = await mkdtemp(join(tmpdir(), "mjr-codex-"));
  try {
    const schemaFile = join(cwd, "schema.json"), outFile = join(cwd, "last-message.txt");
    await writeFile(schemaFile, JSON.stringify(codexSchemaFor(o.style)), { mode: 0o600 });
    const args = codexArgs({ model: o.model, effort: o.effort ?? DEFAULT_CODEX_EFFORT, schemaFile, outFile });
    await spawnCli({ bin: o.bin ?? "codex", args, env: engineEnv(o.env, "codex"), cwd, stdin: prompt, signal, killGraceMs: o.killGraceMs });
    let last: string;
    try { last = await readFile(outFile, "utf8"); } catch { throw new EngineError("malformed", "engine wrote no final message"); }
    return parseCodexLastMessage(last);
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** LlmProvider over an engine CLI, for produceReviewResult. A fatal failure (timeout, cancel, crash) is remembered and re-thrown so the repair retry does not run again. */
export class EngineProvider implements LlmProvider {
  readonly label: string; // footer: `runner:codex · model: gpt-5`
  readonly billing: Billing;
  fatal: EngineError | null = null;
  calls = 0;
  constructor(readonly engine: EngineId, private signal: AbortSignal, private opts: EngineOptions = {}) {
    this.billing = ENGINE_BILLING[engine];
    this.label = engineLabel(engine, opts.model ?? null, this.billing);
  }
  get model(): string | null { return this.opts.model ?? null; }
  async complete(req: LlmRequest): Promise<string> {
    if (this.fatal) throw this.fatal;
    this.calls++;
    const prompt = `${req.system}\n\n${req.user}`;
    try {
      return this.engine === "codex" ? await runCodex(prompt, this.signal, this.opts) : await runClaude(prompt, this.signal, this.opts, this.engine);
    } catch (e) {
      this.fatal = e instanceof EngineError ? e : new EngineError("exit", (e as Error).message);
      throw this.fatal;
    }
  }
}
/** Back-compat name for the claude-code engine. */
export class ClaudeCodeProvider extends EngineProvider {
  constructor(signal: AbortSignal, opts: EngineOptions = {}) { super("claude-code", signal, opts); }
}
