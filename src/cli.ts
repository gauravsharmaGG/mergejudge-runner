import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir, hostname, platform } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { createApi, errorCode, NetworkError } from "./api.js";
import { buildEngineSettings, glmKeyOf, GLM_KEY_ENV, pickDefaultEngine, runnerCaps } from "./capabilities.js";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, isClaudeEffort, isCodexEffort } from "./engine.js";
import { ConfigError, defaultConfigPath, loadConfig, saveConfig, validateUrl, type EngineSettings, type RunnerConfig } from "./config.js";
import { detectClis, engineLine, engineLines, glmReport, NO_ENGINE_MESSAGE, readyEngines, unlistedEngineNotes, type EngineReport } from "./detect.js";
import { createLogger, redact, tokenPrefix, type Logger } from "./redact.js";
import { deviceLogin } from "./login.js";
import { resolveLocalCode } from "./localcode.js";
import { runLoop } from "./run.js";
import { buildUnit, DEFAULT_URL, defaultExec, installAutostart, type ExecFn } from "./setup.js";
import { FEATURES, MODES, VERSION } from "./version.js";

export interface CliDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Test knobs forwarded to runLoop. */
  runOverrides?: Partial<Parameters<typeof runLoop>[0]>;
  /** Test knobs for `setup`. */
  prompt?: (question: string) => Promise<string>;
  /** Like `prompt` but for secrets (not echoed). */
  promptSecret?: (question: string) => Promise<string>;
  home?: string;
  platform?: string;
  exec?: ExecFn;
  /** Path of the running bundle (copied next to the config for auto-start). */
  bundlePath?: string;
  nodePath?: string;
  /** Test knob: waiting between sign-in polls. */
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (p: string) => boolean;
}

const USAGE = `mergejudge-runner ${VERSION}

Usage:
  mergejudge-runner register --code <enrollment-code> --url <https://app.mergejudge.si> [--name <name>] [--engine claude-code|codex|glm] [--model [engine=]<model>]... [--codex-effort minimal|low|medium|high|xhigh] [--claude-effort low|medium|high|xhigh|max] [--glm-key-env NAME] [--claude-bin <path>] [--codex-bin <path>] [--concurrency 1] [--force]
  mergejudge-runner login [--name <name>] [--installation <id>] [--url <https://app.mergejudge.si>] [--engine claude-code|codex|glm] [--model [engine=]<model>]... [--codex-effort minimal|low|medium|high|xhigh] [--claude-effort low|medium|high|xhigh|max] [--glm-key-env NAME] [--claude-bin <path>] [--codex-bin <path>] [--concurrency 1] [--force] [--yes]
  mergejudge-runner setup [code] [--yes] [--no-autostart] [--print-unit] [--name <name>] [--url <url>] [--engine <name>] [--model [engine=]<model>]... [--codex-effort minimal|low|medium|high|xhigh] [--claude-effort low|medium|high|xhigh|max] [--glm-key-env NAME | --no-glm] [--force]
  mergejudge-runner run [--concurrency 1] [--once] [--claude-bin <path>] [--codex-bin <path>] [--job-timeout-min 10] [--remote-url-template <url with {owner} and {repo}>] [--cache-max-gb 5] [--local-index-max-files 20000] [--local-index-max-mb 200] [--local-index-max-seconds 900]
  mergejudge-runner status

setup registers this machine (sign in with GitHub, or pass a code from the panel), detects which of claude and codex are installed and signed in, asks whether to add a GLM (z.ai, billed per use) API key, and offers to start the runner at login. MERGEJUDGE_URL overrides the default server.

Common: --config <path> (default: $XDG_CONFIG_HOME or ~/.config /mergejudge-runner/config.json)
`;

