// GitHub Action entry point. Runs inside the user's own Actions runner; built into action/index.cjs by `npm run build:action`.
import * as core from "@actions/core";
import * as github from "@actions/github";
import { appJwt, installationToken } from "../core/appauth.js";
import { applyProviderOverrides, parseConfig, type Config } from "../core/config.js";
import { fetchBaseConfig, type Octokit, type Repo } from "../core/github.js";
import { runFeedback, runPropose, type FeedbackPayload } from "../core/learnflow.js";
import { ACTION_MARKER } from "../core/render.js";
import { runReview, type ReviewPr } from "../core/review.js";
import { createProvider } from "../core/llm/index.js";
import { routeAutoMode } from "../core/shepherdroute.js";
import { RULE } from "../core/shepherdrules.js";
import { isShepherdOn } from "../core/shepherd.js";
import { handOff, runShepherd, type ShepherdCtx, type ShepherdPayload } from "./shepherd.js";
import { redact, redactedLogs } from "./redact.js";
import { explicitReviewMode, withAiMode } from "./deep.js";
import { securityRequested, withSecurityMode } from "./security.js";
import { retrieveFromWorkspace, WorkspaceError } from "./workspace.js";
import { branchStoryImage } from "../core/storyhost.js";

/** Secrets seen this run. Action log lines are redacted with these plus the shared token/header patterns. */
const secretSink: string[] = [];
function remember(value: string | undefined): void {
  if (value && value.length >= 6 && !secretSink.includes(value)) secretSink.push(value);
}
function logs() {
  return redactedLogs({ info: (m) => core.info(m), warning: (m) => core.warning(m) }, secretSink);
}

async function auth(): Promise<{ ok: Octokit; repo: Repo; appToken: boolean; botLogin: string | null; token: string }> {
  const repo = github.context.repo;
  const appId = core.getInput("app_id");
  const appKey = core.getInput("app_private_key");
  let token = core.getInput("github_token", { required: true });
  remember(token);
  remember(appKey);
  let appToken = false;
  let botLogin: string | null = null;
  if (appId && appKey) {
    try {
      token = await installationToken(appId, appKey, repo.owner, repo.repo, { apiUrl: process.env.GITHUB_API_URL });
      remember(token);
      core.setSecret(token);
      appToken = true;
      logs().info("Using GitHub App installation token.");
    } catch (e) {
      logs().warning(`GitHub App token failed (${(e as Error).message}); falling back to github_token.`);
    }
  }
  const ok = github.getOctokit(token);
  if (appToken) {
    try {
      const app = await github.getOctokit(appJwt(appId, appKey)).rest.apps.getAuthenticated();
      if (app.data?.slug) botLogin = `${app.data.slug}[bot]`;
    } catch { /* optional */ }
  }
  return { ok, repo, appToken, botLogin, token };
}

async function loadCfg(ok: Octokit, repo: Repo, base: { ref?: string; sha?: string }): Promise<{ cfg: Config; cfgRef: string }> {
  const cfgPath = core.getInput("config_path") || ".mergejudge.yml";
  const log = logs();
  const { text, ref: cfgRef } = await fetchBaseConfig(ok, repo, cfgPath, base, log.warning);
  log.info(`Config ${cfgPath} read from base ${cfgRef}.`);
  const security = securityRequested(text);
  if (security) log.info("review.security is on: adding the security rubric pack.");
  let cfg = applyProviderOverrides(withSecurityMode(parseConfig(text), security), {
    type: core.getInput("provider"),
    base_url: core.getInput("base_url"),
    model: core.getInput("model"),
    api_key_env: core.getInput("api_key_env"),
  });
  // review_mode (Actions sets INPUT_REVIEW_MODE), then MERGEJUDGE_MODE. Empty leaves ai.mode from the base branch.
  const reviewMode = explicitReviewMode({
    reviewMode: core.getInput("review_mode") || process.env.INPUT_REVIEW_MODE,
    env: process.env,
  });
  if (reviewMode) {
    cfg = withAiMode(cfg, reviewMode);
    log.info(`AI review mode ${reviewMode} from review_mode, MERGEJUDGE_MODE or INPUT_REVIEW_MODE.`);
  } else if (cfg.ai.mode === "deep") {
    log.info("AI review mode deep from .mergejudge.yml (ai.mode).");
  }
  if (text === null) log.info(`No ${cfgPath} on base; using defaults.`);
  return { cfg, cfgRef };
}

