# Changelog

Release notes for `mergejudge-runner`. Versions below match `package.json`, `src/version.ts`, and `git log`. The public repository starts at 0.4.6.

`auto` means low risk, not a guarantee.

## Unreleased

- **Optional "Where it sits" strip.** `comment.where_it_sits: true` adds a collapsed table under the PR story listing, for up to five changed code files, which files import them and which files they import, and flags importers that use an export the PR removed. It uses import lines and code search only (no AI call), is off by default, and never changes lanes or findings.
- **`REVIEW.md` is a default policy file.** `policy_files` now defaults to `REVIEW_POLICY.md`, `REVIEW.md`, `APPROVAL_POLICY.md`, `AGENTS.md`, `CLAUDE.md` (read from the base branch, same caps). A missing `REVIEW.md` only adds its name to the existing "Policy files missing or empty" line. An explicit `policy_files` list still replaces the defaults. Example template: `examples/REVIEW.md` (evidence rule and a nit cap).
- **Default `budget.max_tokens_per_pr` raised from 28000 to 40000.** Set it explicitly in `.mergejudge.yml` to keep the old cap.
- **Big PRs: fair diff sharing, honest "Not checked", one cumulative token cap.** (1) The review prompt shares the diff budget fairly (short patches whole, long ones cut at hunk boundaries) instead of an even split, marks each cut patch with `[... truncated by MergeJudge: K of N diff lines not shown; code outside the shown hunks exists and was not reviewed ...]`, and, only when something was cut, adds a note after the data block telling the model not to report a symbol as undefined or a function as unused from a truncated patch. Prompts for PRs that fit are byte-identical to before. The comment lists the trimmed files under "Not checked"; `ReviewResult.trimmedFiles` carries them (additive). (2) The PR story diff gives every file a header (path, status, previous name, +/-) and shares its 24000 characters by file kind (code, then tests, docs and config, lockfiles last); the story prompt says when it was trimmed and the comment shows one line. (3) A failed story call (cut off, timed out, invalid reply, provider error, budget) now shows one line under "Not checked"; reasoning models get a 4000-token story cap (1200 otherwise). (4) `budget.max_tokens_per_pr` is cumulative over the review, its retry, the second pass and the story, measured on provider-reported usage when available. A call that would pass the cap is skipped and listed under "Not checked", and the footer counts the retry. A retry now happens only when the first call left room for it. (5) DeepSeek v4+ (for example `deepseek-v4.1-flash`) counts as a reasoning model for the default output limit. (6) `WorkersAiProvider` and `createProvider` accept optional `requestExtras` / `aiRequestExtras`, merged into the `ai.run` input (per-model fields such as `reasoning_effort`).

