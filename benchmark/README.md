# Martian Code-Review-Bench, 50 pull requests (MergeJudge Runner 0.6.1)

This directory records the verified offline evaluation of `mergejudge-runner` **0.6.1** on [Martian Code-Review-Bench](https://github.com/withmartian/code-review-benchmark). The machine-readable summary is [`martian-50pr-summary.json`](./martian-50pr-summary.json). The same rates are in the repository [README](../README.md#martian-code-review-bench) and in the upstream submission [withmartian/code-review-benchmark#70](https://github.com/withmartian/code-review-benchmark/pull/70).

`auto` on a MergeJudge review means low risk, not a guarantee. This benchmark scores review comments. It is not a merge decision. Branch protection still applies.

## Dataset

The offline set is 50 real-world bug-introducing pull requests, 10 per repository, across five languages:

| Language | Repository | Pull requests |
| --- | --- | --- |
| Python | sentry | 10 |
| Go | grafana | 10 |
| TypeScript | cal.com | 10 |
| Ruby | discourse | 10 |
| Java | keycloak | 10 |

Provenance: the public offline benchmark maintained in `withmartian/code-review-benchmark` (the set built up from the published Sentry, Grafana, Cal.com, Discourse, and Keycloak pull requests). Humans curated 173 golden comments. This table uses the Core profile: 158 of those comments, in the categories `bug`, `security`, `concurrency`, `data`, `api`, `perf`, `test_gap`, and `doc_defect`.

The v0.6.1 write-up publishes **aggregate** precision, recall, and F1 only. It does not publish a per-language score split. The table above is the dataset composition (10 pull requests each), not a claim that each language scored the same. If you reproduce the run, a per-language split is a useful thing to attach to an issue.

## What was measured

| Mode | Precision | Recall | F1 | TP | FP | FN | Comments per PR | Avg latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `--deep` (two passes) | 75.9% | 38.0% | 50.6% | 60 | 19 | 98 | 1.58 | ~28s |
| default / `fast` (one pass) | 75.0% | 28.5% | 41.3% | 45 | 15 | 113 | 1.20 | ~15s |
| rules-only (`provider: none`) | n/a | n/a | n/a | n/a | n/a | n/a | 0 model comments | under a second for the rule pass |

False negatives are Core golden comments with no judge match: `158 - 60 = 98` for `--deep`, and `158 - 45 = 113` for the fast default. Check the arithmetic:

- `--deep` precision `60 / (60 + 19) = 60/79 = 75.9%`. Recall `60 / 158 = 38.0%`. F1 `2 * 60 / (120 + 19 + 98) = 120/237 = 50.6%`.
- Fast default precision `45 / (45 + 15) = 45/60 = 75.0%`. Recall `45 / 158 = 28.5%`. F1 `2 * 45 / (90 + 15 + 113) = 90/218 = 41.3%`.
- Comment rate: `(60 + 19) / 50 = 1.58` and `(45 + 15) / 50 = 1.20`.

On the 38-PR subset (pull requests that still had a runnable URL when other harnesses were scored), `--deep` scored **78.3%** precision, **42.7%** recall, and **55.3%** F1 (47 true positives, 13 false positives, 1.58 comments per pull request, about 28 seconds). That subset is reported in the repository README and on the guide page below. It is not a replacement for the 50-PR row.

Judge: Martian's `step3_judge_comments.py`, model `claude-sonnet-4-20250514` (the submission text says Claude Sonnet). Comments were scored unmodified. The judge decides whether a tool comment is the same issue as a golden comment.

### Default vs `--deep` vs the rules-only floor

- **Default (`fast`)** is one pass over the numbered diff. Precision 75.0%, recall 28.5%, F1 41.3% (TP 45, FP 15, FN 113).
- **`--deep`** keeps that pass and adds a second pass. Pass 1 proposes candidate defects with an exact quote from the diff. Pass 2 tries to falsify each candidate against the diff. A second-pass finding is posted only when its quote matches that file's diff. On this run that raised recall from 28.5% to 38.0% and F1 from 41.3% to 50.6%, with precision 75.9% (TP 60, FP 19, FN 98).
- **Rules-only** (`provider: none`, or no LLM key) does not call a model. Zero code is sent to any external model API. Deterministic rules still set a minimum lane of `review` or `block` when a path, secret, size, or policy rule says so. The AI pass can raise that lane when it verifies a defect, and it cannot lower the floor. Rules-only is not a precision row here: the Martian judge scores model comments, and this mode does not emit them.

`ai.mode: deep` (the pass count) is a different switch from `review.mode: deep` (how much surrounding code is attached). The 50-PR table is the diff review with the second pass on or off. It is not a full-repository index.

## Definitions

| Term | Meaning on this run |
| --- | --- |
| TP | True positive: a MergeJudge comment the judge matched to a Core golden comment. |
| FP | False positive: a MergeJudge comment the judge did not match to a Core golden comment. |
| FN | False negative: a Core golden comment (of 158) with no matching MergeJudge comment. |
| Precision | `TP / (TP + FP)`. Share of our comments that matched a golden comment. |
| Recall | `TP / (TP + FN)`. Share of Core golden comments we matched. |
| F1 | `2 * TP / (2 * TP + FP + FN)`, the harmonic mean of precision and recall. Reported as raw F1, before any second model relabels misses. |

Matching is semantic and done by the benchmark judge, not by a string equality check in this repository. One golden comment can be the match target for the scoring rules in `step3_judge_comments.py`. We do not relabel unmatched comments as valid nitpicks and then recompute F1.

## Reproduce

Pin the package that was scored:

```sh
npx --yes mergejudge-runner@0.6.1 --version
```

That prints `0.6.1`. Node >= 20.

`mergejudge-runner run` is the worker for the hosted MergeJudge service. It reviews a job the service hands it. It does not take a local patch path. Two ways to rerun the same engine:

**GitHub Action (no hosted account).** Put the workflow on a fork you control, replay each benchmark pull request as a pull request against a base that has `.mergejudge.yml`, and collect the inline comments. Rules-only:

```yaml
- uses: gauravsharmaGG/mergejudge-runner@v1
  with:
    provider: none
```

Fast default (one pass) and `--deep` (two passes), with your own key:

```yaml
- uses: gauravsharmaGG/mergejudge-runner@v1
  env:
    AI_API_KEY: ${{ secrets.AI_API_KEY }}
  with:
    provider: anthropic
    model: claude-sonnet-4-20250514
    api_key_env: AI_API_KEY
    review_mode: fast    # or deep
```

The npm package `mergejudge-runner@0.6.1` is the scored build. The Action major tag `@v1` moves. For a byte-for-byte rerun, pin the Action to commit `434c97920d5690bb3af5c253b33806a3c8b79a30` (the 0.6.1 release) or run the CLI below.

**CLI worker (hosted service).** After `mergejudge-runner setup` (or `login`) against an installation that can see the repository:

```sh
# one pass
npx --yes mergejudge-runner@0.6.1 run --once --mode fast

# two-pass adversarial verification
npx --yes mergejudge-runner@0.6.1 run --once --deep
```

`--mode deep` is the same switch as `--deep`. In AI mode the runner sends the pull request diff and attached context to the provider configured for that runner. In rules-only mode (`provider: none`) it does not.

**Score the comments.** Export the inline comments unmodified and run Martian's `step3_judge_comments.py` with judge model `claude-sonnet-4-20250514`. Count TP, FP, and FN on the Core profile (158 golden comments) using the definitions above. Compare with [`martian-50pr-summary.json`](./martian-50pr-summary.json).

Check that this JSON still matches those identities (no network, no model call):

```sh
./benchmark/reproduce.sh
```

## Comparison context

This file does not add a price table and does not score commercial products. Open-source tools that also run inside GitHub pull requests, and that are reasonable to read next to this one, are [PR-Agent](https://github.com/qodo-ai/pr-agent), [reviewdog](https://github.com/reviewdog/reviewdog), and [Danger](https://github.com/danger/danger). reviewdog and Danger are linter and convention checks. They do not choose `auto`, `review`, and `block`. A longer comparison, including how to read raw precision next to comments per pull request, is in [Open-source code review tools](https://mergejudge.si/guide/open-source-code-review-tools). MergeJudge's own 10-PR smoke test of `diff` vs `context` vs `deep` indexing is a different page, [methodology](https://mergejudge.si/results), and is not this 50-PR table.

On the guide's summary of the same offline leaderboard, `--deep` was described as the highest raw precision among the tools scored there, and among the highest raw F1 of the open-source entries, at about 1.58 comments per pull request and about 28 seconds. Those sentences are the guide's reading of the leaderboard. Re-score before you treat them as your result.

## Limitations

- **Single run.** The percentages are one pass over 50 pull requests. A second run with the same model can move.
- **Judge variance.** A different judge model can match comments differently. This record names `claude-sonnet-4-20250514`.
- **Small set.** 50 pull requests, 10 per language. Aggregate rates can hide a weak language. The per-language score split was not published with v0.6.1.
- **Diff scope.** The scored comments come from the diff review (one pass, or two). `review.mode: deep` can attach callers and imports from a checkout. That index was not what this table measures. A finding about code the diff does not contain cannot quote the diff, so it is not posted as a line comment.
- **Gold set.** A real defect that the golden comments do not list is scored as a false positive. Recall cannot exceed the Core list.
- **Rules are not in the F1.** The lane floor still runs when the model is off. This table does not convert lanes into precision.

## Reproduce and tell us

External maintainers are invited to rerun `mergejudge-runner@0.6.1` in default and `--deep` mode, score with the upstream judge, and open an issue on [gauravsharmaGG/mergejudge-runner](https://github.com/gauravsharmaGG/mergejudge-runner/issues) with the command, the judge model, and TP, FP, FN, precision, recall, and F1. A per-language breakdown is especially useful. Please do not post API keys, private diffs, or provider payloads.
