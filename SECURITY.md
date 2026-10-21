# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

- Preferred: use GitHub's private vulnerability reporting on this repository (Security tab > "Report a vulnerability").
- Alternatively email [contact@gauravsharma.dev](mailto:contact@gauravsharma.dev).

Include the runner version (`mergejudge-runner --version`), your OS and Node version, and steps to reproduce. We aim to acknowledge reports within a few days and will credit you in the fix unless you prefer otherwise.

## Scope

In scope: the `mergejudge-runner` code in this repository (`src/`, the vendored `core/`, `examples/`) and the published npm package.

Out of scope: the hosted MergeJudge service and its Worker, panel and GitHub App (report those via the contact above and they will be routed), and vulnerabilities in third-party CLIs the runner launches (`claude`, `codex`, `git`) or in your own OS account setup.

## What the runner does with tokens and clones

- The runner token (`mjr_a_...`) is stored only in `$XDG_CONFIG_HOME/mergejudge-runner/config.json` (directory `0700`, file `0600`, atomic writes). The runner refuses to start if the file is group- or world-readable. The token is sent only to the configured `https://` server (plain `http://` only for localhost), redirects are not followed, and it is masked in logs.
- Runner and Action logs share one redaction filter: token shapes, auth headers, email addresses, PEM private keys, and long base64 or hex secrets. Prompts, diffs, model replies and provider error bodies are not written to those logs. When an AI call fails, the PR comment names only an error class such as `timeout`. Git stderr is not logged: it can contain filter or remote text.
- The engine child process (`claude` / `codex`) receives a minimal allowlisted environment. The runner token, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_*`, `AWS_*` and `MERGEJUDGE_*` variables are never passed. A GLM API key is placed only in the GLM child's environment.
- Prompts are written to the engine's stdin (not argv). `claude` runs with no tools, an empty temporary working directory and no session persistence.
- In local-code mode (`runner.code_source: local`) the runner keeps partial bare git clones and index snapshots under `MERGEJUDGE_HOME` (default `~/.mergejudge`), using the machine's own git credentials. Credentials are never logged and URLs in errors are scrubbed. Only the structured review result leaves the machine.
- A diff secret scan runs locally in this mode; findings only raise the lane.
