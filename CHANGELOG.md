# Changelog

Release notes for `mergejudge-runner`. Versions below match `package.json`, `src/version.ts`, and `git log`. The public repository starts at 0.4.6.

`auto` means low risk, not a guarantee.

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