- **PR story: text fallback, usage purpose, footer tokens.** (1) Under the chart the steps now live in the image alt text and in a collapsed "Steps as text" numbered list instead of a visible `Steps:` line; without a chart (no host, or over the size cap) the numbered list stays open. (2) `LlmCallUsage` has an optional `purpose` (`"review"` or `"story"`); the story call is labelled `story`, every review call `review`. (3) The footer token count includes the story call and shows the split, e.g. `~4801 tokens (story 1606)`, using provider-reported usage when available, else an estimate; `usage.tokens` and the LLM cache stay review-only.
- **Optional PR story chart.** `comment.flow_chart` now uses a separate small advisory AI call after final findings, leaving review prompts unchanged. The default `svg` style is an animated subway chart (CSS only) with light/dark and reduced-motion support; `mermaid` is explicit opt-in. `comment.flow_chart_animate: false` emits static output. Text lists work without hosting, on mobile, or in private repositories. The Action's opt-in `comment.flow_chart_host: branch` publishes public SVG assets on `mergejudge-assets` with `contents: write`. Validated titles and diff refs, deterministic content hashes, isolated story/upload failures, a strict per-request Codex story schema, and story preservation during runner secret-scan re-rendering keep this independent of lanes and findings. Cache-only and rules-only reviews skip the extra call.
- **Shepherd (Watch and auto-fix), beta, tier 1.** Turn it on per PR with the comment `/mergejudge shepherd` (off: `/mergejudge shepherd off`) or the `shepherd` label. While it is on, MergeJudge's inline review comments can carry GitHub "suggested changes" (single-line replacements) you apply with "Commit suggestion", and each batch is logged in one Shepherd comment on the PR. New optional `shepherd:` block in `.mergejudge.yml` (`enabled`, `max_attempts`, `protected_paths`, `suggestions`); read from the base branch. Protected paths (`.github/`, deploy and rollback scripts, auth and secrets files, `.mergejudge.yml`) never get a suggestion. With Shepherd off, prompts and review output are unchanged. Shepherd never merges. 
- **Shepherd tier 2: Action `mode: shepherd`.** In your own Actions and with your own model key, Shepherd pushes small fixes for failed CI and real merge conflicts on PRs that have the `shepherd` label (or `/mergejudge shepherd`). It never merges, deploys or force-pushes, works on same-repo branches only, and `mode: auto` routes the new events (Shepherd comments, `shepherd` and `needs-human` label changes, `workflow_run`, `check_suite`) to it. Hard stop rules in code: retry budget counted from Shepherd's own commits (L1), same failure twice (L2), ping-pong (L3), fixes must shrink the failures (L4), review findings get one pass (L5), protected paths (H1), size limits `shepherd.max_fix_lines` and `shepherd.max_fix_files` (H2), not a code problem such as a flaky test, missing secrets or an outage (H3), and judgment calls such as logic merge conflicts (H4). A stop adds `needs-human` and posts one hand-off comment naming the rule; nothing more is pushed until a human clears it. New Action inputs `shepherd_fix_command`, `shepherd_commit_name`, `shepherd_commit_email` and the workflow `examples/shepherd-workflow.yml`.
- **Shepherd follow-ups.** `/mergejudge shepherd retry` grants exactly one more fix attempt (write, maintain or admin; logged in the Shepherd comment; the cap is `max_attempts` plus grants; plain re-enable never adds attempts). Merging the base branch now checks every file the merge brings in against the protected paths and hands off on H1 instead of pushing. L4 compares failing checks across all check runs and statuses on the head commit (required checks, else all but Shepherd's own), and waits while a counted check is pending. The Shepherd state comment is only trusted from Shepherd's own bot login when it is known.
- **Shepherd waits for checks and comes back.** When L4 cannot decide because a counted check on the head is still pending, Shepherd now records a "waiting for checks" row (head commit and failed run, once per run) and re-evaluates that run through the normal decision and loop breakers on the next finished workflow run, check suite or `status` event for the same head commit (add `status:` to the workflow triggers). A moved head drops the row. A merge that is both oversized and touches protected files now reports H1 before H2.
- **Shepherd live-trial fixes.** (1) The "what failed" text and the failure fingerprint now come from the failing step's own output (cut at the `##[error]` that ended the step, or the first "Post job cleanup."), not from the job's cleanup tail, so two different lint errors no longer share a fingerprint. File names are kept when errors are normalised. (2) One concurrency group per PR for every event in `examples/shepherd-workflow.yml`, and Shepherd always uses the oldest of its own state comments: grants from duplicates are merged on read, a create race is detected by listing again and merged into the older comment, and the duplicate is deleted. (3) The whole-merge protected-path check (H1) now runs right after the merge starts, before conflict classification and the size check, so a logic conflict plus an incoming `.github` change reports H1, not H4. (4) New base-branch trigger: a `push` to the base branches (plus optional `schedule` and `workflow_dispatch`) sweeps the open, non-draft, same-repo PRs Shepherd is on for, waits for GitHub's `mergeable` (backoff, capped), and runs the conflict check on the conflicting ones (at most 10 per run). Added to `examples/shepherd-workflow.yml`; `mode: auto` routes `push` to Shepherd. (5) `/mergejudge shepherd retry` now also re-checks the latest failed run on the unchanged head: a known failure goes through the normal decision and the new grant allows the fix; an unknown one gets the flaky-test re-run first; no failed run means only the conflict check, as before. (6) Small fixes: a plain `/mergejudge shepherd` (or `off`) on a PR already in that state logs no second row; the H4 preview labels the sides `main (base):` and `<head> (this PR):`; the L1 and other CI hand-offs and rows link the CI run, and the H1 and H4 conflict hand-offs and rows link the base commit being merged.
- **Shepherd sweep does not trust a stale `mergeable`.** GitHub can keep answering `mergeable: true` for minutes after the base branch moved. The sweep now accepts a true only when the PR's merge commit has the current base tip as first parent (otherwise it keeps polling), and if the answer stays null or stale it decides with a local `git merge-tree` and runs the conflict check on a conflict.
- JSON reply parsing: a reply that is already a bare JSON object is no longer cut at a ``` inside one of its strings.

## 0.6.1

Published package for the 50-PR Martian evaluation (`npx mergejudge-runner@0.6.1`). Release commit: `434c979` (`release: 0.6.1 with updated npm and Marketplace AEO metadata`).

- **AEO metadata and docs sync.** npm description, keywords, homepage, and Marketplace action copy. This documentation pass (README top fold, `benchmark/`, `CHANGELOG.md`, `CONTRIBUTING.md`) records the same version.
- **`--deep` two-pass verification, published in this version.** `ai.mode: deep`, CLI `--deep` and `--mode deep`, Action `review_mode`, `MERGEJUDGE_MODE`, and `INPUT_REVIEW_MODE`. Pass 1 proposes candidates. Pass 2 tries to falsify them. A second-pass finding is kept only when its quote matches the diff. The fast default stays one pass. The feature commit (`20b4174`) still had `"version": "0.6.0"` in `package.json` because it landed after the 0.6.0 release tag. The 0.6.1 release labeled that changelog entry `0.6.1`.
- **50-PR Martian Code-Review-Bench (Core profile, 158 golden comments, judge `claude-sonnet-4-20250514`).** `--deep`: precision 75.9%, recall 38.0%, F1 50.6% (TP 60, FP 19, FN 98), 1.58 comments per pull request, about 28 seconds. Fast default: precision 75.0%, recall 28.5%, F1 41.3% (TP 45, FP 15, FN 113), 1.20 comments per pull request, about 15 seconds. See `benchmark/README.md` and upstream submission [withmartian/code-review-benchmark#70](https://github.com/withmartian/code-review-benchmark/pull/70).
- Also included in this published tree, committed after the 0.6.0 tag: quiet evidence-gated inline comments (findings without a verified quote stay in the summary) and the lane choice map behind `review.lane_map`.

## 0.6.0

Release commit `d896314`. Git tag `v0.6.0` (the Action major tag `v1` points here).

- Optional security review: `review.security: true` under `review:` in `.mergejudge.yml` (off by default) also scores the `sec.audit.*` checks. Action only. The hosted runner does not read this key.
- Docs from 0.5.2 ride along: the API key secret is documented as `AI_API_KEY`.
- The `--deep` second pass and the 50-PR evaluation were written on top of this release (the version string was still `0.6.0`) and shipped in 0.6.1. They are not in the `v0.6.0` / `v1` tag.

## 0.5.2

Docs only. The API key secret is documented as `AI_API_KEY` (your own provider key). `MJ_API_KEY` still works. No engine changes.

## 0.5.1

Model calls are bounded: 120 s per attempt, at most 1 retry after a timeout, up to 2 retries for network errors, HTTP 408, 429, and 5xx, 240 s per call (`provider.timeout_ms`, `max_timeout_retries`, `max_retries`, `budget_ms`, `max_delay_ms`, or the `MERGEJUDGE_LLM_*` env vars). Deep mode caps each call so the loop ends within `deep.max_seconds` + 240 s. On failure the PR comment says only `AI review unavailable (<class>)`. Provider bodies, model text, and git stderr stay out of logs. Runner and Action logs share one redaction filter.

## 0.5.0

With `lanes.code_auto`, small test-only changes (test files and test folders that only add or adjust tests) can go `auto` (low risk, not a guarantee). The PR comment shows the AI's short reason for files that need review or are blocked. "Why this lane?" no longer repeats the same reason in a details block.

## 0.4.9

The runner finds Codex and Claude Code on its own during setup. Deep mode reads the files most related to the pull request first and can review with a partial index on big repositories (new `--local-index-max-*` limits for local code). Changes to `.mergejudge.yml` always go to review. Fix for turning on GitHub auto-merge with `approval.mode: auto-merge-only`. Optional learning from human review comments (`learning.from_comments`, off by default). Footer wording about merging.

## 0.4.8

`mergejudge-runner login`: sign in with GitHub (device flow) so you can start the runner without the panel enrollment code. Needs Device Flow enabled on the MergeJudge GitHub App.

## 0.4.7

First release from this public repository. Package links, description, and README updated. The code is identical to 0.4.6.

## 0.4.6

Initial public release. PR template check and trusted authors rules (both only ever raise a lane; the Worker's server floor re-applies them).

## 0.4.5

Noted in the 0.4.7 changelog: policy files share the total budget fairly, and truncation is reported.

## Older hosted-runner work

Local-code mode (`runner.code_source: local`) shipped as runner 0.4.0: the runner keeps a partial bare clone and builds the index on the machine. The job payload to the Worker then carries SHAs, config, and the rules result, not file contents. When AI review is on, the prompt is still sent from that machine to the engine you configured.
