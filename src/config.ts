import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Per-engine settings the owner chose with `setup`. */
export interface EngineSettings {
  /** Default model for this engine (null / absent = the CLI's own default). */
  model?: string | null;
  /** codex: reasoning effort (minimal|low|medium|high|xhigh); absent = low. claude-code: low|medium|high|xhigh|max passed as `--effort`; absent = no flag. */
  effort?: string | null;
  /** Further models this runner agrees to run when a repo asks for them ("*" = any). */
  models?: string[];
}

export interface RunnerConfig {
  v: 1;
  /** Worker origin, e.g. https://app.mergejudge.si (no path). */
  url: string;
  runnerId: string;
  installationId?: number;
  name: string;
  /** Default engine: used when a repo does not ask for one. */
  engine: string;
  /** Engines this runner offers, with their models. Absent (runner 0.1.0 configs) = just `engine`. */
  engines?: Record<string, EngineSettings>;
  /** z.ai API key for the glm engine (this file is 0600). ZAI_API_KEY in the environment is used when absent. Never logged or echoed. */
  glmApiKey?: string | null;
  /** Path of the codex binary; null = `codex` on PATH. */
  codexBin?: string | null;
  token: string;
  /** ISO time the access token expires (null if the server did not say). */
  tokenExpiresAt: string | null;
  /** Local code source (deep reviews from this machine's own git clone). Environment variables and `run` flags override these. */
  localCode?: { remoteUrlTemplate?: string | null; cacheMaxGb?: number | null; keepSnapshots?: number | null; maxAgeDays?: number | null; indexMaxFiles?: number | null; indexMaxMb?: number | null; indexMaxSeconds?: number | null };
  /** Path of the claude binary; null = `claude` on PATH. */
  claudeBin: string | null;
  registeredAt: string;
}

export class ConfigError extends Error {}

export function defaultConfigPath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/") ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(base, "mergejudge-runner", "config.json");
}

/** https only; plain http is accepted for localhost / 127.0.0.1 / [::1] (tests, local Worker). Returns the origin. */
export function validateUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConfigError(`invalid --url: ${raw}`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ConfigError("--url must be https:// (http:// is only allowed for localhost)");
  if (u.username || u.password) throw new ConfigError("--url must not contain credentials");
  return u.origin;
}

/** Reads the config, refusing a file that group/other can read or write (the token is in it). */
export function loadConfig(path: string): RunnerConfig {
  let st;
  try { st = statSync(path); } catch { throw new ConfigError(`no config at ${path}; run \`mergejudge-runner register\` first`); }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new ConfigError(`refusing to use ${path}: permissions are ${(st.mode & 0o777).toString(8).padStart(3, "0")} but must be 600 (it holds your runner token). Fix with: chmod 600 "${path}"`);
  }
  let c: Partial<RunnerConfig>;
  try { c = JSON.parse(readFileSync(path, "utf8")); } catch { throw new ConfigError(`${path} is not valid JSON`); }
  if (c.v !== 1 || !c.url || !c.runnerId || !c.token) throw new ConfigError(`${path} is incomplete; register again with --force`);
  const cfg = { name: "runner", engine: "claude-code", tokenExpiresAt: null, claudeBin: null, registeredAt: "", ...c } as RunnerConfig;
  if (!cfg.engines) cfg.engines = { [cfg.engine]: {} };
  return cfg;
}

/** Atomic write: temp file (0600) in the same directory, fsync, rename. Directory is created 0700. */
export function saveConfig(path: string, cfg: RunnerConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const tmp = join(dir, `.config.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(cfg, null, 2)}\n`);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  closeSync(fd);
  try {
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}
