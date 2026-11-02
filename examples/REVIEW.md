# REVIEW.md (example)

MergeJudge reads this file from the base branch, next to `REVIEW_POLICY.md`, `AGENTS.md` and `CLAUDE.md`.
Keep it short: it shares an 8 KB budget with the other policy files. Copy it to your repo root and edit.

## What matters here
- Correctness and security first. Flag missing input checks on public endpoints.
- Database migrations must be backwards compatible with the running version.

## Evidence
- Every finding names the file and line, and quotes the changed code it is about.
- If you cannot point at a changed line, do not report it.

## Nit cap
- At most 3 style or naming nits per PR. Skip formatting the linter already checks.

## Out of scope
- Generated files (`dist/`, lockfiles) and vendored code.