const COMMAND_USAGE: Record<string, string> = {
  register: "mergejudge-runner register --code <enrollment-code> --url <https://app.mergejudge.si> [--name <name>] [--engine claude-code|codex|glm] [--model [engine=]<model>]... [--codex-effort minimal|low|medium|high|xhigh] [--claude-effort low|medium|high|xhigh|max] [--glm-key-env NAME] [--claude-bin <path>] [--codex-bin <path>] [--concurrency 1] [--force]",
  login: "mergejudge-runner login [--name <name>] [--installation <id>] [--url <https://app.mergejudge.si>] [--engine claude-code|codex|glm] [--model [engine=]<model>]... [--codex-effort minimal|low|medium|high|xhigh] [--claude-effort low|medium|high|xhigh|max] [--glm-key-env NAME] [--claude-bin <path>] [--codex-bin <path>] [--concurrency 1] [--force] [--yes]\n\nSigns in with GitHub (device flow): prints a code to enter at the address shown, waits for you to approve the MergeJudge GitHub App, then registers this machine and saves the config. With several installations, pass --installation <id> (or pick one when run in a terminal). MERGEJUDGE_URL overrides the default server.",
  setup: "mergejudge-runner setup [code] [--yes] [--no-autostart] [--print-unit] [--name <name>] [--url <url>] [--engine <name>] [--model [engine=]<model>]... [--codex-effort minimal|low|medium|high|xhigh] [--claude-effort low|medium|high|xhigh|max] [--glm-key-env NAME | --no-glm] [--force]\n\nRegisters this machine (without a code: sign in with GitHub, like `login`; with a code from the panel: enrollment code), detects which of claude and codex are installed and signed in, asks whether to add a GLM (z.ai, billed per use) API key (--glm-key-env NAME reads it from that environment variable; --no-glm skips the question), and offers to start the runner at login. MERGEJUDGE_URL overrides the default server.",
  run: "mergejudge-runner run [--concurrency 1] [--once] [--claude-bin <path>] [--codex-bin <path>] [--job-timeout-min 10] [--remote-url-template <url with {owner} and {repo}>] [--cache-max-gb 5] [--local-index-max-files 20000] [--local-index-max-mb 200] [--local-index-max-seconds 900]",
  status: "mergejudge-runner status",
};

const intOpt = (v: string | undefined, d: number, min: number, max: number, name: string): number => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`--${name} must be an integer between ${min} and ${max}`);
  return n;
};

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { out(USAGE); return cmd ? 0 : 2; }
  if (cmd === "--version" || cmd === "-v") { out(VERSION); return 0; }
  try {
    const { values: v, positionals } = parseArgs({
      args: rest, strict: true, allowPositionals: cmd === "setup",
      options: {
        code: { type: "string" }, url: { type: "string" }, name: { type: "string" }, engine: { type: "string" },
        "claude-bin": { type: "string" }, "codex-bin": { type: "string" }, "codex-effort": { type: "string" }, "claude-effort": { type: "string" }, model: { type: "string", multiple: true }, "glm-key-env": { type: "string" }, "no-glm": { type: "boolean" }, concurrency: { type: "string" }, force: { type: "boolean" }, once: { type: "boolean" },
        config: { type: "string" }, "job-timeout-min": { type: "string" }, "remote-url-template": { type: "string" }, "cache-max-gb": { type: "string" }, "local-index-max-files": { type: "string" }, "local-index-max-mb": { type: "string" }, "local-index-max-seconds": { type: "string" }, wait: { type: "string" },
        help: { type: "boolean", short: "h" },
        installation: { type: "string" }, yes: { type: "boolean" }, "no-autostart": { type: "boolean" }, "print-unit": { type: "boolean" }, "dry-run-autostart": { type: "boolean" },
      },
    });
    if (v.help && cmd in COMMAND_USAGE) { out(`Usage:\n  ${COMMAND_USAGE[cmd]}\n\nCommon: --config <path>, --help`); return 0; }
    const configPath = v.config ?? defaultConfigPath(env);
    if (cmd === "register") return await register(v, configPath, deps, out);
    if (cmd === "login") return await login(v, configPath, deps, out);
    if (cmd === "setup") return await setup(v, positionals, configPath, deps, out, err);
    if (cmd === "run") return await run(v, configPath, deps, err);
    if (cmd === "status") return await status(configPath, deps, out);
    err(`unknown command: ${cmd}\n${USAGE}`);
    return 2;
  } catch (e) {
    err(redact(`error: ${(e as Error).message}`));
    return e instanceof ConfigError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1;
  }
}

