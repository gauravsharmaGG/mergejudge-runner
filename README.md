# MergeJudge AI Code Review: GitHub Action and runner

**Open-source AI pull request review for GitHub.** MergeJudge sorts every pull request into one of three lanes, `auto`, `review` or `block`. It posts a summary, line comments and a `mergejudge/lane` check. Deterministic rules set the floor, and by default the AI step can only make a lane stricter. You **bring your own AI key** (Anthropic, OpenAI, z.ai or any OpenAI-compatible endpoint), or run it rules-only with no key.

- **Runs in your own GitHub Actions runner.** The Action doesn't call the MergeJudge service and doesn't need an account.
- **Follows your repo's rules.** It reads `AGENTS.md`, `REVIEW_POLICY.md` and `.mergejudge.yml`, always from the base branch, so a PR can't loosen its own review.
- **Deep mode.** It adds the callers, imports and related files of the changed code from your checkout.
- **Learns from feedback.** Checkbox feedback and `/mergejudge learn` notes become a proposal PR (opened from a schedule you set, once enough feedback has built up) that a human reviews and merges. MergeJudge never approves or merges its own proposals.
- **MIT licensed.**

Docs: **[mergejudge.si](https://mergejudge.si)** · [GitHub Action guide](https://mergejudge.si/guide/github-action) · [Config reference](https://mergejudge.si/guide/config)

## See it on real PRs

Real MergeJudge reviews on a public demo repo, no install needed:

- `auto` (docs typo fix): https://github.com/gauravsharmaGG/mergejudge-demo/pull/2
- `review` (change to a workflow file, a protected path): https://github.com/gauravsharmaGG/mergejudge-demo/pull/3
- `block` (hard-coded API key): https://github.com/gauravsharmaGG/mergejudge-demo/pull/4

Auto means low risk, not a guarantee. Your branch protection and required checks still apply, and MergeJudge doesn't merge pull requests itself.

## Quick start

1. Add your AI key as a repository secret, for example `AI_API_KEY` (Settings → Secrets and variables → Actions). Skip this for rules-only.
2. Add `.github/workflows/mergejudge.yml`:

```yaml
name: MergeJudge
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  lane:
    runs-on: ubuntu-latest
    steps:
      - uses: gauravsharmaGG/mergejudge-runner@v1
        env:
          AI_API_KEY: ${{ secrets.AI_API_KEY }}   # omit for rules-only
        with:
          provider: anthropic          # or openai, zai, openai-compatible, none
          model: your-model-name
          api_key_env: AI_API_KEY
```

`AI_API_KEY` is your own Anthropic, OpenAI or z.ai key, stored as a GitHub secret. MergeJudge doesn't issue keys. Leave it out for free rules-only reviews.

The secret name is up to you: `api_key_env` names the variable to read, so existing setups that use `MJ_API_KEY` keep working unchanged.

3. Open a pull request. MergeJudge posts the lane, a summary and line comments.

No `.mergejudge.yml` is needed to start, because built-in defaults apply. For learning (feedback plus the proposal PR), deep mode and fork PRs, see [GitHub Action](#github-action) below.

## Where your code goes

The Action reads the PR diff from the GitHub API. If you configure a provider, it sends the diff, the PR title and body, your policy files and (in context or deep mode) related code snippets to **that provider, using your key**. Nothing goes to MergeJudge's servers. With `provider: none` there is no AI call.

## Other ways to run MergeJudge

- **Hosted GitHub App:** no workflow file, with your provider key stored in the panel. [Install the App](https://github.com/apps/mergejudge) · [guide](https://mergejudge.si/guide/cloud)
- **Runner:** the hosted service, with the AI step running on your own machine using your Claude Code, Codex or GLM login. See [The runner](#the-runner-for-the-hosted-mergejudge-service) below.

## The runner (for the hosted MergeJudge service)

Runs the AI step of a [MergeJudge](https://mergejudge.si) review on **your own machine**, with your own Claude Code or Codex (ChatGPT) login, or a GLM (z.ai) API key. The MergeJudge service keeps handling GitHub events, lanes, the panel and posting; the runner connects **out** over HTTPS (protocol `/runner/v1`), takes review jobs, and sends back a result. No inbound ports.

The runner is not standalone: it connects to the MergeJudge service and needs the MergeJudge GitHub App installed on the GitHub account or organisation whose pull requests it should review. You sign in with GitHub to register it (or use an enrollment code from the MergeJudge panel). This repository contains the open-source runner (MIT) and the review core it bundles.

## Privacy: what MergeJudge's servers see

**With deep-local mode** (`review.mode: deep` and `runner.code_source: local`, see below), the AI review runs on your machine with your own AI login and reads your code from your own git clone. The AI step and code index run on your machine. Our servers still read the pull request diff from GitHub to run the rule checks, and don't store it. They keep only the review result: the lane, the reasons, the summary and the findings. Findings can quote short lines of code. This is the same text that's posted on your pull request.

**In the default diff and context modes**, the hosted service passes the PR diff, your policy files and related code snippets to your runner through its job queue, so they are held on our servers until the review finishes, and deleted within about 48 hours at the latest. Choose deep-local (`review.mode: deep` and `runner.code_source: local`) to run the AI step and code index on your machine instead. When AI review is on, your code is sent to your own AI provider under your own account.

Details: https://mergejudge.si/privacy

## GitHub Action

This repository also contains a GitHub Action (`action.yml`) that sorts pull requests into `auto`, `review` and `block` lanes using deterministic rules plus an optional AI review. It is separate from the runner above and does not need a MergeJudge account.

**Where it runs.** The whole review runs inside your own GitHub Actions runner. The Action does not call the hosted MergeJudge service. It talks to the GitHub API with the token you give it and, only if you configure an AI provider, sends the pull request diff to that provider (the one you set in `.mergejudge.yml` or the `provider` input) using your own key. With `provider: none`, or no provider configured, the review is rules-only and the diff goes nowhere except GitHub.

```yaml
# .github/workflows/mergejudge.yml
name: MergeJudge
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created, edited]
  schedule:
    # Weekly proposal: Mondays 09:00 UTC (adjust as you like).
    - cron: "0 9 * * 1"
  workflow_dispatch: {}
permissions:
  contents: write          # store lessons + open the proposal PR
  pull-requests: write
  checks: write
jobs:
  lane:
    # Skip noisy issue_comment events that are not MergeJudge feedback (saves minutes).
    if: >
      github.event_name != 'issue_comment' ||
      contains(github.event.comment.body, 'MergeJudge') ||
      startsWith(github.event.comment.body, '/mergejudge')
    runs-on: ubuntu-latest
    steps:
      - uses: gauravsharmaGG/mergejudge-runner@v1
        env:
          # Bring your own key: store it as a repository secret and name it here.
          # Omit (or set provider: none) for rules-only reviews.
          AI_API_KEY: ${{ secrets.AI_API_KEY }}
        with:
          provider: anthropic          # or openai-compatible, or none for rules-only
          model: your-model-name
          api_key_env: AI_API_KEY
```

No `actions/checkout` step is needed for the default modes (add one for deep mode, below): the Action reads `.mergejudge.yml` from the pull request's base branch through the API, and reads the diff from the API. Without a config file it uses built-in defaults.

**How learning works in the Action**

1. **Signals (feedback).** On `issue_comment` (created/edited), mode `feedback` records a lesson when a write-access human ticks the feedback checkboxes on the MergeJudge sticky comment, or posts `/mergejudge learn …`. Lessons are appended to `lessons/lessons.jsonl` on the `mergejudge-learning` branch (created from the default branch on first write). Merge or revert alone does **not** create Action lessons — those outcomes are a hosted-Worker path. The Action only learns from explicit feedback on the PR.
2. **Weekly proposal.** On `schedule` or `workflow_dispatch`, mode `propose` reads those lessons and, when there are enough (`learning.propose_after`, default 10), opens or updates a PR (`mergejudge/proposal-learning` → default branch) that may suggest guarded edits to `.mergejudge.yml` (more protected paths / prompt notes only) plus a report file. Labels: `do-not-merge`, `needs-human`.
3. **Permissions.** Learning needs `contents: write` and `pull-requests: write`. GitHub's default `GITHUB_TOKEN` cannot open PRs unless the repository setting **Allow GitHub Actions to create and approve pull requests** is on (Settings → Actions → General → Workflow permissions).

- **Inputs.** `github_token` (defaults to the workflow token), `app_id` / `app_private_key` (optional GitHub App credentials), `mode` (`auto` | `triage` | `feedback` | `propose`), `config_path`, `provider`, `base_url`, `model`, `api_key_env`. Outputs: `lane`, `proposal_pr`.
- **Config changes.** Changes to `.mergejudge.yml` always go to review, and are never auto-merged or bot-approved.
- **Security mode (`review.security: true`, optional, off by default).** Set a real boolean `true` under `review:` in `.mergejudge.yml` (read from the base branch) and the AI review also scores a short security pack of five high-severity checks: `sec.audit.injection` (untrusted input reaching sinks), `sec.audit.authz`, `sec.audit.secrets-crypto`, `sec.audit.callbacks` (SSRF and webhook verification) and `sec.audit.ai-tools` (only when the change touches agents, tools or prompts). They run ahead of your own `rubrics.custom` criteria, turn rubrics on even if you disabled them, and do not change which built-in packs are selected. As with every rubric check, a failure only counts when it quotes the changed code, and it raises the lane to review. Without the key, or with `false` or a non-boolean value such as `"true"`, nothing changes. Action only for now: the hosted runner does not read this key.
- **Lane choice map (`review.lane_map: true`, test build, off by default).** Add `lane_map: true` under `review:` in `.mergejudge.yml` and the sticky comment gains a "Lane choice map": a leading why-this-lane sentence naming the raisers, whole-PR auto/review/block counts, a directory bucket table, and an expanded file table ordered by raisers, other review/block files, then auto files (up to 100 rows, with an overflow notice). Mermaid is no longer embedded. It only explains the lane: the PR lane and the `mergejudge/lane` check (`review` neutral, `block` fails) are unchanged, and with the flag off the comment is identical to before. No other config is needed. `buildLaneMapGif` (`core/lanemap.ts`) renders a small animated GIF of the same path; the comment embeds it with a decision-path caption above the markdown only when a host passes an https `laneMapImageUrl`, and adds a "Deeper view in MergeJudge panel" link only when a `panelUrl` is passed, so the comment stands alone without either.
- **Modes.** `auto` (default) picks from the event: `pull_request` → triage, `issue_comment` → feedback, `schedule` / `workflow_dispatch` → propose. All three modes are available in this Action.
- **Deep mode (`review.mode: deep`).** Add an `actions/checkout` step before MergeJudge. The Action then indexes the checked-out files in memory (for this run only), finds what the changed code touches (importers, imports, callers, files that mention changed names, strings and env var names, two hops out) and sends those snippets to your AI provider next to the diff, in a single pass (no tool calls). Nothing goes to any MergeJudge server: with the Action everything runs on your GitHub runner and the code goes to the provider you chose with your own key. Without a usable checkout (no `actions/checkout` step, an empty workspace) it falls back to context mode (files read through the GitHub API) and the review says so. With `provider: none` there is no AI step at all. Limits: tracked files only; `.env`, key files, lockfiles, `node_modules`, binaries and files over 100 KB are never read; symlinks are never followed; at most 5,000 files / 50 MB / 2 minutes are indexed (a partial index is reported). The config and policy files are still read from the PR base, not from the checkout.

  ```yaml
  steps:
    - uses: actions/checkout@v4    # for pull_request this is the merge of head and base
    - uses: gauravsharmaGG/mergejudge-runner@v1
      env: { AI_API_KEY: "${{ secrets.AI_API_KEY }}" }
      with: { provider: anthropic, model: your-model-name, api_key_env: AI_API_KEY }
  ```

  Permissions: `contents: read` is enough for the checkout (the learning modes need `contents: write`, see above). Use the `pull_request` event. Do **not** use `pull_request_target` with a checkout of the PR head, since that runs untrusted code with secrets. Fork pull requests get a read-only token and no secrets, so there is no key for the AI and the review falls back to rules-only (see below). Set `review.mode: deep` in `.mergejudge.yml` on the base branch.
- **Fork pull requests.** For `pull_request` events from forks, GitHub gives the workflow a read-only token and no secrets. If the `mergejudge/lane` check run cannot be created (no `checks: write`), the lane is added to the PR comment instead. Posting the comment itself still needs `pull-requests: write`, which a fork token lacks, so that step fails. To avoid failures on forks, run the Action only for same-repository branches (`if: github.event.pull_request.head.repo.full_name == github.repository` on the job).
- **Build.** The Action runs the committed bundle `action/index.cjs` on Node 24, built from `src/action.ts` and `core/` with `npm run build:action`. A test fails if the committed bundle is out of date.

## Install

Needs Node >= 20 and, for the default engine, the [Claude Code](https://code.claude.com/docs/en/quickstart) CLI (`claude`), logged in.

```sh
npm i -g mergejudge-runner
mergejudge-runner setup          # sign in with GitHub, then pick engines and auto-start
```

`setup` prints a short code and an address (`https://github.com/login/device`); open it, enter the code and approve the MergeJudge GitHub App. If you have several installations, pass `--installation <id>` (in a terminal you can also pick from a list). The alternative is an enrollment code from the panel (Runners > Add runner): `mergejudge-runner setup <code>`.

`setup` registers the runner (sign-in or code), detects which of `claude` and `codex` are installed and signed in (`claude auth status`, `codex login status`; Codex counts only when signed in **with ChatGPT**, an API-key login is reported as not signed in and codex is not offered), asks yes/no about a GLM (z.ai) API key, and offers to start it at login (launchd / systemd user unit). It prints one line per engine (`claude-code`, `codex`, `glm`): `ready`, `installed, not signed in` (with the reason) or `not found`, with a one-line install or sign-in hint for each one that is not ready; GLM is ready when you gave a key, otherwise it reads `no API key (optional; z.ai bills per use)`. If no engine is ready it says so and still registers with `claude-code` as the default. If more than one is ready and setup runs in a terminal, it asks which should be the default (Enter = the first) and keeps the others enabled; without a terminal, or with `--engine`, it does not ask. When a binary is not on `PATH`, setup also looks in the npm global prefix (`npm_config_prefix`, when set), `CODEX_INSTALL_DIR` (codex), `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, says where it found it, and stores that path in the config. `login` and `register` use the same detection when you do not pass `--engine` (every ready engine is enabled, the first is the default, no question is asked). `run` and `status` print a note when an engine is ready on this machine but missing from the config (`mergejudge-runner setup --force` adds it); they never change the config. Claude Code, Codex and z.ai are used under your own account and your own agreement with Anthropic, OpenAI or z.ai; MergeJudge isn't part of that. Flags: `--yes`, `--no-autostart`, `--print-unit`, `--engine <claude-code|codex|glm>`, `--model [engine=]<model>` (repeatable), `--codex-effort <minimal|low|medium|high|xhigh>` (default `low`; stored as `engines.codex.effort` in the config), `--glm-key-env NAME`, `--no-glm`; `MERGEJUDGE_URL` overrides the server (default `https://app.mergejudge.si`). Without a global install, `npx mergejudge-runner setup` works too.

## Register

**Sign in with GitHub (default).** `mergejudge-runner login` (also run by `setup` when you give no code) uses GitHub's device flow: it shows a code and an address, waits while you approve the MergeJudge GitHub App in your browser, then registers this machine and saves the config. Options: `--name`, `--installation <id>` (needed when you have several installations and no terminal to pick in), `--url`, `--force`, plus the engine flags of `register`. If the App is not installed yet, the command prints the install address. The sign-in attempt lasts a few minutes; run the command again if it expires. Your GitHub login token is never given to the runner; only the runner's own token is stored.

```sh
mergejudge-runner login --name my-mac
```

**With an enrollment code (alternative).** Create an enrollment code in the MergeJudge panel (valid 15 minutes, single use), then:

```sh
mergejudge-runner register --code mjr_e_... --url https://app.mergejudge.si --name my-mac
```

This stores the runner id and token in `$XDG_CONFIG_HOME/mergejudge-runner/config.json` (default `~/.config/...`). The directory is `0700`, the file `0600`, written atomically. The runner **refuses to start** if the file is readable by group or others. Only `https://` URLs are accepted (`http://` only for localhost). Use `--force` to replace an existing registration, `--claude-bin /path/to/claude` to pin the binary.

## Engines and models

| Engine | What runs | Billing |
|---|---|---|
| `claude-code` | `claude -p --tools ""` on your subscription | subscription |
| `codex` | `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never --ignore-user-config [-m MODEL] -c model_reasoning_effort=EFFORT --output-schema <file> -o <file> -` (prompt on stdin, ChatGPT login) | subscription |
| `glm` | `claude -p` with `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` and `ANTHROPIC_AUTH_TOKEN=<your key>` set only in the child env | **API key (billed per use)** |

- The runner declares its engines, billing and models when it registers and on the runner heartbeat at every start. The config keeps `engine` (default), `engines: { name: { model, models } }` and, for GLM, `glmApiKey` (config is `0600`; `ZAI_API_KEY` in the environment works too). `models: ["*"]` offers any model.
- A repo can ask for an engine/model in the panel or in `.mergejudge.yml` (`runner.engine`, `runner.model`; the panel wins). If this runner does not offer it, the job is nacked with `code: "unsupported"` and a reason, no attempt is used, and it stays queued for other runners.
- A 0.1.0 config (no `engines`) keeps working as `claude-code` with the default model.
- Codex needs a ChatGPT sign-in: at startup the runner runs `codex login status` and drops codex from its capabilities on an API-key login or no login; a codex job that still arrives is nacked `unsupported` with that reason.
- Never passed to any engine: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, the runner token. The z.ai key is only in the GLM child's env and is masked in logs.

## Run

```sh
mergejudge-runner run                 # long-poll forever
mergejudge-runner run --once          # handle one job (or exit if none is waiting), then exit
mergejudge-runner run --concurrency 2 # capped by the concurrency registered with the server
```

- Heartbeats every <= 20 s while a job runs (lease is 60 s). If the server answers `cancel: true` (a newer push superseded the job) or the lease is lost, the `claude` process tree is killed and nothing is submitted.
- Per-job timeout 10 min (`--job-timeout-min`); on timeout the process tree is killed and the job is nacked.
- Errors (bad engine output, crash, unsupported job) are **nacked** with a short reason; the server retries up to its limit.
- Network errors, 5xx and 429 back off exponentially with jitter; `Retry-After` is honoured.
- Model calls (Action and API engines: OpenAI, Anthropic, z.ai, OpenAI-compatible, Workers AI) are bounded: 120 s per attempt (`provider.timeout_ms`, max 180 s), at most 1 retry after an attempt times out (`provider.max_timeout_retries`), up to 2 retries for network errors, HTTP 408, 429 and 5xx (`provider.max_retries`), and 240 s per call including retries and waits (`provider.budget_ms`, max 300 s). Env `MERGEJUDGE_LLM_TIMEOUT_MS`, `MERGEJUDGE_LLM_MAX_RETRIES`, `MERGEJUDGE_LLM_MAX_TIMEOUT_RETRIES`, `MERGEJUDGE_LLM_BUDGET_MS` and `MERGEJUDGE_LLM_MAX_DELAY_MS` override them. Deep mode stops tool use at `deep.max_seconds` and caps every model call so the whole loop ends within `deep.max_seconds` + 240 s (6 min by default, inside the 10-minute job). On failure the PR comment says only `AI review unavailable (<class>)`.
- `SIGINT`/`SIGTERM`: stop polling, give in-flight jobs 30 s to finish, then kill the engine and nack them ("runner shutting down") and exit. A second signal exits immediately.
- The access token is rotated through `/token/rotate` when it has < 14 days left (or when a response carries an `x-mergejudge-rotate` header). The new token is written to the config file (atomic rename) **before** it is used.
- Modes: `diff`, `context` and `deep`. **Deep on a runner is a single pass**: the Worker builds a temporary index of the repo (the index is not stored, no hosted AI), looks up callers, importers and imports of the changed code (two hops out, hop 1 first), plus files that reference strings, object keys and env var names the diff changed or removed, and sends them as context with the job. The engine still runs with no tools and no checkout, so it cannot browse further. The temporary index is read most-related-first: the changed files, then their imports and the files in the same directories that import them, then the other files in those directories, then the parent directories, then files that mention the changed names, strings or env var names, then everything else. If the repo is too big to index in full (size, file or time limit), the review uses the partial index and says so ("Deep: used a partial index (N files, most related first; size limit reached)."). It falls back to `context` and says so only when almost nothing related could be indexed: fewer than 3 files from those first stages, or none of the changed files that already exist could be indexed. Runners older than 0.3.0 do not advertise `deep`, so they are never offered such jobs; upgrade and restart to receive them. With `runner.code_source: local` the runner reads its own clone instead; see below.

## Local code (deep-local: the AI step and code index run on your machine) — runner 0.4.0

By default (`runner.code_source: worker`) the Worker reads the repo through the GitHub API and sends the diff and context with the job. With `code_source: local` in the repo's `.mergejudge.yml` (read from the base commit):

```yaml
review:
  mode: deep
runner:
  code_source: local
```

the job carries only the repo, PR number, base/head SHAs, the config and the rules result. **No diff, no context, no file contents, no token.** The runner reads the code itself:

1. keeps a persistent **partial bare clone** per repo, `~/.mergejudge/repos/<owner>__<repo>.git` (`git clone --bare --filter=blob:none`), and fetches the job's base and head SHAs;
2. computes the PR diff locally (`git diff base...head`, renames detected, `diff_exclude` respected);
3. builds an index of the base commit (symbols, import graph, code chunks) over `git ls-tree` / `git cat-file`, saved at `~/.mergejudge/idx/<owner>__<repo>/<sha>.json`. The next job on the repo updates it incrementally from the git diff between the saved commit and the new base; the PR's own changes are overlaid in memory. There is no 300-file cap (by default up to 20,000 files, 200 MB read, 15 min; see **Index limits** below). A repo bigger than that is indexed most-related-first around the PR's changed files; that partial index is used for this review and is **not saved** (it is biased to this PR), so the next PR on that repo builds its own. Complete indexes are saved and reused;
4. retrieves callers, importers and imports of the changed code, reviews in one pass with your engine, and sends back only the structured result (verdict, findings, comments).

**Git access.** The runner uses the machine's own git credentials, nothing from MergeJudge. Make sure `git clone https://github.com/<owner>/<repo>.git` works for the user that runs the runner (`gh auth setup-git`, a credential helper, or a deploy key). For SSH or a mirror, set a remote URL template with `{owner}` and `{repo}`:

```sh
MERGEJUDGE_REMOTE_URL_TEMPLATE='git@github.com:{owner}/{repo}.git' mergejudge-runner run
mergejudge-runner run --remote-url-template 'https://git.example.com/{owner}/{repo}.git'
```

(precedence: flag, environment, `localCode.remoteUrlTemplate` in the config file, default `https://github.com/{owner}/{repo}.git`). If git cannot read the repo, the job **fails with an explicit message** ("cannot read owner/repo with this runner's own git access ...", shown on the PR); it never silently falls back to a diff-only review. Private-repo credentials are never logged; URLs in errors are scrubbed.

**Cache.** `MERGEJUDGE_HOME` moves everything (default `~/.mergejudge`). After each job the runner keeps the newest **3** index snapshots per repo, evicts repos untouched for **30 days**, and, when `repos/` + `idx/` exceed **5 GB**, evicts the least recently used repos. Tune with `MERGEJUDGE_CACHE_MAX_GB`, `MERGEJUDGE_CACHE_KEEP_SNAPSHOTS`, `MERGEJUDGE_CACHE_MAX_AGE_DAYS`, `--cache-max-gb`, or `localCode` in the config file. An evicted repo is simply cloned and indexed again on its next job. Jobs on the same repo run one after another (lock); different repos run in parallel.

**Index limits.** Only you, the runner owner, can change how much the runner reads when it builds an index; the repository's `.mergejudge.yml` cannot (repo content is untrusted on your machine). Precedence: flag, environment, config file, default. Values outside the range are clamped, invalid ones are ignored.

| Limit | Default | Allowed range | Environment | Flag | Config file (`localCode`) |
|---|---|---|---|---|---|
| Files | 20,000 | 1,000 to 100,000 | `MERGEJUDGE_LOCAL_INDEX_MAX_FILES` | `--local-index-max-files` | `indexMaxFiles` |
| Megabytes read | 200 | 10 to 1,000 | `MERGEJUDGE_LOCAL_INDEX_MAX_MB` | `--local-index-max-mb` | `indexMaxMb` |
| Seconds | 900 | 30 to 1,800 | `MERGEJUDGE_LOCAL_INDEX_MAX_SECONDS` | `--local-index-max-seconds` | `indexMaxSeconds` |

When a limit stops the build, the review says "Deep mode used a partial index (N files, most related first; size limit reached); not saved for other pull requests."

**Compatibility.** The runner announces `features: ["local-code"]` at start and on every heartbeat. The Worker only sends the SHAs-only payload to a runner that announced it and was seen in the last 10 minutes; otherwise (older runner, none online) it uses the 0.3.0 path (the Worker builds the context). A 0.4.0 runner still handles those old-style jobs. The panel and `.mergejudge.yml` stay unchanged for repos that do not set `code_source: local`.

The repo's contents stay on your disk: both the clone and the snapshots (which contain code chunks) live under `MERGEJUDGE_HOME`. The Worker also skips building its own R2/Vectorize index for such repos.

## Status

```sh
mergejudge-runner status
```

Prints the config (token shown as its first 10 characters only), whether the Worker is reachable, and the result of a runner-level heartbeat (which also extends the leases the Worker holds for this runner).

## Keep it running

- macOS: [examples/si.mergejudge.runner.plist](examples/si.mergejudge.runner.plist) (LaunchAgent, `KeepAlive`, logs to `~/Library/Logs`). It contains no secrets.
- Linux: a systemd user unit with `ExecStart=node /path/to/dist/cli.js run`, `Restart=always`, `TimeoutStopSec=45`.

Logs go to stderr.

## Security notes

- **Use your own login, for your own repos.** The `claude-code` engine uses *your* Claude subscription login on *your* machine. Do not share one subscription with a team or run it for an organisation; check the terms of your Claude plan, and prefer API-key engines where they apply. This is not legal advice.
- **`ANTHROPIC_API_KEY` must stay unset.** If it is set, Claude Code bills the API instead of your subscription. The runner never passes it (or `ANTHROPIC_AUTH_TOKEN`, any `MERGEJUDGE_*`, `OPENAI_*`, `GITHUB_*`, `AWS_*`, the runner token) to `claude`. The child gets a minimal allowlist copy of the environment (`PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_*`, `CLAUDE_CONFIG_DIR`, proxy and CA variables, `CLAUDE_CODE_OAUTH_TOKEN` for `claude setup-token` logins). Unset `ANTHROPIC_API_KEY` in your own shell/service too, so `claude` is not confused by your global setup.
- **PR content is untrusted.** The prompt goes to `claude -p` on **stdin** (never argv, so it is not visible in `ps`), the CLI runs with `--tools ""` (no tools at all), an empty temp directory as cwd, no session persistence, and no slash commands. The model can only answer with text, which the shared parser validates; the server then applies its own floor (a runner can raise a lane, never lower it).
- **Token storage.** The runner token (`mjr_a_...`) is a bearer credential for your installation's review jobs. It lives only in the 0600 config file; it is never logged (logs hold job ids, repo/PR numbers, durations and sizes; a redaction filter masks token shapes as a safety net) and never passed to the engine. Revoke or rotate it in the panel if a machine is lost. The runner follows no redirects, so the token cannot be forwarded to another origin.
- **What the runner sees.** Job payloads contain the PR diff, title/body, the repo's policy files and (context mode) related files. Nothing is written to disk by the runner except the config file (and, in local-code mode, the clone and index cache).
- The `claude` process runs as you. Run the runner under a dedicated OS user if you do not want PR text processed in your main account.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Build from source

```sh
git clone https://github.com/gauravsharmaGG/mergejudge-runner && cd mergejudge-runner
npm ci
npm run verify                  # typecheck + tests + build
node dist/cli.js --help
```

`src/` is the runner (plus `src/action.ts`, the GitHub Action entry point); `core/` is the shared review code (rules, prompts, parsing, result format) vendored from the MergeJudge core, so the prompt, JSON parsing and result format are identical to the service. `core/` is synced by maintainers; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quiet by default, and requiring the check

AI line comments are posted inline only when the finding includes a quote of the diff line that verifies against the PR diff. Findings without a verifiable quote are not posted inline; they are listed in the summary comment under "❔ Needs human", with a count. No config is needed.

The summary also explains the `mergejudge/lane` check: `review` is advisory (the check concludes `neutral`), and only `block` fails it. To make `block` stop merges, require the check `mergejudge/lane` in branch protection or rulesets.

## Changelog

- **0.6.0**: the Action can run an optional security review: set `review.security: true` under `review:` in `.mergejudge.yml` (off by default) to also score the `sec.audit.*` checks. Includes the 0.5.2 docs changes (API key secret documented as `AI_API_KEY`). Action only; the hosted runner does not read this key.
- **0.5.2**: docs only: the API key secret is now documented as `AI_API_KEY` (your own provider key); `MJ_API_KEY` still works. No engine changes.
- **0.5.1**: model calls are bounded: 120 s per attempt, at most 1 retry after a timeout, up to 2 retries for network errors, HTTP 408, 429 and 5xx, 240 s per call (`provider.timeout_ms`, `max_timeout_retries`, `max_retries`, `budget_ms`, `max_delay_ms`, or the `MERGEJUDGE_LLM_*` env vars); deep mode caps each call so the loop ends within `deep.max_seconds` + 240 s; on failure the PR comment says only `AI review unavailable (<class>)`, and provider bodies, model text and git stderr stay out of logs; runner and Action logs share one redaction filter.
- **0.5.0**: with `lanes.code_auto`, small test-only changes (test files and test folders that only add or adjust tests) can now go auto; the PR comment shows the AI's short reason for files that need review or are blocked; "Why this lane?" no longer repeats the same reason in a details block.
- **0.4.9**: the runner finds Codex and Claude Code on its own during setup; deep mode reads the files most related to the pull request first and can review with a partial index on big repositories (new `--local-index-max-*` limits for local code); changes to `.mergejudge.yml` always go to review; fix for turning on GitHub auto-merge with `approval.mode: auto-merge-only`; optional learning from human review comments (`learning.from_comments`, off by default); footer wording about merging.
- **0.4.8**: `mergejudge-runner login` — sign in with GitHub (device flow) so you can start the runner without the panel enrollment code. Needs Device Flow enabled on the MergeJudge GitHub App.

See the GitHub releases.

- **0.4.7**: first release from this public repository. Package links, description and README updated. The code is identical to 0.4.6.
- **0.4.6**: PR template check and trusted authors rules (both only ever raise a lane; the Worker's server floor re-applies them).
- **0.4.5**: policy files share the total budget fairly; truncation is reported.

## Licence

[MIT](LICENSE)

Claude Code, Codex, GLM, Anthropic, OpenAI and z.ai are trademarks of their owners. MergeJudge isn't affiliated with them or with GitHub.
