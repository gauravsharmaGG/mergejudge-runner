// GitHub Action entry point. Runs inside the user's own Actions runner; built into action/index.cjs by `npm run build:action`.
import * as core from "@actions/core";
import * as github from "@actions/github";
import { appJwt, installationToken } from "../core/appauth.js";
import { applyProviderOverrides, parseConfig, type Config } from "../core/config.js";
import { fetchBaseConfig, type Octokit, type Repo } from "../core/github.js";
import { runFeedback, runPropose, type FeedbackPayload } from "../core/learnflow.js";
import { runReview, type ReviewPr } from "../core/review.js";
import { redact, redactedLogs } from "./redact.js";
import { applyReviewStyleEnv } from "./style.js";
import { retrieveFromWorkspace, WorkspaceError } from "./workspace.js";

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
  let cfg = applyProviderOverrides(parseConfig(text), {
    type: core.getInput("provider"),
    base_url: core.getInput("base_url"),
    model: core.getInput("model"),
    api_key_env: core.getInput("api_key_env"),
  });
  cfg = applyReviewStyleEnv(cfg, process.env, log.warning);
  if (text === null) log.info(`No ${cfgPath} on base; using defaults.`);
  return { cfg, cfgRef };
}

async function runTriageMode(): Promise<void> {
  const pr = github.context.payload.pull_request;
  const log = logs();
  if (!pr) { log.info("Not a pull_request event; nothing to do."); return; }
  const { ok, repo, appToken, botLogin } = await auth();
  const { cfg, cfgRef } = await loadCfg(ok, repo, { ref: pr.base?.ref, sha: pr.base?.sha });
  const lane = await runReview({
    ok, repo, pr: pr as unknown as ReviewPr, cfg, cfgRef, appToken, botLogin,
    configPaths: [core.getInput("config_path")].filter(Boolean),
    // review.mode: deep reads the repo from the actions/checkout workspace; without one it falls back to context mode.
    retrieveDeep: async (kept) => {
      const dir = process.env.GITHUB_WORKSPACE;
      if (!dir) throw new WorkspaceError("GITHUB_WORKSPACE is not set");
      return retrieveFromWorkspace(dir, kept, cfg, `${repo.owner}/${repo.repo}`, log.info);
    },
    log,
  });
  core.setOutput("lane", lane);
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
  if (mode === "auto") {
    if (event === "issue_comment") mode = "feedback";
    else if (event === "schedule" || event === "workflow_dispatch") mode = "propose";
    else mode = "triage";
  }
  logs().info(`MergeJudge mode=${mode} event=${event}`);
  if (mode === "feedback") await runFeedbackMode();
  else if (mode === "propose") await runProposeMode();
  else await runTriageMode();
}

run().catch((e) => core.setFailed(redact(e instanceof Error ? e.message : String(e), secretSink)));