/** `--codex-effort <level>`: stored as engines.codex.effort. Without the flag the runner uses low. */
function applyCodexEffort(settings: Record<string, EngineSettings>, effort: string | undefined): void {
  if (effort === undefined) return;
  if (!isCodexEffort(effort)) throw new ConfigError(`--codex-effort must be one of ${CODEX_EFFORTS.join(", ")}`);
  if (!settings.codex) throw new ConfigError("--codex-effort needs the codex engine (codex installed and signed in, or --engine codex)");
  settings.codex.effort = effort;
}

/** `--claude-effort <level>`: stored as engines["claude-code"].effort and passed to claude as `--effort`. Without the flag no effort flag is passed. */
function applyClaudeEffort(settings: Record<string, EngineSettings>, effort: string | undefined): void {
  if (effort === undefined) return;
  if (!isClaudeEffort(effort)) throw new ConfigError(`--claude-effort must be one of ${CLAUDE_EFFORTS.join(", ")}`);
  if (!settings["claude-code"]) throw new ConfigError("--claude-effort needs the claude-code engine (claude installed and signed in, or --engine claude-code)");
  settings["claude-code"].effort = effort;
}

type Vals = Record<string, string | boolean | string[] | undefined>;

const installationOpt = (v: Vals): number | undefined => (v.installation === undefined ? undefined : intOpt(v.installation as string, 0, 1, Number.MAX_SAFE_INTEGER, "installation"));

/** Probes claude and codex (and counts a given GLM key) the same way for setup, login and register. */
function detectEngines(v: Vals, deps: CliDeps, glmApiKey: string | undefined): EngineReport[] {
  return [...detectClis({
    env: deps.env ?? process.env, home: deps.home ?? homedir(), exec: deps.exec ?? defaultExec, fileExists: deps.fileExists,
    claudeBin: v["claude-bin"] as string | undefined, codexBin: v["codex-bin"] as string | undefined,
  }), glmReport(!!glmApiKey)];
}

/** The binary to store: the flag, else the common directory it was found in (off PATH), else nothing. */
const binToStore = (v: Vals, flag: "claude-bin" | "codex-bin", reports: EngineReport[], engine: string): string | undefined =>
  (v[flag] as string | undefined) ?? reports.find((r) => r.engine === engine)?.foundAt;

/**
 * login and register: --engine wins (only that engine, as before); otherwise every engine detected as ready is enabled,
 * the first (claude-code, codex, glm order) is the default, and claude-code stays the not-yet-usable default when none is ready.
 */
function engineChoice(v: Vals, deps: CliDeps, env: Record<string, string | undefined>, out: (l: string) => void) {
  const glmApiKey = readGlmKeyEnv(v["glm-key-env"] as string | undefined, env);
  const requested = v.engine as string | undefined;
  const models = (v.model as string[] | undefined) ?? [];
  let reports: EngineReport[] = [];
  let engine: string, settings: Record<string, EngineSettings>;
  if (requested) {
    engine = requested;
    settings = buildEngineSettings([engine], pickDefaultEngine(engine, engine === "glm" && !glmApiKey && !env[GLM_KEY_ENV] ? [] : [engine]), models);
  } else {
    reports = detectEngines(v, deps, glmApiKey);
    const enabled = readyEngines(reports);
    engine = pickDefaultEngine(undefined, enabled);
    settings = buildEngineSettings(enabled.length ? enabled : [engine], engine, models);
    if (!enabled.length) { out(NO_ENGINE_MESSAGE); for (const l of engineLines(reports, deps.home ?? homedir(), true)) out(l); }
  }
  applyCodexEffort(settings, v["codex-effort"] as string | undefined);
  applyClaudeEffort(settings, v["claude-effort"] as string | undefined);
  return {
    engine, settings, glmApiKey,
    claudeBin: binToStore(v, "claude-bin", reports, "claude-code"), codexBin: binToStore(v, "codex-bin", reports, "codex"),
  };
}

