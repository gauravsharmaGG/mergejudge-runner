import { aggregate, explainLane, type Aggregate } from "./aggregate.js";
import { applyApproval } from "./approval.js";
import type { Config } from "./config.js";
import type { Lane, PrFile } from "./types.js";
import {
  approvePr, createCheckRun, dismissOwnApprovals, enableAutoMerge, fetchPrFiles, fetchRepoFile, UNLISTED_FILES_PATH,
  syncInlineFindings, upsertStickyComment, githubContextSource, type Octokit, type Repo,
} from "./github.js";
import { applyLearned, type LearnedItem } from "./falsealarm.js";
import { buildLearnedContext, renderLearnedSection, type LearnedInput } from "./learnedctx.js";
import { isLearningBranchHead, isProposalBranchHead } from "./learning.js";
import { deepTools, runDeepTriage } from "./deep.js";
import { prepareDeepIndex, type DeepEnv } from "./deepsetup.js";
import { createProvider, type LlmCallUsage, type WorkersAiBinding } from "./llm/index.js";
import type { LlmProvider } from "./llm/provider.js";
import { canUseTools } from "./llm/provider.js";
import { filterPolicyPaths, loadPolicies, type Policies } from "./policy.js";
import { CHECK_NAME, EMOJI, renderComment } from "./render.js";
import { selectCriteria } from "./rubrics.js";
import { excludeFromLlm, isMergeJudgeConfigPath } from "./rules.js";
import { gatherContext, type ContextPiece, type ContextSource } from "./context.js";
import { runSingle } from "./single.js";
import { DELIM, runTriage, type Finding, type TokenBreakdown, type TriageResult } from "./triage.js";

/** Rules-only note when the model call or its JSON could not be used. The class only: no provider body, no model text. */
export function aiUnavailableNote(errorClass: string, truncated = false): string {
  return truncated
    ? `AI review unavailable (${errorClass}). Output was cut off at the token limit.`
    : `AI review unavailable (${errorClass}).`;
}

/** The subset of a pull_request webhook payload the review needs. */
export interface ReviewPr {
  number: number;
  title?: string | null;
  body?: string | null;
  node_id: string;
  head: { sha: string; ref?: string };
  base?: { ref?: string; sha?: string };
  labels?: { name: string }[];
  /** PR author as GitHub reports it (login, user type). Trusted, unlike the body; feeds pr_template / trusted_authors. */
  user?: { login?: string | null; type?: string | null } | null;
}

export interface ReviewInput {
  ok: Octokit;
  repo: Repo;
  pr: ReviewPr;
  cfg: Config;
  cfgRef: string;
  appToken: boolean;
  botLogin: string | null;
  /** Where the provider API key is looked up (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Why the key was withheld (Worker key policy); shown instead of the generic "env X not set" note. */
  keyNote?: string;
  /** Note shown when no AI provider is configured (the caller supplies the wording). */
  noProviderNote?: string;
  /** Neutral caller notes included in the review summary. */
  reviewNotes?: string[];
  /** Hosted callers only: AI is skipped for this review (kill switch or PR too large). Rules-only; this neutral line is the one note shown. */
  skipAi?: string;
  /** Custom config file path(s) (Action `config_path`) treated like `.mergejudge.yml`: always review, never bot-approved. */
  configPaths?: string[];
  /** Hosted callers only: called with the listed files for a hosted-AI review; a returned note skips the model like `skipAi`. */
  skipAiGate?: (files: PrFile[]) => string | null;
  /** Hosted callers only: stop listing after this many files (the rest is represented by one unlisted-files entry, so the lane can only rise). Unset = list everything (Action, CLI). */
  maxListFiles?: number;
  /** Called once with what was decided and spent (the Worker records usage). */
  onResult?: (r: ReviewOutcome) => void | Promise<void>;
  /** Called once with the final lane, the aggregate behind it and the reviewer id (the Worker records outcomes against it). Never changes a lane. */
  onSnapshot?: (s: ReviewSnapshot) => void | Promise<void>;
  /** Override how context-mode files are fetched (tests). Defaults to the GitHub API at the head SHA. */
  contextSource?: ContextSource;
  /** Worker-only bindings, e.g. Cloudflare Workers AI (`provider.type: workers-ai`). */
  bindings?: { ai?: WorkersAiBinding };
  /** Per-repo known false alarms (Worker/D1). Shapes the prompt and downgrades/hides repeats; never changes a lane. */
  learned?: LearnedItem[];
  /** Writer lessons and outcome hints for the prompt's team-preferences section (context only; see src/learnedctx.ts). */
  lessons?: LearnedInput["lessons"];
  outcomeStats?: LearnedInput["outcomeStats"];
  /** Called for every model call as it happens (the Worker records tokens and cost, even if the review later fails). */
  onLlmCall?: (c: LlmCallUsage) => void;
  /**
   * Index and file access for `review.mode: deep` (Worker only). Without it, or when the provider cannot call
   * tools, deep falls back to context mode and says so.
   */
  deep?: DeepEnv;
  /**
   * Deep mode from a local checkout (the Action): called once with the files sent to the model, returns the context to read
   * next to the diff (single pass, no tool calls). Throw to fall back to context mode; the message becomes the note.
   */
  retrieveDeep?: (kept: PrFile[]) => Promise<{ pieces: ContextPiece[]; notes: string[] }>;
  log: { info: (m: string) => void; warning: (m: string) => void };
  /**
   * Optional cache of the LLM result for this PR head (the Worker uses KV). On a hit the LLM is not
   * called and inline findings are left as they are; lanes, labels, summary, check and approval are
   * recomputed. Used for label-only changes.
   */
  llmCache?: { get(): Promise<CachedTriage | null>; put(v: CachedTriage): Promise<void> };
}