async function runTriageMode(): Promise<void> {
  const pr = github.context.payload.pull_request;
  const log = logs();
  if (!pr) { log.info("Not a pull_request event; nothing to do."); return; }
  const { ok, repo, appToken, botLogin } = await auth();
  const { cfg, cfgRef } = await loadCfg(ok, repo, { ref: pr.base?.ref, sha: pr.base?.sha });
  const storyImage = cfg.comment.flow_chart && cfg.comment.flow_chart_host === "branch"
    ? await branchStoryImage(ok, repo, github.context.payload.repository?.private, log) : undefined;
  const lane = await runReview({
    storyImage,
    ok, repo, pr: pr as unknown as ReviewPr, cfg, cfgRef, appToken, botLogin,
    // The hosted App may review the same PR: post under the Action's own marker and only ever touch its own
    // comments and threads, so the two summaries, round counters and answer gates stay separate.
    owner: { marker: ACTION_MARKER, login: botLogin ?? "github-actions[bot]" },
    configPaths: [core.getInput("config_path")].filter(Boolean),
    // review.mode: deep reads the repo from the actions/checkout workspace; without one it falls back to context mode.
    retrieveDeep: async (kept) => {
      const dir = process.env.GITHUB_WORKSPACE;
      if (!dir) throw new WorkspaceError("GITHUB_WORKSPACE is not set");
      return retrieveFromWorkspace(dir, kept, cfg, `${repo.owner}/${repo.repo}`, log.info);
    },
    log,
    // Shepherd L3: the review flags lines in a file Shepherd's own head commit touched. Hand off instead of posting them.
    onShepherdPingPong: async (findings, touched) => {
      if (!isShepherdOn(pr.labels)) return;
      const shepherd = await shepherdCtx(log);
      const paths = [...new Set(findings.map((f) => f.path))].filter((p) => touched.includes(p));
      await handOff(shepherd, pr.number, { rule: RULE.L3, reason: `the review flags lines in files Shepherd's last fix commit touched (${paths.slice(0, 3).join(", ")})`, paths });
    },
  });
  core.setOutput("lane", lane);
}

async function shepherdCtx(log: ReturnType<typeof logs>): Promise<ShepherdCtx> {
  const { ok, repo, botLogin, token } = await auth();
  const defaultBranch = github.context.payload.repository?.default_branch ?? "main";
  // Policy comes from the BASE branch of the PR (the default branch for comment events).
  const pl = github.context.payload;
  let base: { ref?: string; sha?: string } | undefined = pl.pull_request?.base ?? pl.workflow_run?.pull_requests?.[0]?.base ?? pl.check_suite?.pull_requests?.[0]?.base;
  // A push to a base branch (the conflict sweep): that branch's config applies. schedule and workflow_dispatch use the default branch.
  const pushed = github.context.eventName === "push" ? /^refs\/heads\/(.+)$/.exec(String(pl.ref ?? ""))?.[1] : undefined;
  if (!base && pushed) base = { ref: pushed };
  if (!base && pl.issue?.number) {
    try { base = (await ok.rest.pulls.get({ ...repo, pull_number: pl.issue.number })).data.base; } catch { /* default branch */ }
  }
  const { cfg } = await loadCfg(ok, repo, { ref: base?.ref ?? defaultBranch, sha: base?.sha });
  const { provider, note } = createProvider(cfg.provider, process.env);
  if (!provider && note) log.info(`Shepherd has no model (${note}); only shepherd_fix_command fixes are possible.`);
  return {
    ok, repo, cfg, log, token, botLogin, provider,
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    serverUrl: process.env.GITHUB_SERVER_URL,
    identity: { name: core.getInput("shepherd_commit_name") || "mergejudge-shepherd[bot]", email: core.getInput("shepherd_commit_email") || "mergejudge-shepherd[bot]@users.noreply.github.com" },
    fixCommand: core.getInput("shepherd_fix_command") || undefined,
    self: { name: process.env.GITHUB_WORKFLOW, ref: process.env.GITHUB_WORKFLOW_REF, runId: process.env.GITHUB_RUN_ID },
    onSecret: (s) => { remember(s); core.setSecret(s); },
  };
}

async function runShepherdMode(): Promise<void> {
  const log = logs();
  const ctx = await shepherdCtx(log);
  core.setSecret(ctx.token);
  await runShepherd(ctx, github.context.eventName, github.context.payload as ShepherdPayload);
}

async function runFeedbackMode(): Promise<void> {
  const { ok, repo } = await auth();
  const defaultBranch = github.context.payload.repository?.default_branch ?? "main";
  await runFeedback({
    ok, repo, payload: github.context.payload as FeedbackPayload, defaultBranch,
    loadConfig: async () => (await loadCfg(ok, repo, { ref: defaultBranch })).cfg,
    log: logs(),
  });
}

async function runProposeMode(): Promise<void> {
  const { ok, repo } = await auth();
  const defaultBranch = github.context.payload.repository?.default_branch ?? "main";
  const { cfg } = await loadCfg(ok, repo, { ref: defaultBranch });
  const pr = await runPropose({ ok, repo, cfg, defaultBranch, log: logs() });
  if (pr) core.setOutput("proposal_pr", String(pr));
}

async function run(): Promise<void> {
  const modeIn = (core.getInput("mode") || "auto").toLowerCase();
  const event = github.context.eventName;
  let mode = modeIn;
  if (mode === "auto") mode = routeAutoMode(event, github.context.payload as Parameters<typeof routeAutoMode>[1]);
  logs().info(`MergeJudge mode=${mode} event=${event}`);
  if (mode === "shepherd") await runShepherdMode();
  else if (mode === "feedback") await runFeedbackMode();
  else if (mode === "propose") await runProposeMode();
  else await runTriageMode();
}

run().catch((e) => core.setFailed(redact(e instanceof Error ? e.message : String(e), secretSink)));