const nextStep = (engine: string) => engine === "codex" ? "Next: make sure `codex` is signed in with ChatGPT (`codex login`), then run `mergejudge-runner run`."
  : engine === "glm" ? "Next: run `mergejudge-runner run`. GLM reviews are billed to your z.ai API key."
  : "Next: make sure `claude` is logged in with your own subscription, then run `mergejudge-runner run`.";

async function login(v: Vals, configPath: string, deps: CliDeps, out: (l: string) => void): Promise<number> {
  const env = deps.env ?? process.env;
  const { engine, settings, glmApiKey, claudeBin, codexBin } = engineChoice(v, deps, env, out);
  const cfg = await loginRunner({
    url: (v.url as string | undefined) ?? env.MERGEJUDGE_URL ?? DEFAULT_URL, name: v.name as string | undefined, engine, settings, glmApiKey, concurrency: v.concurrency as string | undefined,
    claudeBin, codexBin, force: v.force === true, configPath, fetch: deps.fetch, env,
    installation: installationOpt(v),
  }, deps, out);
  out(`Registered runner ${cfg.runnerId} (${cfg.name}). Config saved to ${configPath} (mode 600).`);
  for (const l of engineSummary(cfg, env)) out(l);
  out(nextStep(engine));
  return 0;
}

async function register(v: Vals, configPath: string, deps: CliDeps, out: (l: string) => void): Promise<number> {
  const code = v.code as string | undefined, urlRaw = v.url as string | undefined;
  if (!code || !urlRaw) throw new ConfigError("register needs --code and --url");
  const env = deps.env ?? process.env;
  const { engine, settings, glmApiKey, claudeBin, codexBin } = engineChoice(v, deps, env, out);
  const cfg = await registerRunner({
    code, url: urlRaw, name: v.name as string | undefined, engine, settings, glmApiKey, concurrency: v.concurrency as string | undefined,
    claudeBin, codexBin, force: v.force === true, configPath, fetch: deps.fetch, env,
  });
  out(`Registered runner ${cfg.runnerId} (${cfg.name}). Config saved to ${configPath} (mode 600).`);
  for (const l of engineSummary(cfg, env)) out(l);
  out(nextStep(engine));
  return 0;
}

interface RegisterInput {
  code: string; url: string; name?: string; engine?: string; settings?: Record<string, EngineSettings>; glmApiKey?: string; concurrency?: string;
  claudeBin?: string; codexBin?: string; force: boolean; configPath: string; fetch?: typeof fetch; env?: Record<string, string | undefined>;
}

/** The z.ai key from the environment variable NAME given with --glm-key-env (never from argv). */
function readGlmKeyEnv(name: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!name) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError("--glm-key-env takes the NAME of an environment variable, not the key itself");
  const k = (env[name] ?? "").trim();
  if (!k) throw new ConfigError(`--glm-key-env ${name}: that environment variable is empty or not set`);
  return k;
}

/** Human summary of what the runner offers (never prints keys). */
function engineSummary(cfg: RunnerConfig, env: Record<string, string | undefined>): string[] {
  const caps = runnerCaps(cfg, env);
  if (!caps.length) return ["engines:    none usable yet"];
  return caps.map((c, i) => `${i === 0 ? "engines:   " : "           "} ${c.engine}${i === 0 ? " (default)" : ""} - ${c.billing === "api-key" ? "API key, billed per use" : "subscription"}, model ${c.defaultModel ?? "default"}${c.models.filter((m) => m !== c.defaultModel).length ? ` (also: ${c.models.filter((m) => m !== c.defaultModel).join(", ")})` : ""}`);
}

interface Prepared { url: string; engine: string; engines: Record<string, EngineSettings>; glmApiKey: string | null; caps: ReturnType<typeof runnerCaps>; concurrency: number; name: string }