export interface ReviewSnapshot {
  lane: "auto" | "review" | "block";
  agg: Pick<Aggregate, "files" | "labelReasons" | "rubric">;
  headSha: string;
  reviewer: string;
}

export interface ReviewOutcome {
  lane: "auto" | "review" | "block";
  mode: "diff" | "context" | "deep" | "rules-only";
  model: string | null;
  cached: boolean;
  breakdown: TokenBreakdown | null;
  /** Runner reviews only: the engine and model that produced the review, and how it is billed. */
  engine?: string;
  engineModel?: string | null;
  billing?: "subscription" | "api-key";
  /** Set to "single" only when the experimental single-shot style produced the review (absent = triage). */
  style?: "single";
}

export interface CachedTriage {
  llm: NonNullable<TriageResult["llm"]>;
  tokens: number;
  breakdown: TokenBreakdown;
  policiesUsed: Policies["used"];
  /** Set to "single" for the experimental style; absent = triage. A cached result is only reused for the same style. */
  style?: "single";
}

/**
 * Everything the poster needs, as plain JSON (no Maps, no functions), so a runner can later send it over
 * /runner/v1. Produced by `produceReviewResult` (no GitHub writes), consumed by `postReviewResult`.
 */
export interface ReviewResult {
  schemaVersion: 1;
  /** "learning-block": head is the learning branch, LLM skipped; only comment + check are posted. */
  kind: "review" | "learning-block";
  prNumber: number;
  headSha: string;
  /** GraphQL node id, for native auto-merge. */
  prNodeId: string;
  lane: Lane;
  /** Per-file verdicts, label reasons, summary and rubric (drives the check run). */
  agg: Aggregate;
  /** Rendered sticky-comment body. */
  body: string;
  /** LLM findings (inline and file-level); empty without an LLM result. */
  findings: Finding[];
  /** True when inline findings should be synced (fresh LLM result, not a cache hit). */
  syncInline: boolean;
  usage: ReviewOutcome & { tokens: number };
}

export interface ProduceInput {
  /** "owner/repo#pr" for log lines; defaults to "#pr". */
  ref?: string;
  pr: ReviewPr;
  cfg: Config;
  cfgRef: string;
  /** Already-fetched PR files. */
  files: PrFile[];
  /** Custom config file path(s), as in ReviewInput.configPaths. */
  configPaths?: string[];
  /** Result of createProvider; `providerNote` is its note when no provider could be built. */
  provider: LlmProvider | null;
  providerNote?: string;
  /** Why the key was withheld (Worker key policy); shown instead of the generic note. */
  keyNote?: string;
  /** Note shown when no AI provider is configured (the caller supplies the wording). */
  noProviderNote?: string;
  /** Neutral caller notes included in the review summary. */
  reviewNotes?: string[];
  /** Hosted callers only: AI was skipped (`provider` is null); rendered as the single note instead of "LLM disabled (...)". */
  skipAi?: string;
  /** Read-only repo file access at cfgRef (policy files). */
  readRepoFile: (path: string, ref: string) => Promise<string | null>;
  /** Read-only context-mode file access at the head SHA. */
  contextSource: ContextSource;
  deep?: DeepEnv;
  retrieveDeep?: ReviewInput["retrieveDeep"];
  /**
   * Deep mode for a provider without tools (runners): context the Worker already retrieved from its index. `ok` = it came
   * from the index (reported as deep, single pass); otherwise it is plain context-mode pieces and `notes` says why.
   */
  retrieved?: { pieces: ContextPiece[]; ok: boolean; notes: string[] };
  learned?: LearnedItem[];
  lessons?: LearnedInput["lessons"];
  outcomeStats?: LearnedInput["outcomeStats"];
  /** Section lines the Worker built for a runner job (already defanged; re-sanitised here). Wins over learned/lessons/outcomeStats. */
  learnedLines?: string[];
  log: ReviewInput["log"];
  llmCache?: ReviewInput["llmCache"];
  /** Receives the notes rendered into the comment body, so a caller that re-renders the body (runner secret scan) can keep them. */
  onNotes?: (notes: string[]) => void;
}

