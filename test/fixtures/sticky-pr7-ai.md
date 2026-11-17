<!-- mergejudge:summary -->
## ⚖️ MergeJudge

**Overall lane:** 🟡 `review` · 6 of 6 files need a human look · 3 problems found · 5 line comments

*`review` is advisory: the `mergejudge/lane` check stays neutral; only `block` fails it.*

Adds a CI workflow, a Shepherd workflow pinned to a runner commit, a small dependency-free lint script with --fix, a test file and package.json, and lowers shepherd.max\_attempts to 1. The Shepherd workflow uses an App installation token with write permissions and a third-party action pinned by SHA.

### What to check

**scripts/lint.mjs**
- **Logic (high):** The lint script reports success and exits 0 in --fix mode even when problems remain, and crashes if src/ is absent. [L19](https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7/files#diff-a28c115d54cc0fb754b50eb6843def6e1642ea0d5c998e9934a11807ff121ac8R19) · line comment
- **Error handling (medium):** readdirSync on src is unguarded and file writes/reads have no error handling. [L7](https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7/files#diff-a28c115d54cc0fb754b50eb6843def6e1642ea0d5c998e9934a11807ff121ac8R7) · line comment

**test/math.test.js**
- **Tests (low, 2/5):** A math test is added but the new lint script and workflow behaviour are untested; the test also imports src/math.js which is not in this PR. [L3](https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7/files#diff-e2c68e7e194e330dc2e863bfcf48a429b7baa049c4ee41da7ffe8034faf42dbdR3)

**.github/workflows/shepherd.yml**
- [L26](https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7/files#diff-d3230df32ebe571bd9b3ea9b7d89d00a0f3f9def5f752c8f57fc50d0f4981578R26) **Important:** actions: write allows re-running/cancelling workflows; confirm this is needed and scoped as intended.
- [L37](https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7/files#diff-d3230df32ebe571bd9b3ea9b7d89d00a0f3f9def5f752c8f57fc50d0f4981578R37) **Important:** issue\_comment path does not check commenter permission here; ensure the runner gates on write access before acting.
- [L55](https://github.com/gauravsharmaGG/mergejudge-free-test/pull/7/files#diff-d3230df32ebe571bd9b3ea9b7d89d00a0f3f9def5f752c8f57fc50d0f4981578R55) **Important:** Third-party action receives App private key and write tokens; verify the pinned SHA corresponds to the reviewed runner code.

<details><summary><b>Why this lane?</b> 6 files matched 4 rules</summary>

- **Protected path:** `.github/workflows/ci.yml`, `.github/workflows/shepherd.yml`, `.mergejudge.yml`
- **MergeJudge config file \(.mergejudge.yml\):** `.mergejudge.yml`
- **Dependency manifest or lockfile change:** `package.json`
- **Code file:** `scripts/lint.mjs`, `test/math.test.js`

AI notes:

- `.github/workflows/shepherd.yml`: Third-party action with contents/pull-requests/issues/actions write, secrets passed in; SHA pin looks full but should be human-verified.
- `scripts/lint.mjs`: Local file-rewriting script; readdirSync on src will throw if src is missing, and --fix always reports success.

</details>

<details><summary><b>Files (6):</b> 6 review</summary>

- 🟡 `.github/workflows/ci.yml` — Protected path
- 🟡 `.github/workflows/shepherd.yml` — Protected path
- 🟡 `.mergejudge.yml` — MergeJudge config file \(.mergejudge.yml\), Protected path
- 🟡 `package.json` — Dependency manifest or lockfile change
- 🟡 `scripts/lint.mjs` — Code file
- 🟡 `test/math.test.js` — Code file

</details>

<details><summary><b>All checks</b> (3 pass · 3 fail · 1 n/a)</summary>

- ✅ `sec.no-secrets`: Only references to secret names are added; no real credentials are committed.
- ✅ `sec.no-exfiltration`: Secrets go to the pinned runner action as inputs, not to an unexpected host.
- ✅ `sec.no-unsafe-exec`: No eval or shell execution of untrusted input; npm scripts are fixed literals.
- ➖ `sec.input-handling`: No web input or HTML sinks in the change.
- ❌ `cor.logic`: see What to check
- ❌ `cor.errors`: see What to check
- ❌ `cor.tests` 2/5: see What to check

</details>

---

<!-- mergejudge:feedback -->
**Was this review right?**

- [ ] Correct
- [ ] Too lenient
- [ ] Too strict
- [ ] Wrong reason
- [ ] Missed something

<details><summary>Rate each flagged check</summary>

Tick **wrong** if the check was a false alarm, **right** if it found a real problem.

- [ ] cor.logic: wrong
- [ ] cor.logic: right
- [ ] cor.errors: wrong
- [ ] cor.errors: right
- [ ] cor.tests: wrong
- [ ] cor.tests: right

</details>

<sub>Tick a box or comment <code>/mergejudge learn &lt;note&gt;</code>. Feedback is stored on the <code>mergejudge-learning</code> branch, never in this PR.</sub>

<sub>~3980 tokens · MergeJudge doesn't merge PRs itself. · To make <code>block</code> stop merges, require <code>mergejudge/lane</code> in branch protection.</sub>

<details><summary><sub>Run details</sub></summary>

<sub>Mode: @​cf/deepseek-ai/deepseek-v4.1-flash-1017 · tokens system 421/policy 0/rubric 318/diff 2112/out 1129</sub>

</details>