/** Validates the inputs shared by every way of registering (code or GitHub sign-in). */
function prepareRegistration(i: Omit<RegisterInput, "code">): Prepared {
  const url = validateUrl(i.url);
  const engine = i.engine ?? "claude-code";
  if (!["claude-code", "codex", "glm"].includes(engine)) throw new ConfigError(`unsupported engine "${engine}" (use claude-code, codex or glm)`);
  const engines = i.settings ?? { [engine]: {} };
  const env = i.env ?? process.env;
  const glmApiKey = i.glmApiKey ?? null;
  const caps = runnerCaps({ engine, engines, glmApiKey } as RunnerConfig, env);
  if (!caps.length) throw new ConfigError(`engine "${engine}" has no usable settings (glm needs a z.ai key: --glm-key-env NAME or ${GLM_KEY_ENV})`);
  const concurrency = intOpt(i.concurrency, 1, 1, 16, "concurrency");
  if (!i.force && existsSync(i.configPath)) throw new ConfigError(`already registered (${i.configPath}); use --force to replace it`);
  return { url, engine, engines, glmApiKey, caps, concurrency, name: i.name ?? hostname() };
}

/** The capability fields /register and /device/poll both take. */
const capabilityBody = (p: Prepared) => ({
  // `engines` (names) stays for Workers older than runner 0.2.0; `capabilities` carries billing and models.
  engines: p.caps.map((c) => c.engine), capabilities: p.caps, modes: [...MODES], features: [...FEATURES], concurrency: p.concurrency, version: VERSION, labels: [platform()],
});

/** Writes the config (0600, atomic) from a register / device-poll answer. */
function writeRegistered(i: Omit<RegisterInput, "code">, p: Prepared, r: { runnerId: string; accessToken: string; expiresAt?: unknown; installationId?: unknown }): RunnerConfig {
  const cfg: RunnerConfig = {
    v: 1, url: p.url, runnerId: r.runnerId, name: p.name, engine: p.engine, token: r.accessToken,
    tokenExpiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
    ...(typeof r.installationId === "number" ? { installationId: r.installationId } : {}),
    engines: p.engines, ...(p.glmApiKey ? { glmApiKey: p.glmApiKey } : {}),
    claudeBin: i.claudeBin ?? null, ...(i.codexBin ? { codexBin: i.codexBin } : {}), registeredAt: new Date().toISOString(),
  };
  saveConfig(i.configPath, cfg);
  return cfg;
}

/** Enrollment code -> runner token, saved to the config file (0600). Shared by `register` and `setup <code>`. */
async function registerRunner(i: RegisterInput): Promise<RunnerConfig> {
  const p = prepareRegistration(i);
  const api = createApi(p.url, VERSION, i.fetch);
  let res;
  try {
    res = await api("POST", "/register", { token: i.code, body: { name: p.name, ...capabilityBody(p) } });
  } catch (e) {
    if (e instanceof NetworkError) throw new Error(`could not reach ${p.url}: ${e.message}`);
    throw e;
  }
  if (res.status === 401) throw new Error("the enrollment code is invalid, expired (15 min) or already used; create a new one in the panel");
  if (res.status === 429) throw new Error(`rate limited; retry in ${Math.ceil((res.retryAfterMs ?? 60_000) / 1000)}s`);
  if (res.status !== 201 || typeof res.body?.accessToken !== "string" || typeof res.body.runnerId !== "string") {
    throw new Error(`registration failed (HTTP ${res.status}: ${errorCode(res)})`);
  }
  return writeRegistered(i, p, res.body as { runnerId: string; accessToken: string });
}

/** Sign in with GitHub (device flow) -> runner token, saved to the config file (0600). Used by `login` and `setup` without a code. */
async function loginRunner(i: Omit<RegisterInput, "code"> & { installation?: number }, deps: CliDeps, out: (l: string) => void): Promise<RunnerConfig> {
  const p = prepareRegistration(i);
  const interactive = canPrompt(deps);
  const reg = await deviceLogin({
    api: createApi(p.url, VERSION, i.fetch), out, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ...(interactive ? { choose: async (list) => {
      for (;;) {
        const a = (await ask(deps, `Number (1-${list.length}): `)).trim();
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= list.length) return n - 1;
        out("Not a valid number.");
      }
    } } : {}),
  }, capabilityBody(p), p.name, i.installation);
  return writeRegistered(i, p, reg);
}