/** Turn fetched inputs into a ReviewResult. Reads (via the injected callbacks) and LLM calls only; never writes to GitHub. */
export async function produceReviewResult(o: ProduceInput): Promise<ReviewResult> {
  const { pr, cfg, cfgRef, files, provider, log } = o;
  const number: number = pr.number;
  const notes: string[] = [...(o.reviewNotes ?? [])];

  if (isLearningBranchHead(pr.head?.ref, cfg.learning.branch)) {
    const proposal = isProposalBranchHead(pr.head?.ref);
    const reason = proposal ? "learning proposal: only a human may merge it" : "learning branch `" + cfg.learning.branch + "` must never be merged";
    const agg: Aggregate = {
      lane: "block",
      files: [],
      labelReasons: [reason],
      summary: proposal
        ? "This PR is a MergeJudge learning proposal (suggested config/rubric edits). It is always `block`: a human must read the diff and decide."
        : "This PR's head is `" + cfg.learning.branch + "`, which holds MergeJudge learning data and must never be merged.",
      rubric: [],
    };
    agg.explanation = explainLane(agg);
    const body = renderComment({
      agg, mode: "rules-only", tokensEstimate: 0, approval: cfg.approval, notes: [proposal ? "Head is a learning proposal branch — LLM skipped." : "Head is the learning branch — LLM skipped."],
    });
    return {
      schemaVersion: 1, kind: "learning-block", prNumber: number, headSha: pr.head.sha, prNodeId: pr.node_id,
      lane: "block", agg, body, findings: [], syncInline: false,
      usage: { lane: "block", mode: "rules-only", model: null, cached: false, breakdown: null, tokens: 0 },
    };
  }

  const labels: string[] = (pr.labels ?? []).map((l: { name: string }) => l.name);

  if (o.skipAi) notes.push(o.skipAi);
  else if (o.providerNote && cfg.provider.type !== "none") notes.push(`LLM disabled (${(!provider && o.keyNote) || o.providerNote}); rules-only.`);
  if (o.noProviderNote && !o.skipAi && cfg.provider.type === "none" && !provider) notes.push(o.noProviderNote);
  let llm = null;
  let policies: Policies = { text: "", used: [], skipped: [] };
  let tokens = 0;
  let usedMode: "diff" | "context" | "deep" = cfg.review.mode;
  let breakdown = null as null | import("./triage.js").TokenBreakdown;
  const single = cfg.review.style === "single";
  // A cached result is only reused for the style that produced it (entries without `style` are triage).
  const cachedAny = provider && o.llmCache ? await o.llmCache.get().catch(() => null) : null;
  const cached = cachedAny && (cachedAny.style === "single") === single ? cachedAny : null;
  if (cached) {
    llm = cached.llm;
    tokens = cached.tokens;
    breakdown = cached.breakdown;
    policies = { text: "", used: cached.policiesUsed, skipped: [] };
    log.info(`Re-using LLM result for head ${pr.head.sha.slice(0, 7)} (no LLM call).`);
  } else if (provider) {
    const paths = filterPolicyPaths(cfg.policy_files, cfg.policy_exclude);
    policies = paths.length
      ? await loadPolicies(paths, (p) => o.readRepoFile(p, cfgRef), {
          each: cfg.policy.max_each_bytes, total: cfg.policy.max_total_bytes,
        })
      : { text: "", used: [], skipped: [] };
    if (policies.used.length) log.info(`Policy files: ${policies.used.map((u) => u.path).join(", ")}${policies.used.some((u) => u.truncated) ? " (truncated)" : ""}`);
    if (policies.skipped.length) log.info(`Policy files not found or empty: ${policies.skipped.join(", ")}`);
    else if (!cfg.policy_files.length) log.info("Policy files disabled (policy_files: []).");
    const criteria = cfg.rubrics.enabled ? selectCriteria(cfg.rubrics.packs, cfg.rubrics.custom, cfg.rubrics.notes) : [];
    const { kept, skipped } = excludeFromLlm(files, cfg.diff_exclude);
    if (skipped.length) log.info(`Diff excluded from LLM (${skipped.length}): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? "…" : ""}`);
    let context: ContextPiece[] | undefined;
    let mode: "diff" | "context" | "deep" = cfg.review.mode;
    let tools: ReturnType<typeof deepTools> | undefined;
    let retrievedDeep = false;
    let retrieved = mode === "deep" ? o.retrieved : undefined;
    if (single) {
      notes.push("Experimental single-shot review style.");
      if (mode === "deep") notes.push("Experimental single-shot review: deep tool loop skipped.");
    }
    if (mode === "deep" && !retrieved && o.retrieveDeep) {
      try {
        const r = await o.retrieveDeep(kept);
        retrieved = { pieces: r.pieces, ok: true, notes: r.notes };
      } catch (e) {
        const why = (e as Error).message;
        notes.push(`Deep mode unavailable (${why}); used context mode.`);
        log.warning(`deep mode: ${why}; falling back to context`);
        mode = "context";
      }
    }
    if (mode === "deep" && retrieved) {
      mode = "context";
      context = retrieved.pieces;
      retrievedDeep = retrieved.ok;
      notes.push(...retrieved.notes);
    } else if (mode === "deep" && single) {
      mode = "context"; // no tool loop in the single style: gather context like context mode
    } else if (mode === "deep") {
      const fallback = (why: string) => {
        mode = "context";
        notes.push(`Deep mode unavailable (${why}); used context mode.`);
        log.warning(`deep mode: ${why}; falling back to context`);
      };
      if (!canUseTools(provider)) fallback(`${provider.label} cannot call tools`);
      else if (!o.deep) fallback("needs the hosted indexer");
      else {
        const skip = (p: string) => excludeFromLlm([{ path: p }], cfg.diff_exclude).skipped.length > 0;
        const prep = await prepareDeepIndex({ ...o.deep, policy: cfg.index.policy }, kept, log.info)
          .catch(() => ({ ok: false as const, reason: "index error" }));
        if (!prep.ok) fallback(prep.reason);
        else {
          for (const n of prep.notes) log.info(`deep: ${n}`);
          if (prep.partial) notes.push(`Deep mode ${prep.partial}.`);
          tools = deepTools({ snap: prep.snap, readFile: (p) => o.deep!.head.readFile(p), skip, semantic: prep.semantic });
        }
      }
    }
    if (mode === "context" && !context) {
      const src = o.contextSource;
      const skip = (p: string) => excludeFromLlm([{ path: p }], cfg.diff_exclude).skipped.length > 0;
      const g = await gatherContext(kept, src, { ...cfg.context, skip }, log.info);
      context = g.pieces;
    }
    const prompt = { title: pr.title ?? "", body: pr.body ?? "", files: kept, context };
    const tctx = { policyText: policies.text, criteria, learnedText: cfg.learning.enabled ? (o.learnedLines ? renderLearnedSection(o.learnedLines, DELIM) : buildLearnedContext({ learned: o.learned, lessons: o.lessons, outcomeStats: o.outcomeStats }, DELIM)) : "", skippedDiffFiles: skipped, ref: o.ref ?? `#${pr.number}` };
    const res = single
      ? await runSingle(provider, prompt, cfg, tctx, log.info, log.warning)
      : mode === "deep" && tools && canUseTools(provider)
      ? await runDeepTriage(provider, prompt, cfg, tctx, { tools }, log.info, log.warning)
      : await runTriage(provider, prompt, cfg, tctx, log.info, log.warning);
    usedMode = retrievedDeep ? "deep" : mode;
    tokens = res.tokensEstimate;
    llm = res.llm;
    breakdown = res.breakdown;
    log.info(
      `Tokens ~${res.breakdown.total} (system ${res.breakdown.system} · policy ${res.breakdown.policy} · rubric ${res.breakdown.rubric} · diff ${res.breakdown.diff}${res.breakdown.context ? ` · context ${res.breakdown.context}` : ""}${res.breakdown.tools ? ` · tools ${res.breakdown.tools} (${res.breakdown.tool_calls} calls)` : ""} · out ${res.breakdown.output}) · mode ${mode}` +
        (res.retried ? " · JSON repair retry used" : ""),
    );
    if (!llm) notes.push(aiUnavailableNote(res.error ?? "parse", res.truncated === true));
    else if (o.llmCache) {
      await o.llmCache.put({ llm, tokens, breakdown: res.breakdown, policiesUsed: policies.used, ...(single ? { style: "single" as const } : {}) })
        .catch((e) => log.warning(`Could not cache LLM result: ${(e as Error).message}`));
    }
  }

  const agg = aggregate(files, labels, cfg, llm, { body: pr.body ?? null, user: pr.user ?? null, configPaths: o.configPaths });
  // Known false alarms: hide or fold repeats of patterns reviewers keep dismissing. Lanes, labels and rubric stay as aggregated.
  let findings = llm?.findings ?? [];
  if (llm && cfg.learning.enabled && o.learned?.length) {
    const block = new Set([...llm.files].filter(([, v]) => v.lane === "block").map(([p]) => p));
    const res = applyLearned(findings, o.learned, block);
    findings = [...res.kept, ...res.downgraded.map((f): Finding => ({ path: f.path, message: `(dismissed before in this repo) ${f.message}` }))];
    if (res.suppressed.length || res.downgraded.length)
      notes.push(`Known false alarms in this repo: ${res.suppressed.length} finding(s) hidden, ${res.downgraded.length} listed without an inline comment (manage them in the MergeJudge panel).`);
  }
  o.onNotes?.([...notes]);
  const body = renderComment({
    agg, mode: llm && provider ? provider.label : "rules-only", tokensEstimate: tokens, notes,
    policyFiles: policies.used, fileFindings: findings.filter((f) => f.line === undefined),
    breakdown: breakdown ?? undefined, approval: cfg.approval,
  });
  return {
    schemaVersion: 1, kind: "review", prNumber: number, headSha: pr.head.sha, prNodeId: pr.node_id,
    lane: agg.lane, agg, body, findings, syncInline: !!llm && !cached,
    usage: {
      lane: agg.lane, mode: llm && provider ? usedMode : "rules-only", model: provider?.label ?? null,
      cached: !!cached, breakdown, tokens, ...(single && llm ? { style: "single" as const } : {}),
    },
  };
}

