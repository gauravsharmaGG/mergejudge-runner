/** The `run` loop: long-poll, heartbeat, execute, submit, nack, back off, rotate the token, shut down cleanly. */
import { homedir } from "node:os";
import { createApi, errorCode, NetworkError, type Api, type ApiResponse } from "./api.js";
import { detectClis, unlistedEngineNotes } from "./detect.js";
import { saveConfig, type RunnerConfig } from "./config.js";
import { glmKeyOf, runnerCaps } from "./capabilities.js";
import { EngineError, JobAbort, type EngineId, type EngineOptions } from "./engine.js";
import { resolveLocalCode, type LocalCodeOptions } from "./localcode.js";
import type { ReviewMode } from "./deep.js";
import { NackError, produceResult, type LeasedJob } from "./job.js";
import type { Logger } from "./redact.js";
import { checkCli, CODEX_API_KEY_REASON, CODEX_NOT_CHATGPT_REASON, defaultExec, type ExecFn } from "./setup.js";
import { FEATURES, MODES, VERSION } from "./version.js";

const MAX_RESULT_BYTES = 512 * 1024; // server limit (packages/worker/src/runner.ts)
const DAY = 86_400_000;

export interface RunOptions {
  cfg: RunnerConfig;
  configPath: string;
  log: Logger;
  signal: AbortSignal;
  concurrency?: number;
  once?: boolean;
  /** Long-poll wait in seconds (server max 25). */
  waitS?: number;
  jobTimeoutMs?: number;
  /** Heartbeat interval; default min(server hint, 20 s), always below the 60 s lease. */
  heartbeatMs?: number;
  /** After SIGINT/SIGTERM, how long in-flight jobs may finish before they are killed and nacked. */
  shutdownGraceMs?: number;
  /** Rotate when the token has less than this left. */
  rotateBeforeMs?: number;
  backoff?: { baseMs: number; maxMs: number };
  /** Spawn options for the claude binary (and glm, which is claude pointed at z.ai): bin, env, kill grace. */
  claude?: EngineOptions;
  /** Local code source settings (paths, remote template, cache limits); default: from the environment and the config file. */
  local?: LocalCodeOptions;
  /** Runs the `codex login status` probe (tests inject a fake). */
  exec?: ExecFn;
  /** Home directory and file check for the off-PATH binary search (tests inject fakes). */
  home?: string;
  fileExists?: (p: string) => boolean;
  /** Spawn options for the codex binary. */
  codex?: EngineOptions;
  /** Environment engines copy their allowlist from, and where ZAI_API_KEY is read (default: claude.env, then process.env). */
  env?: Record<string, string | undefined>;
  /** `--deep` / `--mode` / `MERGEJUDGE_MODE`. Unset keeps `ai.mode` from the job config (default fast). */
  aiMode?: ReviewMode;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });

class Fatal extends Error {}

interface Inflight { ctl: AbortController; id: string }

