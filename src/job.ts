/** Turns one leased job payload into a ReviewResult (schemaVersion 1) using the shared review engine. */
import type { ContextPiece, ContextSource } from "../core/context.js";
import { produceReviewResult, type ReviewResult } from "../core/review.js";
import type { LocalJobPayload, RunnerJobPayload } from "../core/protocol.js";
import { ENGINE_BILLING, MODEL_RE, resolveEngine, type EngineCap, type EngineName } from "../core/engines.js";
import { afterLocalJob, LocalCodeError, prepareLocalJob, type LocalCodeOptions } from "./localcode.js";
import { GitError } from "./git.js";
import { applyRunnerSecretHits } from "./secretscan.js";
import { applyReviewStyleEnv } from "./style.js";
import { EngineError, EngineProvider, type EngineId, type EngineOptions } from "./engine.js";
import type { Logger } from "./redact.js";

/** The runner cannot do this job; nack with `message` as the reason. `unsupported` = the wanted engine/model is not offered here: the job goes back to the queue for other runners without using an attempt. */
export class NackError extends Error {
  constructor(message: string, readonly code?: "unsupported") { super(message); }
}

/** What produceResult needs to pick and run an engine. */
export interface EngineContext {
  /** The runner's declared capabilities (default engine first). */
  caps: EngineCap[];
  /** Spawn options (bin, env, kill grace, api key) for an engine; the model is filled in from the resolved choice. */
  options: (engine: EngineId) => EngineOptions;
  /** Engines configured but unusable here, with the reason (a job asking for one is nacked unsupported). */
  blocked?: Record<string, string>;
  /** Local code source (paths, git remote, cache limits); set by the run loop. Needed for payload v2 jobs. */
  local?: LocalCodeOptions;
}

export interface LeasedJob { id: string; repo: string; pr: number; headSha: string; baseSha: string | null; mode: string; attempt: number; payload: unknown }

/** ContextSource over the pieces the Worker already gathered: reads come from the payload, nothing is fetched. */
export function piecesContextSource(pieces: ContextPiece[]): ContextSource {
  const by = new Map(pieces.map((p) => [p.path, p]));
  return {
    listPaths: async () => [...by.keys()],
    readFile: async (p) => by.get(p)?.content ?? null,
    searchSymbol: async (sym) => pieces.filter((p) => p.kind === "caller" && p.why.includes(sym)).map((p) => p.path),
  };
}

/** v1 = the Worker sent the diff and context; v2 + codeSource "local" = SHAs only, this runner reads its own clone. */
function checkPayload(job: LeasedJob): RunnerJobPayload | LocalJobPayload {
  const p = job.payload as { v?: number; codeSource?: string; pr?: unknown; cfg?: unknown; files?: unknown; policy?: unknown } | null;
  const v2 = p?.v === 2 && p.codeSource === "local";
  if (!p || typeof p !== "object" || (p.v !== 1 && !v2) || !p.pr || !p.cfg || !Array.isArray(p.files) || !p.policy) throw new NackError("unsupported job payload version or shape");
  return p as RunnerJobPayload | LocalJobPayload;
}