export interface PostContext {
  ok: Octokit;
  repo: Repo;
  cfg: Config;
  appToken: boolean;
  botLogin: string | null;
  /** Custom config file path(s), as in ReviewInput.configPaths. */
  configPaths?: string[];
  log: ReviewInput["log"];
  onResult?: ReviewInput["onResult"];
  /** Called with the final lane and aggregate after everything is posted (the Worker records what drove the lane). */
  onSnapshot?: ReviewInput["onSnapshot"];
}

/** Added to the sticky comment when the `mergejudge/lane` check run could not be created. */
export function checkFallbackNote(lane: Lane, status?: number): string {
  return `> ℹ️ The \`${CHECK_NAME}\` check run could not be created${status ? ` (HTTP ${status})` : ""}, usually because the token is read-only (for example on a fork PR) or lacks \`checks: write\`. Lane: ${EMOJI[lane]} \`${lane}\`. A branch rule that requires this check will not see it.`;
}

/** Perform every GitHub write for a ReviewResult: sticky comment, check run, inline findings, approval. */
export async function postReviewResult(r: ReviewResult, c: PostContext): Promise<Lane> {
  const { ok, repo, cfg, log } = c;
  await upsertStickyComment(ok, repo, r.prNumber, r.body);
  try {
    await createCheckRun(ok, repo, r.headSha, r.agg);
  } catch (e) {
    // A refusal (403 read-only token on fork PRs or no `checks: write`, 404/422 unknown commit) is permanent and must not
    // fail the whole review: the lane goes into the sticky comment instead. Anything else (5xx, network) still throws, so
    // the Worker's runner flow keeps retrying a post that did not complete.
    const status = (e as { status?: number }).status;
    if (status !== 403 && status !== 404 && status !== 422) throw e;
    log.warning(`Could not create the ${CHECK_NAME} check run (${status ?? "error"}: ${(e as Error).message}); the lane is in the PR comment instead.`);
    try {
      await upsertStickyComment(ok, repo, r.prNumber, `${r.body}\n\n${checkFallbackNote(r.lane, status)}`);
    } catch (e2) { log.warning(`Could not update the PR comment either: ${(e2 as Error).message}`); }
  }
  if (r.kind === "learning-block") {
    log.info("Blocked: head ref is learning branch " + cfg.learning.branch + ".");
    return "block";
  }
  if (r.syncInline) {
    try {
      const plan = await syncInlineFindings(ok, repo, r.prNumber, r.headSha, r.findings, log.warning, log.info, `${r.usage.mode}:${r.usage.model ?? "rules-only"}`);
      log.info(`Inline findings: ${plan.create.length} new, ${plan.update.length} updated/resolved.`);
    } catch (e) {
      log.warning(`Could not post inline findings: ${(e as Error).message}`);
    }
  }
  await applyApproval(
    cfg.approval, r.lane,
    {
      enableAutoMerge: (m) => enableAutoMerge(ok, r.prNodeId, m),
      approve: () => approvePr(ok, repo, r.prNumber),
      dismissOwnApprovals: (msg) => dismissOwnApprovals(ok, repo, r.prNumber, c.botLogin, msg),
    },
    log.info,
    { appToken: c.appToken, configChange: r.agg.files.some((f) => f.configFile || isMergeJudgeConfigPath(f.path, c.configPaths)) },
  );
  if (c.onSnapshot) {
    try {
      await c.onSnapshot({ lane: r.lane, agg: r.agg, headSha: r.headSha, reviewer: `${r.usage.mode}:${r.usage.model ?? "rules-only"}` });
    } catch (e) { log.warning(`onSnapshot failed: ${(e as Error).message}`); }
  }
  if (c.onResult) {
    const { tokens: _t, ...outcome } = r.usage;
    await Promise.resolve(c.onResult(outcome)).catch((e) => log.warning(`onResult failed: ${(e as Error).message}`));
  }
  return r.lane;
}