async function ask(deps: CliDeps, question: string): Promise<string> {
  if (deps.prompt) return deps.prompt(question);
  if (!process.stdin.isTTY) throw new ConfigError("no terminal to prompt on; answer the prompts, or pass --yes / --no-autostart");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

/** Reads a secret without echoing it. */
async function askSecret(deps: CliDeps, question: string): Promise<string> {
  if (deps.promptSecret) return deps.promptSecret(question);
  if (deps.prompt) return deps.prompt(question);
  if (!process.stdin.isTTY) throw new ConfigError("no terminal to read the key from; use --glm-key-env NAME");
  let muted = false;
  const sink = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  try {
    process.stdout.write(question);
    muted = true;
    return await rl.question("");
  } finally { muted = false; rl.close(); process.stdout.write("\n"); }
}
const canPrompt = (deps: CliDeps) => !!deps.prompt || !!process.stdin.isTTY;

async function setup(v: Vals, positionals: string[], configPath: string, deps: CliDeps, out: (l: string) => void, err: (l: string) => void): Promise<number> {
  if (positionals.length > 1) throw new ConfigError("setup takes at most one argument: the sign-up code");
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const plat = deps.platform ?? platform();
  const exec = deps.exec ?? defaultExec;
  const printOnly = v["print-unit"] === true || v["dry-run-autostart"] === true;
  if (v.yes && v["no-autostart"]) throw new ConfigError("--yes and --no-autostart conflict");
  const url = (v.url as string | undefined) ?? env.MERGEJUDGE_URL ?? DEFAULT_URL;

  // Provider CLIs: installed and signed in? Never fatal. The probes run without ANTHROPIC_API_KEY / OPENAI_API_KEY.
  const clis = detectEngines(v, deps, undefined).filter((r) => r.engine !== "glm");
  const claudePath = clis.find((r) => r.engine === "claude-code")?.bin ?? null;
  const codexPath = clis.find((r) => r.engine === "codex")?.bin ?? null;

  let cfg: RunnerConfig;
  if (printOnly && existsSync(configPath) && !positionals[0]) {
    cfg = loadConfig(configPath);
  } else {
    const code = positionals[0]?.trim() || undefined;
    if (positionals[0] !== undefined && !code) throw new ConfigError("the sign-up code is empty");
    for (const l of engineLines(clis, home)) out(l);

    // Optional GLM (z.ai) key: an API-key engine, billed per use. Flag for scripts, yes/no question otherwise.
    let glmApiKey = readGlmKeyEnv(v["glm-key-env"] as string | undefined, env);
    const asked = !glmApiKey && v["no-glm"] !== true && canPrompt(deps);
    if (asked) {
      const wantGlm = /^(y|yes)$/i.test((await ask(deps, "Also add a GLM (z.ai) API key? It is an API-key engine, billed per use, not a subscription. [y/N] ")).trim());
      if (wantGlm) {
        const fromEnv = (env[GLM_KEY_ENV] ?? "").trim();
        const typed = (await askSecret(deps, `z.ai API key (input hidden${fromEnv ? `; Enter = use $${GLM_KEY_ENV}` : ""}): `)).trim();
        glmApiKey = typed || fromEnv || undefined;
        if (!glmApiKey) out("No key entered; skipping GLM.");
      }
    }
    const glm = glmReport(!!glmApiKey);
    for (const l of asked ? [engineLine(glm, home)] : engineLines([glm], home)) out(l);
    const ready = readyEngines([...clis, glm]);
    const requested = v.engine as string | undefined;
    if (!ready.length && !requested) out(NO_ENGINE_MESSAGE);
    // Several ready and a terminal: let the owner pick the default; the rest stay enabled, in their order.
    let enabled = ready;
    if (ready.length > 1 && !requested && canPrompt(deps)) {
      out("More than one engine is ready. Which should be the default? The others stay enabled.");
      ready.forEach((e, i) => out(`  ${i + 1}) ${e}`));
      const a = (await ask(deps, `Default engine (1-${ready.length}, Enter = 1): `)).trim();
      const n = Number(a);
      let idx = 0;
      if (a !== "") { if (Number.isInteger(n) && n >= 1 && n <= ready.length) idx = n - 1; else out(`Not a valid number; using ${ready[0]}.`); }
      enabled = [ready[idx]!, ...ready.filter((_, i) => i !== idx)];
    }
    // Nothing signed in yet: keep claude-code as the (not yet usable) default, as before, unless the owner asked for another engine.
    const engine = requested && !enabled.includes(requested) && enabled.length === 0 && requested !== "glm" ? requested : pickDefaultEngine(requested, enabled);
    const settings = buildEngineSettings(enabled.includes(engine) ? enabled : [...enabled, engine], engine, (v.model as string[] | undefined) ?? []);
    applyCodexEffort(settings, v["codex-effort"] as string | undefined);
    applyClaudeEffort(settings, v["claude-effort"] as string | undefined);
    const input = {
      url, name: v.name as string | undefined, engine, settings, glmApiKey, concurrency: v.concurrency as string | undefined,
      claudeBin: binToStore(v, "claude-bin", clis, "claude-code"), codexBin: binToStore(v, "codex-bin", clis, "codex"), force: v.force === true, configPath, fetch: deps.fetch, env,
    };
    cfg = code ? await registerRunner({ ...input, code }) : await loginRunner({ ...input, installation: installationOpt(v) }, deps, out);
    out(`Registered runner ${cfg.runnerId} (${cfg.name}) with ${cfg.url}. Config saved to ${configPath} (mode 600${glmApiKey ? "; it holds your z.ai key" : ""}).`);
    for (const l of engineSummary(cfg, env)) out(l);
    if (glmApiKey) out("GLM runs through z.ai with your API key and is billed per use. The key is stored only in the config file and is never printed.");
  }
  if (printOnly) {
    for (const l of [...engineLines(clis, home), ...engineLines([glmReport(!!glmKeyOf(cfg, env))], home)]) out(l);
  }

  // Auto-start.
  const deps2 = { platform: plat, home, env, exec, node: deps.nodePath ?? process.execPath, configPath, claudeBin: claudePath, codexBin: codexPath, fileExists: deps.fileExists };
  const supported = buildUnit(deps2) !== null;
  if (printOnly) {
    const unit = buildUnit(deps2);
    if (!unit) out(`auto-start is not supported on ${plat}`);
    else { out(`# ${unit.path}`); out(unit.text); }
  } else if (!supported) {
    out(`Auto-start is not supported on ${plat}; start the runner yourself with: npx mergejudge-runner run`);
  } else if (!v["no-autostart"]) {
    const yes = v.yes === true || /^(|y|yes)$/i.test((await ask(deps, `Start the runner automatically at login (${plat === "darwin" ? "launchd" : "systemd user service"})? [Y/n] `)).trim());
    if (yes) {
      try { for (const n of installAutostart(deps2, deps.bundlePath ?? fileURLToPath(import.meta.url))) out(n); } catch (e) { err(redact(`warning: ${(e as Error).message}`)); }
    } else out("Skipping auto-start. Start the runner with: npx mergejudge-runner run");
  } else out("Skipping auto-start. Start the runner with: npx mergejudge-runner run");

  out("");
  const code = await status(configPath, deps, out, false);
  if (code !== 0) out("The runner is registered; the server did not accept a heartbeat just now. Check `mergejudge-runner status` later.");
  return 0;
}

async function run(v: Vals, configPath: string, deps: CliDeps, err: (l: string) => void): Promise<number> {
  const cfg = loadConfig(configPath);
  const env = deps.env ?? process.env;
  const log: Logger = createLogger((l) => err(l), () => [cfg.token, glmKeyOf(cfg, env) ?? ""]);
  const ac = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, ac.signal]) : ac.signal;
  let hits = 0;
  const onSig = (s: string) => {
    if (++hits > 1) { err(`second ${s}: exiting immediately`); process.exit(130); }
    log.info(`received ${s}`);
    ac.abort();
  };
  const handlers: [NodeJS.Signals, () => void][] = (["SIGINT", "SIGTERM"] as const).map((s) => [s, () => onSig(s)]);
  if (!deps.signal) for (const [s, h] of handlers) process.on(s, h);
  try {
    return await runLoop({
      cfg, configPath, log, signal, fetch: deps.fetch,
      concurrency: intOpt(v.concurrency as string | undefined, 1, 1, 16, "concurrency"),
      once: v.once === true,
      waitS: intOpt(v.wait as string | undefined, 25, 0, 25, "wait"),
      jobTimeoutMs: intOpt(v["job-timeout-min"] as string | undefined, 10, 1, 120, "job-timeout-min") * 60_000,
      claude: { bin: (v["claude-bin"] as string | undefined) ?? cfg.claudeBin ?? undefined, env: deps.env },
      codex: { bin: (v["codex-bin"] as string | undefined) ?? cfg.codexBin ?? undefined, env: deps.env },
      env: deps.env,
      local: resolveLocalCode(env, cfg.localCode, { remoteUrlTemplate: v["remote-url-template"] as string | undefined, cacheMaxGb: v["cache-max-gb"] ? Number(v["cache-max-gb"]) : undefined, indexMaxFiles: v["local-index-max-files"] ? Number(v["local-index-max-files"]) : undefined, indexMaxMb: v["local-index-max-mb"] ? Number(v["local-index-max-mb"]) : undefined, indexMaxSeconds: v["local-index-max-seconds"] ? Number(v["local-index-max-seconds"]) : undefined }, deps.home),
      exec: deps.exec, home: deps.home, fileExists: deps.fileExists,
      ...deps.runOverrides,
    });
  } finally {
    if (!deps.signal) for (const [s, h] of handlers) process.off(s, h);
  }
}

