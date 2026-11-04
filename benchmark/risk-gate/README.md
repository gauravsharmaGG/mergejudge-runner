# Bench-only risk gate for pass 2

A small experiment in the Martian benchmark harness: can a cheap gate decide that the second, deeper review pass (pass 2) is not worth running on some PRs, without losing the findings that pass 2 adds?

This is **bench-only, not product**. Nothing under `core/`, `src/` or `action/` is touched. A product setting (for example in `.mergejudge.yml`) would be a later step, if the numbers justify it.

## What `skip` means

`skip` means one thing: **pass 2 is not run** for this PR (deep findings = fast findings). It is never a merge decision, never "auto" or "safe". Verdicts are ordered `skip < review < block`; `review` and `block` both run pass 2.

## Gate modes

- `off`: pass 2 always runs (the baseline).
- `rules`: deterministic rules only, no model call. Thresholds are the runner's defaults (`core/rules.ts`, `core/config.ts`), picked a priori and **not tuned on the benchmark**: secrets, protected paths, removed guards or auth checks, dependency files, `.mergejudge.yml`, `.sql`, deleted/renamed code files, files with no patch, size (over 100 changed lines in total or over 30 in one code file), and text that tries to steer the reviewer.
- `rules+cheap`: rules first. A cheap model (`glm-5.3-flash` through `claude-glm`) is asked only when the rules say `skip`, because it can only raise the verdict. If rules already say `review` or `block`, pass 2 runs either way and the call is skipped. The model can be talked down by a PR but cannot lower the rules floor, and any failure (timeout, bad output) counts as `review`.

## Why the replay is exact

In the harness, pass 1 (fast) and pass 2 (deep) share the same pass-1 call, and the Martian judge scores the union of fast and deep candidates in one call, then splits the result per profile. So for any PR, "deep with pass 2 skipped" equals the cached fast eval. `gate_replay.py` can therefore replay a gate over the cached gate-off baseline with no review or judge call.

## Commands

Run from the repo root. The checkpoint and bundle come from a baseline run of `harness/run_on_mini.py`.

```sh
# unit tests (offline)
python3 -m unittest discover -s benchmark/risk-gate/tests -v

# replay rules over the cached baseline (offline)
python3 benchmark/risk-gate/gate_replay.py --checkpoint checkpoint_results.json --bundle prs_50_bundle.json \
  --mode off,rules --out replay.json --md replay.md

# replay rules+cheap (calls the cheap model for PRs the rules leave at skip; results cached)
python3 benchmark/risk-gate/gate_replay.py --checkpoint checkpoint_results.json --bundle prs_50_bundle.json \
  --mode off,rules,rules+cheap --cheap-cache cheap-cache.json --out replay.json --md replay.md

# add a presumed-clean set for the false-alarm rate (needs an authenticated gh CLI)
python3 benchmark/risk-gate/fetch_clean_prs.py --exclude-bundle prs_50_bundle.json --out clean_bundle.json
python3 benchmark/risk-gate/gate_replay.py ... --clean-bundle clean_bundle.json

# full harness run with the gate live (calls the review and judge models)
python3 benchmark/risk-gate/harness/run_on_mini.py --bundle prs_50_bundle.json --out-dir out --risk-gate rules
```

A gated harness run writes `checkpoint_results_gate-<mode>.json` and `martian_mergejudge_results_gate-<mode>.json`, so it never overwrites the baseline files. Every call also logs full token usage and list-price cost (`meta["usage"]`, `meta["cost_usd_list"]`, `judge_usage`, `gate`).

## Caveats

- The Martian set is all bug-introducing PRs, so it can show what a gate loses but not its false-alarm rate. PR-level precision needs the clean set.
- The clean set is **presumed** clean: merged and no revert found by search. A bug may still be in there.
- Pass-2 input tokens are an estimate: `len(prompt)/4`, scaled by `--pass2-token-ratio` (calibrate it from real logged usage). The harness feeds pass 2 all verified pass-1 findings, but the cache only holds the selected fast findings, so the estimate is slightly low. Output tokens are the real logged ones. The logged input tokens in the Oct 31 baseline are about 2 because the old parser dropped cache tokens.
- Dollar figures use list prices (`pricing.py`, checked 2026-11-04). The main figure prices pass-2 input at the base input price; the "CLI billing" figure prices it at the 1-hour cache-write price, which is how Claude Code CLI bills a one-off call (checked on three real pass-2 calls). Subscription runs are not billed per token at all.
- `--pass2-token-ratio 1.97` comes from three real pass-2 calls on 2026-11-04 (`claude-sonnet-5-5`): 85,224 real input tokens against a chars/4 estimate of 43,328. It includes about 4k tokens of CLI overhead per call.
- The safety-guard rule is a simplified port: it does not exempt a YAML step removed together with its guard, so it may block slightly more than the product.
- A few dozen PRs make small differences noisy; read the counts, not just the percentages.

## Results

Run on 2026-11-04 over the cached Oct 31 gate-off baseline (Martian 50 PRs) plus 20 presumed-clean PRs (4 merged PRs each from sentry, grafana, cal.com, discourse and keycloak, merged 2025-03-03..07). Full tables: [`results/replay-2026-11-04.md`](./results/replay-2026-11-04.md).

| mode | Deep Core P / R / F1 | TP lost | deep findings lost | Martian PRs skipping pass 2 | clean PRs skipping pass 2 | pass-2 $ saved (share) |
|---|---|---|---|---|---|---|
| off | 78.3 / 41.1 / 53.9 | 0 | 0 | 0/50 | 0/20 | 0 |
| rules | 78.0 / 40.5 / 53.3 | 1 | 3 | 5/50 (10%) | 5/20 (25%) | 4.2% |
| rules+cheap | 78.3 / 41.1 / 53.9 | 0 | 0 | 0/50 (0%) | 0/20 (0%) | 0% (gate costs extra) |

In short: with the runner's default thresholds, the rules send most PRs to pass 2 anyway (size is the usual reason). `glm-5.3-flash` then said `review` on all 10 PRs the rules left at `skip` (5 Martian, 5 clean), so `rules+cheap` keeps every finding but saves nothing. `rules` alone saves about 4% of pass-2 spend and loses 1 of 65 true positives.