/**
 * Run one diff-mode review of a PR and post the sticky summary, check run, inline findings and
 * approval. Shared by the GitHub Action (src/main.ts) and the Worker (packages/worker).
 * = fetch inputs, `produceReviewResult`, `postReviewResult`.
 */
export async function runReview(o: ReviewInput): Promise<"auto" | "review" | "block"> {
  const { ok, repo, pr, cfg, cfgRef } = o;
  const env = o.env ?? process.env;
  const learning = isLearningBranchHead(pr.head?.ref, cfg.learning.branch);
  const files = learning ? [] : await fetchPrFiles(ok, repo, pr.number, o.maxListFiles);
  const unlisted = files.some((f) => f.path === UNLISTED_FILES_PATH);
  const skipAi = learning ? undefined : o.skipAi ?? o.skipAiGate?.(files) ?? undefined;
  const reviewNotes = unlisted && !skipAi ? [...(o.reviewNotes ?? []), `This PR has more than ${o.maxListFiles} files; only the first ${o.maxListFiles} were checked and the lane is at least review.`] : o.reviewNotes;
  const { provider, note } = learning || skipAi ? { provider: null, note: undefined } : createProvider(cfg.provider, env, { ...o.bindings, onCall: o.onLlmCall });
  const result = await produceReviewResult({
    ref: `${repo.owner}/${repo.repo}#${pr.number}`,
    pr, cfg, cfgRef, files, configPaths: o.configPaths, provider, providerNote: note, keyNote: o.keyNote, noProviderNote: o.noProviderNote, reviewNotes, skipAi,
    readRepoFile: (p, ref) => fetchRepoFile(ok, repo, p, ref),
    contextSource: o.contextSource ?? githubContextSource(ok, repo, pr.head.sha),
    deep: o.deep, retrieveDeep: o.retrieveDeep, learned: o.learned, lessons: o.lessons, outcomeStats: o.outcomeStats, log: o.log, llmCache: o.llmCache,
  });
  return postReviewResult(result, {
    ok, repo, cfg, appToken: o.appToken, botLogin: o.botLogin, configPaths: o.configPaths, log: o.log, onResult: o.onResult, onSnapshot: o.onSnapshot,
  });
}

/** JSON round-trip for CachedTriage (llm.files is a Map). */
export function encodeCachedTriage(v: CachedTriage): string {
  return JSON.stringify({ ...v, llm: { ...v.llm, files: [...v.llm.files.entries()] } });
}
export function decodeCachedTriage(s: string): CachedTriage {
  const v = JSON.parse(s);
  return { ...v, llm: { ...v.llm, files: new Map(v.llm.files) } };
}