export async function produceResult(
  job: LeasedJob, signal: AbortSignal, log: Logger, ctx: EngineContext,
): Promise<{ result: ReviewResult; calls: number; engine: { engine: string; model: string | null } }> {
  const p = checkPayload(job);
  const isLocal = p.v === 2;
  const isDeep = job.mode === "deep" || job.mode === "deep-local" || p.mode === "deep";
  // Deep needs the Worker's retrieved context; without it (queued by an older Worker) a review would silently be diff-only.
  if (isDeep && !isLocal && !(p as RunnerJobPayload).deep) throw new NackError("deep job has no retrieved context (queued by an older Worker); the Worker must re-queue it");
  if (p.pr.number !== job.pr || p.pr.head.sha !== job.headSha) throw new NackError("job payload does not match the job (pr/head)");
  // A repo's explicit engine/model wins when this runner offers it; otherwise nack (job stays queued for other runners).
  const blocked = p.want?.engine ? ctx.blocked?.[p.want.engine] : undefined;
  if (blocked) throw new NackError(blocked, "unsupported");
  const picked = resolveEngine(ctx.caps, p.want ?? {});
  if (!picked.ok) throw new NackError(picked.reason, "unsupported");
  if (picked.model && !MODEL_RE.test(picked.model)) throw new NackError("the requested model name is not valid", "unsupported");
  let local: Awaited<ReturnType<typeof prepareLocalJob>> | null = null;
  if (isLocal) {
    if (!ctx.local) throw new NackError("this runner has no local code settings");
    if (!p.pr.base.sha) throw new NackError("local code job has no base commit");
    try {
      local = await prepareLocalJob(ctx.local, {
        owner: p.repo.owner, repo: p.repo.repo, prNumber: p.pr.number, baseSha: p.pr.base.sha, headSha: p.pr.head.sha, cfg: p.cfg, cfgRef: p.cfgRef,
      }, (m) => log.info(m.slice(0, 200), { job: job.id }), signal);
    } catch (e) {
      if (e instanceof LocalCodeError) throw new NackError(e.message);
      if (e instanceof GitError) throw new NackError(`local git failed: ${e.message}`);
      throw e;
    } finally {
      await afterLocalJob(ctx.local, p.repo.owner, p.repo.repo, (m) => log.info(m, { job: job.id }));
    }
    log.info("local code prepared", { job: job.id, files: local.files.length, pieces: local.pieces.length, notes: local.notes.length });
  }
  const files = local?.files ?? p.files;
  const policyFiles = local?.policyFiles ?? p.policyFiles;
  const pieces = local?.pieces ?? (p as RunnerJobPayload).context ?? [];
  const retrievedInfo = local ? { ok: true, notes: local.notes } : (p as RunnerJobPayload).deep;
  let bodyNotes: string[] = [];
  const engOpts = ctx.options(picked.engine as EngineId);
  // MERGEJUDGE_REVIEW_STYLE (runner side only) can switch the experimental style for a local run; an invalid value is ignored with a warning.
  const cfg = applyReviewStyleEnv(p.cfg, engOpts.env ?? process.env, (m) => log.warn(m, { job: job.id }));
  const provider = new EngineProvider(picked.engine as EngineId, signal, { ...engOpts, model: picked.model, style: cfg.review.style });
  const result = await produceReviewResult({
    pr: {
      number: p.pr.number, title: p.pr.title, body: p.pr.body, node_id: p.pr.node_id,
      head: { sha: p.pr.head.sha, ...(p.pr.head.ref ? { ref: p.pr.head.ref } : {}) },
      base: { ...(p.pr.base.ref ? { ref: p.pr.base.ref } : {}), ...(p.pr.base.sha ? { sha: p.pr.base.sha } : {}) },
      labels: p.pr.labels.map((name) => ({ name })),
      user: { login: p.pr.author ?? null, type: p.pr.authorType ?? null },
    },
    cfg, cfgRef: p.cfgRef, files, provider,
    ...(Array.isArray(p.learnedLines) ? { learnedLines: p.learnedLines.filter((l): l is string => typeof l === "string").slice(0, 40) } : {}), onNotes: (n) => { bodyNotes = n; },
    readRepoFile: async (path) => policyFiles[path] ?? null,
    contextSource: piecesContextSource(pieces),
    ...(isDeep && retrievedInfo ? { retrieved: { pieces, ok: retrievedInfo.ok, notes: retrievedInfo.notes.slice(0, 5).map((n) => n.slice(0, 300)) } } : {}),
    log: { info: (m) => log.info(m.length > 200 ? `${m.slice(0, 200)}…` : m, { job: job.id }), warning: (m) => log.warn(m.slice(0, 200), { job: job.id }) },
  });
  if (provider.fatal) throw provider.fatal;
  if (result.kind !== "review") throw new NackError(`runner cannot produce a "${result.kind}" result`);
  if (result.usage.mode === "rules-only") {
    // produceReviewResult swallows LLM failures into a rules-only result; a runner must not post that as a review.
    throw new EngineError("malformed", "engine output could not be parsed as a triage result");
  }
  result.usage = { ...result.usage, model: provider.label, engine: picked.engine, engineModel: picked.model, billing: ENGINE_BILLING[picked.engine as EngineName] };
  if (local?.secrets.hits.size) {
    const n = applyRunnerSecretHits(result, local.secrets.hits, { policyFiles: p.policy.used, notes: bodyNotes, approval: p.cfg.approval });
    if (n) log.warn("local secret scan raised file(s) to block", { job: job.id, files: n });
  }
  return { result, calls: provider.calls, engine: { engine: picked.engine, model: picked.model } };
}