export async function runLoop(o: RunOptions): Promise<number> {
  const { log, signal } = o;
  const now = o.now ?? Date.now, sleep = o.sleep ?? defaultSleep;
  const concurrency = Math.max(1, o.concurrency ?? 1);
  const backoff = o.backoff ?? { baseMs: 1000, maxMs: 60_000 };
  const request = createApi(o.cfg.url, VERSION, o.fetch);
  let cfg = o.cfg;
  let rotateHint = false, nextRotateTry = 0, rotating: Promise<void> | null = null;
  const inflight = new Set<Inflight>();
  const stop = new AbortController(); // fatal error or --once done
  let exitCode = 0;
  const halt = (code: number) => { exitCode = code; stop.abort(); };
  const stopping = () => signal.aborted || stop.signal.aborted;
  const pollSignal = AbortSignal.any([signal, stop.signal]);

  const api: Api = async (method, path, opts = {}) => {
    const res = await request(method, path, { token: cfg.token, ...opts });
    if (res.headers.get("x-mergejudge-rotate")) rotateHint = true;
    if (res.status === 401) throw new Fatal("the Worker rejected the runner token (revoked or expired). Re-register with a new enrollment code.");
    return res;
  };

  // ---- token rotation: persist the new token (atomic) before the first request that uses it ----
  async function rotateNow() {
    let res: ApiResponse;
    try { res = await request("POST", "/token/rotate", { token: cfg.token, body: {}, timeoutMs: 20_000 }); }
    catch (e) { nextRotateTry = now() + 5 * 60_000; log.warn("token rotation failed (network); will retry", { err: (e as Error).message }); return; }
    if (res.status === 200 && typeof res.body?.accessToken === "string") {
      const next: RunnerConfig = { ...cfg, token: res.body.accessToken, tokenExpiresAt: typeof res.body.expiresAt === "string" ? res.body.expiresAt : null };
      let saved = false;
      for (let i = 0; i < 3 && !saved; i++) {
        try { saveConfig(o.configPath, next); saved = true; } catch (e) { log.error("could not persist rotated token", { err: (e as Error).message }); await sleep(200); }
      }
      // The old token only lives a few more minutes, so the new one is used even if it could not be saved.
      cfg = next; rotateHint = false;
      log.info(saved ? "token rotated and saved" : "token rotated but NOT saved; the runner will need re-registering after a restart", { expires: next.tokenExpiresAt });
      return;
    }
    nextRotateTry = now() + (res.status === 409 ? 60 * 60_000 : 5 * 60_000);
    rotateHint = false;
    log.warn("token rotation was not accepted", { status: res.status, code: errorCode(res) });
  }
  async function maybeRotate() {
    if (rotating) return rotating;
    const exp = cfg.tokenExpiresAt ? Date.parse(cfg.tokenExpiresAt) : NaN;
    const due = rotateHint || (Number.isFinite(exp) && exp - now() < (o.rotateBeforeMs ?? 14 * DAY));
    if (!due || now() < nextRotateTry) return;
    rotating = rotateNow().finally(() => { rotating = null; });
    return rotating;
  }

  // ---- engines: what this runner offers, and how to spawn each ----
  const engEnv = o.env ?? o.claude?.env ?? process.env;
  // Codex is only used with a ChatGPT sign-in (subscription): checked once at startup.
  const blocked: Record<string, string> = {};
  if (cfg.engine === "codex" || cfg.engines?.codex) {
    const c = checkCli("codex", o.codex?.bin ?? cfg.codexBin ?? "codex", engEnv, o.exec ?? defaultExec);
    if (!c.signedIn) blocked.codex = c.apiKeyLogin ? CODEX_API_KEY_REASON : c.installed ? CODEX_NOT_CHATGPT_REASON : "the codex CLI was not found on this runner";
  }
  // Engines that are ready on this machine but were added after setup: a note only, the config is never changed.
  const configured = [cfg.engine, ...Object.keys(cfg.engines ?? {})];
  const found = detectClis({ env: engEnv, home: o.home ?? homedir(), exec: o.exec ?? defaultExec, fileExists: o.fileExists, claudeBin: o.claude?.bin ?? cfg.claudeBin, codexBin: o.codex?.bin ?? cfg.codexBin, skip: configured });
  for (const n of unlistedEngineNotes(configured, found)) log.info(n);
  const local = o.local ?? resolveLocalCode(engEnv, cfg.localCode);
  const caps = runnerCaps(cfg, engEnv, new Set(Object.keys(blocked)));
  const engineOptions = (engine: EngineId): EngineOptions => {
    const base = { env: engEnv, killGraceMs: o.claude?.killGraceMs };
    if (engine === "codex") return { ...base, effort: cfg.engines?.codex?.effort ?? undefined, bin: o.codex?.bin ?? cfg.codexBin ?? undefined, ...(o.codex?.killGraceMs !== undefined ? { killGraceMs: o.codex.killGraceMs } : {}) };
    return { ...base, bin: o.claude?.bin ?? cfg.claudeBin ?? undefined, ...(engine === "glm" ? { apiKey: glmKeyOf(cfg, engEnv) } : {}) };
  };
  // Declared at register and again here (and every 10 min), so a model added with `setup --model` reaches the Worker.
  let nextAnnounce = 0;
  async function maybeAnnounce() {
    if (now() < nextAnnounce || !caps.length) return;
    nextAnnounce = now() + 10 * 60_000;
    const r = await api("POST", "/heartbeat", { body: { capabilities: caps, modes: [...MODES], features: [...FEATURES], version: VERSION }, timeoutMs: 15_000 }).catch((e) => { if (e instanceof Fatal) throw e; return null; });
    if (r && r.status !== 200) log.warn("capability announce not accepted", { status: r.status, code: errorCode(r) });
  }

  // ---- backoff ----
  const delayFor = (attempt: number, res?: ApiResponse) => {
    const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(attempt, 16));
    const jittered = Math.floor(exp * (0.5 + Math.random() * 0.5));
    return res?.retryAfterMs != null ? Math.max(res.retryAfterMs, 0) : jittered;
  };

  // ---- nack / submit ----
  async function nack(job: LeasedJob, reason: string, code?: "unsupported") {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await api("POST", `/jobs/${job.id}/nack`, { body: { reason: reason.slice(0, 280), ...(code ? { code } : {}) }, timeoutMs: 15_000 });
        log.info("job nacked", { job: job.id, status: r.status, outcome: typeof r.body?.outcome === "string" ? r.body.outcome : undefined, reason });
        return;
      } catch (e) { if (e instanceof Fatal) throw e; await sleep(500); }
    }
    log.warn("could not nack job; the lease will expire", { job: job.id });
  }

  async function submit(job: LeasedJob, result: unknown, ctl: AbortController): Promise<void> {
    const body = { result, idempotencyKey: `${job.id}:${job.attempt}` };
    if (JSON.stringify(body).length > MAX_RESULT_BYTES) return nack(job, "result larger than the server limit");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (ctl.signal.aborted) return; // cancelled while submitting: do not post
      let res: ApiResponse;
      try { res = await api("POST", `/jobs/${job.id}/result`, { body, timeoutMs: 60_000 }); }
      catch (e) {
        if (e instanceof Fatal) throw e;
        if (!(e instanceof NetworkError)) throw e;
        log.warn("result submit failed (network)", { job: job.id, attempt: attempt + 1 });
        await sleep(delayFor(attempt)); continue;
      }
      if (res.status === 200) { log.info("result accepted", { job: job.id, duplicate: res.body?.duplicate === true }); return; }
      if (res.status === 409 || res.status === 410) { log.info("result not accepted (job superseded or lease lost); dropped", { job: job.id, status: res.status, code: errorCode(res) }); return; }
      if (res.status === 422) { log.error("server rejected the result", { job: job.id, code: errorCode(res) }); return nack(job, `server rejected the result (${errorCode(res)})`); }
      log.warn("result submit will be retried", { job: job.id, status: res.status, code: errorCode(res) });
      await sleep(delayFor(attempt, res));
    }
    log.error("gave up submitting result; the job will be re-leased", { job: job.id });
  }

  // ---- one job ----
  async function handleJob(job: LeasedJob, heartbeatEveryS: number) {
    const ctl = new AbortController();
    const entry: Inflight = { ctl, id: job.id };
    inflight.add(entry);
    const t0 = now();
    const payloadBytes = (() => { try { return JSON.stringify(job.payload).length; } catch { return 0; } })();
    log.info("job started", { job: job.id, repo: job.repo, pr: job.pr, mode: job.mode, attempt: job.attempt, payloadBytes });
    const timeoutMs = o.jobTimeoutMs ?? 10 * 60_000;
    const timer = setTimeout(() => ctl.abort(new JobAbort("timeout", `job timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    const hbMs = o.heartbeatMs ?? Math.min(Math.max(heartbeatEveryS, 1) * 1000, 20_000);
    const hb = (async () => {
      while (!ctl.signal.aborted) {
        await sleep(hbMs, ctl.signal);
        if (ctl.signal.aborted) return;
        try {
          const r = await api("POST", `/jobs/${job.id}/heartbeat`, { body: {}, timeoutMs: 15_000 });
          if (ctl.signal.aborted) return; // the reply raced the end of the job: nothing to act on
          if (r.status === 200 && r.body?.cancel === true) { log.info("job cancelled by server (superseded)", { job: job.id }); ctl.abort(new JobAbort("cancelled")); }
          else if (r.status === 200 && r.body?.done === true) return; // the server already holds this job's result: stop heartbeating quietly
          else if (r.status === 409 && r.body?.status === "done") return; // older servers answer 409 for a finished job
          else if (r.status === 409 || r.status === 404 || r.status === 410) { log.warn("lease lost", { job: job.id, status: r.status }); ctl.abort(new JobAbort("cancelled", "lease lost")); }
        } catch (e) {
          if (e instanceof Fatal) { ctl.abort(new JobAbort("cancelled")); halt(1); log.error(e.message); return; }
          log.warn("heartbeat failed", { job: job.id, err: (e as Error).message });
        }
      }
    })();
    try {
      const { result, calls, engine } = await produceResult(job, ctl.signal, log, { caps, options: engineOptions, blocked, local, ...(o.aiMode ? { aiMode: o.aiMode } : {}) });
      if (ctl.signal.aborted) { log.info("job cancelled; result discarded", { job: job.id }); return; }
      log.info("job produced result", { job: job.id, lane: result.lane, durationMs: now() - t0, engineCalls: calls, engine: engine.engine, model: engine.model ?? "default", findings: result.findings.length });
      await submit(job, result, ctl);
    } catch (e) {
      if (e instanceof Fatal) { halt(1); log.error(e.message); return; }
      const kind = e instanceof EngineError ? e.kind : e instanceof NackError ? "nack" : "error";
      if (kind === "cancelled") { log.info("job cancelled; engine stopped, nothing submitted", { job: job.id, durationMs: now() - t0 }); return; }
      const reason = kind === "timeout" ? `engine timeout after ${Math.round(timeoutMs / 1000)}s`
        : kind === "shutdown" ? "runner shutting down"
        : e instanceof EngineError || e instanceof NackError ? e.message : "runner internal error";
      if (kind === "error") log.error("job failed unexpectedly", { job: job.id, err: (e as Error).message.slice(0, 200) });
      await nack(job, reason, e instanceof NackError ? e.code : undefined).catch((n) => { if (n instanceof Fatal) { halt(1); log.error(n.message); } });
    } finally {
      clearTimeout(timer);
      ctl.abort(new JobAbort("cancelled", "done")); // stops the heartbeat loop
      await hb;
      inflight.delete(entry);
      log.info("job finished", { job: job.id, durationMs: now() - t0 });
    }
  }

  // ---- poll loop (one per concurrency slot) ----
  async function slot() {
    let failures = 0;
    while (!stopping()) {
      try { await maybeRotate(); await maybeAnnounce(); } catch (e) { if (e instanceof Fatal) { halt(1); log.error(e.message); return; } }
      if (stopping()) return;
      let res: ApiResponse;
      try { res = await api("GET", `/poll?wait=${o.waitS ?? 25}`, { signal: pollSignal, timeoutMs: ((o.waitS ?? 25) + 15) * 1000 }); }
      catch (e) {
        if (stopping()) return;
        if (e instanceof Fatal) { halt(1); log.error(e.message); return; }
        const d = delayFor(failures++);
        log.warn("poll failed (network); backing off", { delayMs: d, err: (e as Error).message });
        await sleep(d, pollSignal); continue;
      }
      if (res.status === 200 && res.body?.job && typeof res.body.job === "object") {
        failures = 0;
        const j = res.body.job as Record<string, unknown>;
        const lease = (res.body.lease ?? {}) as { heartbeatEveryS?: number };
        const job: LeasedJob = {
          id: String(j.id), repo: String(j.repo), pr: Number(j.pr), headSha: String(j.headSha), baseSha: typeof j.baseSha === "string" ? j.baseSha : null,
          mode: String(j.mode), attempt: Number(j.attempt ?? 1), payload: j.payload,
        };
        await handleJob(job, lease.heartbeatEveryS ?? 15);
        if (o.once) { halt(exitCode); return; }
        continue;
      }
      if (res.status === 204) {
        failures = 0;
        if (o.once) { log.info("no job available (--once); exiting"); halt(exitCode); return; }
        continue;
      }
      // 429, 5xx, 403 (suspended installation), anything unexpected: back off, honouring Retry-After
      const d = delayFor(failures++, res);
      log.warn("poll not successful; backing off", { status: res.status, code: errorCode(res), delayMs: d });
      await sleep(d, pollSignal);
    }
  }

  for (const [e, why] of Object.entries(blocked)) log.warn(`engine ${e} disabled: ${why}`);
  log.info("runner starting", { runner: cfg.runnerId, concurrency, url: cfg.url, version: VERSION, engines: caps.map((c) => `${c.engine}${c.defaultModel ? `:${c.defaultModel}` : ""}(${c.billing})`).join(",") || "none" });
  if (!caps.length) log.warn("no usable engine configured (glm needs a key); every job will be nacked as unsupported");
  const slots = Array.from({ length: concurrency }, () => slot());
  const grace = (async () => {
    await new Promise<void>((r) => {
      const any = AbortSignal.any([signal, stop.signal]);
      if (any.aborted) r(); else any.addEventListener("abort", () => r(), { once: true });
    });
    if (stop.signal.aborted || !signal.aborted) return;
    log.info("shutting down: no new jobs; waiting for in-flight jobs", { inflight: inflight.size, graceMs: o.shutdownGraceMs ?? 30_000 });
    await Promise.race([Promise.all(slots), sleep(o.shutdownGraceMs ?? 30_000, stop.signal)]);
    for (const j of inflight) j.ctl.abort(new JobAbort("shutdown"));
  })();
  await Promise.all(slots);
  stop.abort();
  await grace;
  log.info("runner stopped", { exitCode });
  return exitCode;
}