async function status(configPath: string, deps: CliDeps, out: (l: string) => void, showToken = true): Promise<number> {
  const cfg = loadConfig(configPath);
  out(`config:     ${configPath}`);
  out(`worker:     ${cfg.url}`);
  out(`runner:     ${cfg.runnerId} (${cfg.name})`);
  for (const l of engineSummary(cfg, deps.env ?? process.env)) out(l);
  if (cfg.engines?.glm && !glmKeyOf(cfg, deps.env ?? process.env)) out("glm:        enabled but no key (set glmApiKey via setup, or ZAI_API_KEY); not offered");
  else if (cfg.engines?.glm) out(`glm key:    ${cfg.glmApiKey ? "stored in the config file (hidden)" : `from $${GLM_KEY_ENV} (hidden)`}`);
  if (showToken) {
    const configured = [cfg.engine, ...Object.keys(cfg.engines ?? {})];
    const found = detectClis({ env: deps.env ?? process.env, home: deps.home ?? homedir(), exec: deps.exec ?? defaultExec, fileExists: deps.fileExists, claudeBin: cfg.claudeBin, codexBin: cfg.codexBin, skip: configured });
    for (const n of unlistedEngineNotes(configured, found)) out(`note:       ${n}`);
  }
  out(`token:      ${showToken ? tokenPrefix(cfg.token) : "stored (hidden)"}${cfg.tokenExpiresAt ? ` (expires ${cfg.tokenExpiresAt})` : ""}`);
  const api = createApi(cfg.url, VERSION, deps.fetch);
  try {
    const t0 = Date.now();
    const r = await api("POST", "/heartbeat", { token: cfg.token, body: {}, timeoutMs: 15_000 });
    const ms = Date.now() - t0;
    out(`reachable:  yes (${ms} ms)`);
    if (r.status === 200) { out("heartbeat:  ok (runner token accepted)"); return 0; }
    out(`heartbeat:  rejected (HTTP ${r.status}: ${errorCode(r)})${r.status === 401 ? " - token revoked or expired; register again" : ""}`);
    return 1;
  } catch (e) {
    out(redact(`reachable:  no (${(e as Error).message})`));
    return 1;
  }
}

// Run as a program (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(redact(`error: ${(e as Error).message}`)); process.exit(1); });
}
