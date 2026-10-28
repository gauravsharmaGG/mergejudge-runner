# Contributing

Thanks for looking at MergeJudge Runner. The package is MIT-licensed. Bug fixes, tests, docs, and provider adapters in `src/` are welcome. Behaviour changes in the vendored review core are not: see [Layout](#layout).

`auto` means low risk, not a guarantee. Please keep that wording when you edit docs.

## Clone and install

Needs Node >= 20 and git.

```sh
git clone https://github.com/gauravsharmaGG/mergejudge-runner
cd mergejudge-runner
npm install
```

`npm ci` is what CI uses (`npm run verify` on Node 20 and 22) and is the stricter install. `npm install` is fine for local work.

## Tests

```sh
npm test          # vitest, offline
npm run typecheck
npm run verify    # typecheck + tests + CLI build + Action bundle
```

Tests run against a fake Worker and a fake `claude`. They do not need a network connection, a real login, or an API key.

## Try the CLI on a git diff

This package does not have a `review <file.diff>` subcommand. `mergejudge-runner run` waits for a job from the hosted service. To exercise the review logic on a diff locally:

1. Build and read the flags.

   ```sh
   npm run build
   node dist/cli.js --version
   node dist/cli.js run --help
   ```

   `--deep` and `--mode deep` select the second pass. `--mode fast` is one pass. There is no `--no-ai` flag. Rules-only is `provider: none` (or no model key, which skips the model call).

2. Run the offline suite. `test/configguard.test.ts`, `test/deepreview.test.ts`, and `test/runner.test.ts` feed patches and config through the same rules and second-pass gate a pull request uses.

3. To see a review on a real pull request, push a branch and use the GitHub Action in the README (`provider: none` for a rules-only run, or your own key). In rules-only mode (`provider: none`) zero code is sent to any external model API. In AI mode, only the pull request diff and the context attached to that review are sent directly from your runner to the provider you configured (OpenAI, Anthropic, Gemini, or local Ollama).

Do not commit tokens, private diffs, or real customer repositories.

## Deterministic rules

Rules live in `core/rules.ts` (vendored). A rule may raise a lane to `review` or `block`. It must not lower a lane the policy already set. `auto` means low risk, not a guarantee.

If you want a new rule, open an issue that describes the path or diff pattern, the lane it should force, and a sample patch. Maintainers sync `core/` from the upstream review core. A pull request that changes behaviour under `core/` will be asked to move that change upstream. Tests that lock the current behaviour, and docs that name the rule, are still useful in this repo.

Config keys that only raise the floor (protected globs, labels, `lanes.code_auto` off by default, base-branch `.mergejudge.yml`) are documented in the README [configuration reference](README.md#configuration-reference).

## Provider adapters

HTTP providers are constructed in `core/llm/index.ts` (`anthropic`, `openai`, `openai-compatible`, `zai`, `workers-ai`, `none`). Gemini and local Ollama go through `openai-compatible` plus `base_url`. The CLI engines (`claude-code`, `codex`, `glm`) are in `src/engine.ts` and `src/detect.ts`.

A new adapter should:

- take the key from the environment variable named by `provider.api_key_env`, never from argv
- use the shared timeout, retry, and redaction path in `core/llm/http.ts` and `src/redact.ts`
- fail closed to rules-only when the key or model is missing
- add a test that a provider error does not echo the response body or the prompt

`provider: none` must stay a pure rules path with no outbound model call.

## Benchmark reproductions

The 0.6.1 50-PR Martian numbers, the judge model, and the commands are in [benchmark/README.md](benchmark/README.md). Check the checked-in arithmetic with:

```sh
./benchmark/reproduce.sh
```

That script does not call a model. A real rerun uses `npx mergejudge-runner@0.6.1` in `--mode fast` and in `--deep`, then Martian's `step3_judge_comments.py`. Open an issue with your TP, FP, FN, precision, recall, F1, and the judge model. Per-language numbers are welcome. The published v0.6.1 table is aggregate only.

## Pull requests

- Keep the change small. Say what behaviour changed and why.
- Add or update tests. `npm run verify` must pass.
- Never commit tokens, keys, or real repository data, and never log them. Anything that touches token handling, the child-process environment, or git access needs a note in the pull request on its security impact.
- Do not bump the version in `package.json`. Maintainers handle releases.
- Docs: no em dashes or en dashes. Do not add paid-only product price tables to `README.md`. Do not write that code stays on the machine when AI review is enabled. In rules-only mode, say that no code is sent to an external model API. In AI mode, say that the diff and context go from the runner to the configured provider.
- By contributing you agree your work is released under the MIT licence.

## Layout

- `src/` runner source (CLI, config, polling loop, engines, local-code mode) and `src/action.ts` (the GitHub Action entry point).
- `core/` the shared review code (rules, prompts, parsing, result format), **vendored** from the MergeJudge core. Each file starts with a "Vendored ... Keep in sync." header. Please do not make behavioural changes here in a pull request: open an issue describing the problem and maintainers will apply and sync the change from upstream. Bug fixes in `src/` are welcome directly.
- `action/index.cjs` is the committed Action bundle. `npm run build:action` regenerates it. A test fails if it is stale.
- `test/` tests. `test/support/` holds a small copy of the Worker's result schema used to check what the runner submits.
- `benchmark/` the 0.6.1 Martian 50-PR summary and reproduction notes.
