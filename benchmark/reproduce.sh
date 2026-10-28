#!/usr/bin/env bash
# Check benchmark/martian-50pr-summary.json against the published v0.6.1 rates,
# then print the commands that rerun mergejudge-runner 0.6.1.
# Does not call a model, does not download the 50 pull requests, does not spend quota.
set -euo pipefail
cd "$(dirname "$0")/.."

node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";

const doc = JSON.parse(readFileSync("benchmark/martian-50pr-summary.json", "utf8"));
const round1 = (n) => Math.round(n * 1000) / 10;

function check(name, mode, precisionPct, recallPct, f1Pct) {
  const { tp, fp, fn } = mode;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const f1 = (2 * tp) / (2 * tp + fp + fn);
  const got = [round1(precision), round1(recall), round1(f1)];
  const want = [precisionPct, recallPct, f1Pct];
  if (got.some((n, i) => n !== want[i])) {
    throw new Error(`${name}: counts imply ${got.join("/")} but published rates are ${want.join("/")}`);
  }
  if (round1(mode.precision) !== precisionPct) throw new Error(`${name}: precision field ${mode.precision}`);
  if (round1(mode.recall) !== recallPct) throw new Error(`${name}: recall field ${mode.recall}`);
  if (round1(mode.f1) !== f1Pct) throw new Error(`${name}: f1 field ${mode.f1}`);
  if (tp + fn !== doc.benchmark.golden_comments_core) {
    throw new Error(`${name}: tp + fn = ${tp + fn}, core golden comments = ${doc.benchmark.golden_comments_core}`);
  }
}

if (doc.version !== "0.6.1") throw new Error(`version ${doc.version}`);
if (doc.model !== "claude-sonnet-4-20250514") throw new Error(`model ${doc.model}`);
if (!doc.modes.default || !doc.modes.deep) throw new Error("modes.default and modes.deep are required");
const languages = doc.benchmark.languages;
if (!Array.isArray(languages) || languages.length !== 5) throw new Error("expected 5 languages");
const prs = languages.reduce((n, row) => n + row.pull_requests, 0);
if (prs !== 50) throw new Error(`language pull requests sum to ${prs}`);

check("default", doc.modes.default, 75.0, 28.5, 41.3);
check("deep", doc.modes.deep, 75.9, 38.0, 50.6);
if (doc.modes.default.tp !== 45 || doc.modes.default.fp !== 15 || doc.modes.default.fn !== 113) {
  throw new Error("default counts");
}
if (doc.modes.deep.tp !== 60 || doc.modes.deep.fp !== 19 || doc.modes.deep.fn !== 98) {
  throw new Error("deep counts");
}
console.log("martian-50pr-summary.json matches the published 0.6.1 rates.");
EOF

cat <<'EOF'

Reproduce MergeJudge Runner 0.6.1 (Node >= 20). These commands do not run until you invoke them.

  npx --yes mergejudge-runner@0.6.1 --version

  # Fast default: one pass. Hosted-service worker, one job, then exit.
  npx --yes mergejudge-runner@0.6.1 run --once --mode fast

  # Two-pass adversarial verification.
  npx --yes mergejudge-runner@0.6.1 run --once --deep

`run` reviews a job from the hosted service. It does not take a local patch path.
To review a pull request with no hosted account, use the GitHub Action in benchmark/README.md
(`review_mode: fast` or `review_mode: deep`, or `provider: none` for rules-only).
Score unmodified comments with Martian step3_judge_comments.py and judge model
claude-sonnet-4-20250514. Definitions, the 38-PR subset, and limits are in benchmark/README.md.
EOF
