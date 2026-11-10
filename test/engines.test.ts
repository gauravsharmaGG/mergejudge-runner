import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineSettings, glmKeyOf, pickDefaultEngine, runnerCaps } from "../src/capabilities.js";
import { main } from "../src/cli.js";
import { loadConfig, type RunnerConfig } from "../src/config.js";
import { CODEX_OUTPUT_SCHEMA, codexArgs, claudeArgs, engineEnv, parseCodexLastMessage, ZAI_BASE_URL } from "../src/engine.js";
import { createLogger, redact } from "../src/redact.js";
import { runLoop, type RunOptions } from "../src/run.js";
import { cliWarnings, checkCli, defaultExec, type ExecFn } from "../src/setup.js";
import { VERSION } from "../src/version.js";
import {
  captureLog, DIFF_SENTINEL, ENROLL, FakeWorker, makeFakeClaude, makeFakeCodex, makePayload, pollJob, tmp, tok, TRIAGE_REPLY, writeCfg,
} from "./helpers.js";

const GLM_KEY = "0123456789abcdef0123456789abcdef.GLMSECRETvalue99";
const hostEnv = (fcDir: string, extra: Record<string, string> = {}) => ({
  PATH: `${fcDir}:${process.env.PATH}`, HOME: "/home/u", USER: "u", LANG: "C", CODEX_HOME: "/home/u/.codex", CLAUDE_CODE_OAUTH_TOKEN: "oauth-own-login",
  ANTHROPIC_API_KEY: "sk-ant-api-SECRET", ANTHROPIC_AUTH_TOKEN: "anth-auth-SECRET", OPENAI_API_KEY: "sk-openai-SECRET-aaaaaaaaaaaaaaaa", CODEX_API_KEY: "codex-SECRET",
  MERGEJUDGE_RUNNER_TOKEN: tok("A"), RANDOM_OTHER: "x", ...extra,
});

describe("engineEnv", () => {
  const src = { PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex", CLAUDE_CONFIG_DIR: "/h/.claude", CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b", ANTHROPIC_BASE_URL: "http://evil", OPENAI_API_KEY: "o", CODEX_API_KEY: "c", ZAI_API_KEY: "z", GITHUB_TOKEN: "g" };
  it("codex: keeps its login dir, strips OPENAI_API_KEY / CODEX_API_KEY / ANTHROPIC_*, never the claude login", () => {
    expect(engineEnv(src, "codex")).toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/h/.codex" });
  });
  it("claude-code: unchanged contract (own login kept; API keys, auth token and base url removed)", () => {
    const e = engineEnv(src, "claude-code");
    expect(e).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
  });
  it("glm: ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL only in the child; no ANTHROPIC_API_KEY, no subscription token, nothing else secret", () => {
    const e = engineEnv(src, "glm", GLM_KEY);
    expect(e.ANTHROPIC_AUTH_TOKEN).toBe(GLM_KEY);
    expect(e.ANTHROPIC_BASE_URL).toBe(ZAI_BASE_URL);
    expect(ZAI_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "ZAI_API_KEY", "GITHUB_TOKEN", "CODEX_HOME"]) expect(e).not.toHaveProperty(k);
    expect((src as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("b"); // the caller's env object is untouched
  });
  it("glm without a key is an error, not a silent fallback to the subscription", () => {
    expect(() => engineEnv(src, "glm")).toThrow(/z\.ai API key/);
  });
});

describe("engine arguments", () => {
  it("codex: real codex-cli 0.162 flags, prompt via stdin (`-`), no secrets, no prompt", () => {
    const a = codexArgs({ model: "gpt-5", schemaFile: "/t/schema.json", outFile: "/t/out.txt" });
    expect(a).toEqual(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--ignore-user-config", "-m", "gpt-5", "--output-schema", "/t/schema.json", "-o", "/t/out.txt", "-"]);
    expect(codexArgs({ schemaFile: "s", outFile: "o" })).not.toContain("-m");
  });
  it("codex effort: -c model_reasoning_effort=X, validated, absent when not given", () => {
    expect(codexArgs({ effort: "medium", schemaFile: "s", outFile: "o" })).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=medium"]));
    expect(codexArgs({ schemaFile: "s", outFile: "o" })).not.toContain("-c");
    expect(() => codexArgs({ effort: "low --x", schemaFile: "s", outFile: "o" })).toThrow(/reasoning effort/);
  });
  it("model names that are not plain identifiers never reach argv", () => {
    expect(() => codexArgs({ model: "--dangerously-bypass-approvals-and-sandbox", schemaFile: "s", outFile: "o" })).toThrow(/model name/);
    expect(() => claudeArgs("a b")).toThrow(/model name/);
    expect(() => claudeArgs("x;rm")).toThrow();
  });
  it("the output schema is strict (all properties required, no extras) and mirrors the triage shape", () => {
    const walk = (n: any): void => {
      if (n && typeof n === "object") {
        if (n.type === "object") { expect(n.additionalProperties).toBe(false); expect([...n.required].sort()).toEqual(Object.keys(n.properties).sort()); }
        Object.values(n).forEach(walk);
      }
    };
    walk(CODEX_OUTPUT_SCHEMA);
    expect(CODEX_OUTPUT_SCHEMA.required).toEqual(["summary", "files", "rubric"]);
  });
  it("findings can carry the verbatim quote (without it no finding is line-anchored, so Codex reviews never reach proof tests)", () => {
    const item = (CODEX_OUTPUT_SCHEMA.properties.files.items.properties.findings.items) as unknown as { required: string[]; properties: Record<string, unknown> };
    expect(item.required).toEqual(["line", "quote", "message"]);
    expect(Object.keys(item.properties)).toEqual(["line", "quote", "message"]);
  });
});

describe("parseCodexLastMessage", () => {
  it("returns the JSON text; empty is malformed", () => {
    expect(parseCodexLastMessage(TRIAGE_REPLY)).toBe(TRIAGE_REPLY);
    expect(() => parseCodexLastMessage("  \n")).toThrow(/empty/);
  });
  it("drops the empty evidence objects the strict schema forces, keeps real ones", () => {
    const raw = JSON.stringify({ summary: "s", files: [], rubric: [
      { id: "a", result: "pass", justification: "ok", evidence: { path: "", line: 0, quote: "" } },
      { id: "b", result: "fail", justification: "bad", evidence: { path: "x.ts", line: 0, quote: "q" } },
      { id: "c", result: "fail", justification: "bad", evidence: { path: "x.ts", line: 4, quote: "q" } },
    ] });
    const out = JSON.parse(parseCodexLastMessage(raw));
    expect(out.rubric[0]).not.toHaveProperty("evidence");
    expect(out.rubric[1].evidence).toEqual({ path: "x.ts", quote: "q" });
    expect(out.rubric[2].evidence).toEqual({ path: "x.ts", line: 4, quote: "q" });
  });
  it("non-JSON text is passed through for the shared parser / repair retry", () => {
    expect(parseCodexLastMessage("```json\n{}\n```")).toContain("```");
  });
});

describe("capabilities + settings", () => {
  const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({ v: 1, url: "x", runnerId: "r", name: "n", engine: "claude-code", token: tok("A"), tokenExpiresAt: null, claudeBin: null, registeredAt: "", ...over });
  it("default engine first, billing per engine, models de-duplicated, unusable engines left out", () => {
    const c = cfg({ engine: "codex", engines: { "claude-code": {}, codex: { model: "gpt-5", models: ["o3", "gpt-5", "*"] }, glm: { model: "glm-4.6" }, nope: {} } });
    expect(runnerCaps(c, {})).toEqual([
      { engine: "codex", billing: "subscription", models: ["gpt-5", "o3", "*"], defaultModel: "gpt-5" },
      { engine: "claude-code", billing: "subscription", models: [], defaultModel: null },
    ]); // glm has no key; "nope" is unknown
    const withKey = runnerCaps(c, { ZAI_API_KEY: GLM_KEY });
    expect(withKey.map((x) => `${x.engine}:${x.billing}`)).toEqual(["codex:subscription", "claude-code:subscription", "glm:api-key"]);
    expect(runnerCaps({ ...c, glmApiKey: GLM_KEY }, {}).some((x) => x.engine === "glm")).toBe(true);
  });
  it("a config from runner 0.1.0 (no engines) offers claude-code only; unsafe model names are dropped", () => {
    expect(runnerCaps(cfg(), {})).toEqual([{ engine: "claude-code", billing: "subscription", models: [], defaultModel: null }]);
    expect(runnerCaps(cfg({ engines: { "claude-code": { model: "--x", models: ["ok", "a b"] } } }), {})[0]).toMatchObject({ defaultModel: null, models: ["ok"] });
  });
  it("glm key: config first, then ZAI_API_KEY; blank counts as absent", () => {
    expect(glmKeyOf({ glmApiKey: "cfgkey" }, { ZAI_API_KEY: "envkey" })).toBe("cfgkey");
    expect(glmKeyOf({}, { ZAI_API_KEY: "envkey" })).toBe("envkey");
    expect(glmKeyOf({ glmApiKey: "  " }, {})).toBeUndefined();
  });
  it("--model flags: plain = default engine, engine=model, extras offered, * = any", () => {
    expect(buildEngineSettings(["claude-code", "codex"], "claude-code", ["sonnet", "codex=gpt-5", "codex=o3", "claude-code=opus", "codex=*"])).toEqual({
      "claude-code": { model: "sonnet", models: ["opus"] },
      codex: { model: "gpt-5", models: ["o3", "*"] },
    });
    expect(() => buildEngineSettings(["claude-code"], "claude-code", ["codex=gpt-5"])).toThrow(/not enabled/);
    expect(() => buildEngineSettings(["claude-code"], "claude-code", ["--bad"])).toThrow(/valid model/);
  });
  it("default engine: requested must be enabled; else first enabled", () => {
    expect(pickDefaultEngine(undefined, ["codex", "glm"])).toBe("codex");
    expect(pickDefaultEngine(undefined, [])).toBe("claude-code");
    expect(() => pickDefaultEngine("codex", ["claude-code"])).toThrow(/not installed or not signed in/);
    expect(() => pickDefaultEngine("glm", ["claude-code"])).toThrow(/z\.ai key/);
    expect(() => pickDefaultEngine("gemini", [])).toThrow(/unknown engine/);
  });
});

describe("redaction", () => {
  it("masks z.ai keys, OpenAI keys and key assignments, and literal secrets", () => {
    expect(redact(`key ${GLM_KEY} end`)).toBe("key [redacted] end");
    expect(redact("sk-proj-abcdefghijklmnopqrstuvwxyz0123")).toBe("[redacted]");
    expect(redact("ZAI_API_KEY=abc OPENAI_API_KEY=def CODEX_API_KEY=ghi ANTHROPIC_AUTH_TOKEN=jkl")).toBe("[redacted] [redacted] [redacted] [redacted]");
    expect(redact("plain secretvalue here", ["secretvalue"])).toBe("plain [redacted] here");
    const lines: string[] = [];
    createLogger((l) => lines.push(l), () => [GLM_KEY]).error("boom", { err: `request failed for ${GLM_KEY}` });
    expect(lines.join()).not.toContain("GLMSECRET");
  });
});

// ---------------- end to end through the run loop ----------------
let w: FakeWorker;
let fc: ReturnType<typeof makeFakeClaude>;
let fx: ReturnType<typeof makeFakeCodex>;
let dir: string;
beforeEach(async () => { w = await new FakeWorker().start(); w.validAuth.add(tok("A")); fc = makeFakeClaude(); fx = makeFakeCodex(); dir = tmp(); });
afterEach(async () => { await w.stop(); });

function loop(cfgOver: Partial<RunnerConfig> = {}, over: Partial<RunOptions> = {}, env: Record<string, string> = {}) {
  const { path, cfg } = writeCfg(dir, w.url, cfgOver);
  const cap = captureLog(() => [cfg.token, GLM_KEY]);
  const e = hostEnv(fc.dir, env);
  const ac = new AbortController();
  const o: RunOptions = {
    cfg, configPath: path, log: cap.log, signal: ac.signal, once: true, waitS: 1, heartbeatMs: 100, backoff: { baseMs: 1, maxMs: 5 },
    shutdownGraceMs: 300, env: e, claude: { bin: fc.bin, env: e, killGraceMs: 100 }, codex: { bin: fx.bin, env: e, killGraceMs: 100 }, exec: () => ({ status: 0, output: "Logged in using ChatGPT\n" }), ...over,
  };
  return { o, lines: cap.lines };
}
const payloadWith = (want?: { engine?: string | null; model?: string | null }) => { const p = makePayload(); if (want) p.want = want; return p; };

describe("codex engine", () => {
  it("passes -c model_reasoning_effort: low by default, the configured value when set", async () => {
    w.polls.push(pollJob(payloadWith()));
    expect(await runLoop(loop({ engine: "codex", engines: { codex: {} } }).o)).toBe(0);
    expect(fx.records()[0]!.argv).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=low"]));
    w.polls.push(pollJob(payloadWith()));
    expect(await runLoop(loop({ engine: "codex", engines: { codex: { effort: "high" } } }).o)).toBe(0);
    expect(fx.records()[1]!.argv).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=high"]));
  });
  it("runs `codex exec` read-only with the prompt on stdin; env stripped of OpenAI/Anthropic keys; result carries engine + model", async () => {
    w.polls.push(pollJob(payloadWith()));
    const x = loop({ engine: "codex", engines: { codex: { model: "gpt-5" } } });
    expect(await runLoop(x.o)).toBe(0);
    const [rec] = fx.records();
    expect(rec).toBeDefined();
    expect(rec!.argv).toEqual(expect.arrayContaining(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "-m", "gpt-5", "--output-schema", "-o", "-"]));
    expect(rec!.argv[rec!.argv.length - 1]).toBe("-");
    expect(rec!.argv.join(" ")).not.toContain(DIFF_SENTINEL);
    expect(rec!.stdin).toContain(DIFF_SENTINEL);
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "MERGEJUDGE_RUNNER_TOKEN", "RANDOM_OTHER"]) expect(rec!.env).not.toHaveProperty(k);
    expect(JSON.stringify(rec!.env)).not.toContain("SECRET");
    expect(rec!.env.CODEX_HOME).toBe("/home/u/.codex");
    expect(JSON.parse(rec!.schema!)).toEqual(JSON.parse(JSON.stringify(CODEX_OUTPUT_SCHEMA)));
    expect(fc.records()).toHaveLength(0);
    const r = w.of(/result/)[0]!.body.result;
    expect(w.validations).toEqual([{ ok: true }]);
    expect(r.usage).toMatchObject({ model: "runner:codex · model: gpt-5", engine: "codex", engineModel: "gpt-5", billing: "subscription" });
    expect(r.body).toContain("Mode: runner:codex · model: gpt-5");
    expect(r.findings).toEqual([{ path: "src/a.ts", line: 1, quote: DIFF_SENTINEL, message: "check this" }]);
  });
  it("a missing last-message file or a crash is nacked, not posted", async () => {
    for (const mode of ["nofile", "exit1"]) {
      w.reqs.length = 0; fx.set({ mode });
      w.polls.push(pollJob(payloadWith(), `j-${mode}`));
      expect(await runLoop(loop({ engine: "codex", engines: { codex: {} } }).o)).toBe(0);
      expect(w.of(/result/)).toHaveLength(0);
      expect(w.of(/nack/)).toHaveLength(1);
    }
  });
});

describe("glm engine", () => {
  const glmCfg = { engine: "glm", engines: { glm: { model: "glm-4.6" } }, glmApiKey: GLM_KEY } as Partial<RunnerConfig>;
  it("runs claude -p with the z.ai endpoint + key only in the child env, never in argv, labelled as an API-key engine", async () => {
    w.polls.push(pollJob(payloadWith()));
    const x = loop(glmCfg);
    expect(await runLoop(x.o)).toBe(0);
    const [rec] = fc.records();
    expect(rec!.env.ANTHROPIC_AUTH_TOKEN).toBe(GLM_KEY);
    expect(rec!.env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) expect(rec!.env).not.toHaveProperty(k);
    expect(rec!.argv.join(" ")).not.toContain(GLM_KEY);
    expect(rec!.argv).toEqual(expect.arrayContaining(["--model", "glm-4.6", "--tools", ""]));
    expect(rec!.stdin).not.toContain(GLM_KEY);
    const r = w.of(/result/)[0]!.body.result;
    expect(r.usage).toMatchObject({ engine: "glm", engineModel: "glm-4.6", billing: "api-key" });
    expect(r.usage.model).toBe("runner:glm (API key) · model: glm-4.6");
    expect(x.lines.join("\n")).not.toContain(GLM_KEY);
    expect(x.lines.join("\n")).toContain("glm:glm-4.6(api-key)");
    expect(JSON.stringify(w.reqs)).not.toContain(GLM_KEY); // the key never goes to the Worker
  });
  it("the key can come from ZAI_API_KEY; the runner's own process env is not modified", async () => {
    w.polls.push(pollJob(payloadWith()));
    const before = process.env.ANTHROPIC_AUTH_TOKEN;
    expect(await runLoop(loop({ engine: "glm", engines: { glm: {} } }, {}, { ZAI_API_KEY: GLM_KEY }).o)).toBe(0);
    expect(fc.records()[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe(GLM_KEY);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe(before);
  });
  it("without a key glm is not offered: the job is nacked as unsupported and nothing is spawned", async () => {
    w.polls.push(pollJob(payloadWith({ engine: "glm" })));
    const x = loop({ engine: "claude-code", engines: { "claude-code": {}, glm: {} } });
    expect(await runLoop(x.o)).toBe(0);
    expect(fc.records()).toHaveLength(0);
    expect(w.of(/nack/)[0]!.body).toMatchObject({ code: "unsupported" });
  });
});

describe("model / engine selection", () => {
  it("the repo's engine wins over the runner's default when the runner offers it", async () => {
    w.polls.push(pollJob(payloadWith({ engine: "codex", model: "o3" })));
    const x = loop({ engine: "claude-code", engines: { "claude-code": { model: "sonnet" }, codex: { model: "gpt-5", models: ["o3"] } } });
    expect(await runLoop(x.o)).toBe(0);
    expect(fc.records()).toHaveLength(0);
    expect(fx.records()[0]!.argv).toEqual(expect.arrayContaining(["-m", "o3"]));
    expect(w.of(/result/)[0]!.body.result.usage).toMatchObject({ engine: "codex", engineModel: "o3" });
  });
  it("no wish: the runner's default engine and default model", async () => {
    w.polls.push(pollJob(payloadWith()));
    expect(await runLoop(loop({ engine: "claude-code", engines: { "claude-code": { model: "sonnet" }, codex: {} } }).o)).toBe(0);
    expect(fc.records()[0]!.argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
  });
  it("a wish for an engine the runner does not offer is nacked with a clear reason and code=unsupported; no engine runs", async () => {
    w.polls.push(pollJob(payloadWith({ engine: "codex" })));
    expect(await runLoop(loop().o)).toBe(0);
    expect(fc.records()).toHaveLength(0);
    expect(fx.records()).toHaveLength(0);
    const n = w.of(/nack/);
    expect(n).toHaveLength(1);
    expect(n[0]!.body.code).toBe("unsupported");
    expect(n[0]!.body.reason).toMatch(/does not offer engine "codex" \(offers: claude-code\)/);
    expect(w.of(/result/)).toHaveLength(0);
  });
  it("a wish for a model the runner does not declare is nacked the same way", async () => {
    w.polls.push(pollJob(payloadWith({ engine: "claude-code", model: "opus" })));
    expect(await runLoop(loop({ engines: { "claude-code": { model: "sonnet" } } }).o)).toBe(0);
    expect(w.of(/nack/)[0]!.body).toMatchObject({ code: "unsupported", reason: expect.stringMatching(/does not offer model "opus"/) });
  });
  it("a payload without `want` (older Worker) runs the default; other nacks carry no code", async () => {
    w.polls.push(pollJob(makePayload({ mode: "deep" }), "jd"));
    expect(await runLoop(loop().o)).toBe(0);
    expect(w.of(/nack/)[0]!.body.code).toBeUndefined();
  });
});

describe("declares capabilities", () => {
  it("announces engines, billing and models on the runner heartbeat at start (with the package version)", async () => {
    const x = loop({ engine: "codex", engines: { codex: { model: "gpt-5" }, "claude-code": {}, glm: {} }, glmApiKey: GLM_KEY });
    expect(await runLoop(x.o)).toBe(0);
    const hb = w.reqs.find((r) => r.path === "/heartbeat")!;
    expect(hb.body.version).toBe(VERSION);
    expect(hb.body.capabilities).toEqual([
      { engine: "codex", billing: "subscription", models: ["gpt-5"], defaultModel: "gpt-5" },
      { engine: "claude-code", billing: "subscription", models: [], defaultModel: null },
      { engine: "glm", billing: "api-key", models: [], defaultModel: null },
    ]);
    expect(JSON.stringify(hb.body)).not.toContain(GLM_KEY);
  });
  it("register (non-interactive) sends both `engines` and `capabilities`, and stores the glm key in the 0600 config without printing it", async () => {
    const cfgPath = join(dir, "c", "config.json");
    const out: string[] = [], err: string[] = [];
    const code = await main(["register", "--code", ENROLL, "--url", w.url, "--engine", "glm", "--model", "glm-4.6", "--glm-key-env", "MY_ZAI", "--config", cfgPath],
      { env: { MY_ZAI: GLM_KEY }, out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(code).toBe(0);
    const body = w.reqs[0]!.body;
    expect(body.engines).toEqual(["glm"]);
    expect(body.capabilities).toEqual([{ engine: "glm", billing: "api-key", models: ["glm-4.6"], defaultModel: "glm-4.6" }]);
    expect(JSON.stringify(body)).not.toContain(GLM_KEY);
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(cfgPath, "utf8"))).toMatchObject({ engine: "glm", glmApiKey: GLM_KEY, engines: { glm: { model: "glm-4.6" } } });
    expect([...out, ...err].join("\n")).not.toContain("GLMSECRET");
    expect(out.join("\n")).toContain("API key, billed per use");
    expect(loadConfig(cfgPath).engine).toBe("glm");
  });
  it("register refuses --glm-key-env that looks like a key, and glm without any key", async () => {
    const errs: string[] = [];
    expect(await main(["register", "--code", ENROLL, "--url", w.url, "--engine", "glm", "--glm-key-env", GLM_KEY, "--config", join(dir, "a.json")], { err: (l) => errs.push(l) })).toBe(2);
    expect(errs.join()).toMatch(/NAME of an environment variable/);
    expect(errs.join()).not.toContain("GLMSECRET");
    expect(await main(["register", "--code", ENROLL, "--url", w.url, "--engine", "glm", "--config", join(dir, "b.json")], { env: {}, err: () => {} })).toBe(2);
  });
});

describe("setup: detection of claude and codex, GLM question", () => {
  let home: string;
  const cfgPath = () => join(home, ".config", "mergejudge-runner", "config.json");
  beforeEach(() => { home = tmp("mjr-home-"); });
  const exec = (state: { claude?: number | null; codex?: number | null }, calls: string[][] = []): ExecFn => (bin, args) => {
    calls.push([bin, ...args]);
    const which = bin.endsWith("codex") ? state.codex : state.claude;
    if (which === undefined || which === null) return { status: null };
    return { status: args[0] === "--version" ? 0 : which, output: args[0] === "login" ? "Logged in using ChatGPT\n" : "" }; // installed; the exit code of the login-status probe is `which`
  };
  const setup = async (args: string[], deps: object = {}, state: { claude?: number | null; codex?: number | null } = { claude: 0, codex: 0 }, env: Record<string, string> = {}) => {
    const out: string[] = [], err: string[] = [], calls: string[][] = [];
    const code = await main(["setup", ENROLL, "--no-autostart", ...args, "--config", cfgPath()], {
      env: { MERGEJUDGE_URL: w.url, PATH: "/usr/bin", OPENAI_API_KEY: "sk-openai-SECRET-aaaaaaaaaaaaaaaa", ...env }, home, nodePath: "/usr/bin/node", exec: exec(state, calls),
      fileExists: (p: string) => /\/(claude|codex)$/.test(p), out: (l) => out.push(l), err: (l) => err.push(l), ...deps,
    });
    return { code, out: out.join("\n"), err: err.join("\n"), calls };
  };

  it("both signed in: codex login status / claude auth status probed, both engines declared, claude-code default", async () => {
    const r = await setup(["--no-glm"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(expect.arrayContaining([["/usr/bin/codex", "login", "status"], ["/usr/bin/claude", "auth", "status"]]));
    expect(r.out).toContain("codex: ready");
    expect(r.out).toContain("claude-code: ready");
    expect(w.reqs.find((q) => q.path === "/register")!.body.capabilities.map((c: any) => c.engine)).toEqual(["claude-code", "codex"]);
    expect(loadConfig(cfgPath()).engine).toBe("claude-code");
  });
  it("probe environments never carry OPENAI_API_KEY", async () => {
    const seen: Record<string, string | undefined>[] = [];
    checkCli("codex", "codex", { PATH: "/bin", OPENAI_API_KEY: "sk", CODEX_API_KEY: "ck", CODEX_HOME: "/c" }, (_b, _a, env) => { seen.push(env); return { status: 0 }; });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.OPENAI_API_KEY === undefined && e.CODEX_API_KEY === undefined && e.CODEX_HOME === "/c")).toBe(true);
  });
  it("codex installed but not signed in is warned about and not declared", async () => {
    const r = await setup(["--no-glm"], {}, { claude: 0, codex: 1 });
    expect(r.out).toContain("codex: installed, not signed in (Codex is not signed in with ChatGPT)");
    expect(r.out).toContain("Run `codex login` and choose \"Sign in with ChatGPT\", then run setup again.");
    expect(w.reqs.find((q) => q.path === "/register")!.body.capabilities.map((c: any) => c.engine)).toEqual(["claude-code"]);
  });
  it("only codex signed in: codex becomes the default engine", async () => {
    await setup(["--no-glm"], {}, { claude: 1, codex: 0 });
    expect(loadConfig(cfgPath())).toMatchObject({ engine: "codex", engines: { codex: {} } });
  });
  it("--engine and --model set the default engine and models", async () => {
    await setup(["--no-glm", "--engine", "codex", "--model", "gpt-5", "--model", "claude-code=sonnet", "--model", "codex=o3"]);
    const c = loadConfig(cfgPath());
    expect(c.engine).toBe("codex");
    expect(c.engines).toEqual({ "claude-code": { model: "sonnet" }, codex: { model: "gpt-5", models: ["o3"] } });
    expect(w.reqs.find((q) => q.path === "/register")!.body.capabilities[0]).toEqual({ engine: "codex", billing: "subscription", models: ["gpt-5", "o3"], defaultModel: "gpt-5" });
  });
  it("--codex-effort is stored under engines.codex.effort; invalid values and a missing codex engine are errors", async () => {
    await setup(["--no-glm", "--engine", "codex", "--codex-effort", "medium"]);
    expect(loadConfig(cfgPath()).engines!.codex).toMatchObject({ effort: "medium" });
    const bad = await setup(["--no-glm", "--engine", "codex", "--codex-effort", "turbo", "--force"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/--codex-effort must be one of/);
    const none = await setup(["--no-glm", "--codex-effort", "low", "--force"], {}, { claude: 0, codex: 1 });
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/needs the codex engine/);
  });
  it("--engine for something not signed in is an error and nothing is registered", async () => {
    const r = await setup(["--no-glm", "--engine", "codex"], {}, { claude: 0, codex: 1 });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/not installed or not signed in/);
    expect(w.reqs.find((q) => q.path === "/register")).toBeUndefined();
  });
  it("--glm-key-env stores the key (0600), declares glm as api-key, and never prints it", async () => {
    const r = await setup(["--glm-key-env", "MY_ZAI", "--model", "glm=glm-4.6"], {}, { claude: 0, codex: 0 }, { MY_ZAI: GLM_KEY });
    expect(r.code).toBe(0);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(loadConfig(cfgPath())).toMatchObject({ glmApiKey: GLM_KEY, engines: { glm: { model: "glm-4.6" } } });
    expect(r.out + r.err).not.toContain("GLMSECRET");
    expect(r.out).toMatch(/glm - API key, billed per use/);
    expect(w.reqs.find((q) => q.path === "/register")!.body.capabilities.find((c: any) => c.engine === "glm")).toMatchObject({ billing: "api-key" });
    expect(JSON.stringify(w.reqs)).not.toContain(GLM_KEY);
  });
  it("interactive: answering yes asks for the key (hidden prompt) and stores it; answering no does not", async () => {
    const asked: string[] = [];
    const yes = await setup([], { prompt: async (q: string) => { asked.push(q); return /GLM/.test(q) ? "y" : ""; }, promptSecret: async (q: string) => { asked.push(q); return GLM_KEY; } });
    expect(asked.some((q) => /GLM \(z\.ai\) API key\? It is an API-key engine, billed per use/.test(q))).toBe(true);
    expect(asked.some((q) => /input hidden/.test(q))).toBe(true);
    expect(yes.out + yes.err).not.toContain("GLMSECRET");
    expect(loadConfig(cfgPath()).glmApiKey).toBe(GLM_KEY);
    const home2 = tmp("mjr-home-");
    const out: string[] = [];
    await main(["setup", ENROLL, "--no-autostart", "--force", "--config", join(home2, "c.json")], {
      env: { MERGEJUDGE_URL: w.url, PATH: "/usr/bin" }, home: home2, exec: exec({ claude: 0, codex: 0 }), fileExists: () => false, out: (l) => out.push(l), err: () => {},
      prompt: async (q: string) => (/GLM/.test(q) ? "n" : ""), promptSecret: async () => { throw new Error("must not ask for a key"); },
    });
    expect(loadConfig(join(home2, "c.json")).glmApiKey).toBeUndefined();
  });
  it("a non-interactive run without the flag skips the GLM question (default no)", async () => {
    // no `prompt` dep and stdin is not a TTY under vitest
    const r = await setup([]);
    expect(r.code).toBe(0);
    expect(loadConfig(cfgPath()).glmApiKey).toBeUndefined();
  });
  it("cliWarnings wording for codex", () => {
    expect(cliWarnings([{ name: "claude", installed: true, signedIn: true }, { name: "codex", installed: true, signedIn: false }])[0]).toMatch(/codex login/);
  });
});

describe("codex requires a ChatGPT sign-in", () => {
  const variants: [string, number, string, boolean][] = [
    ["ChatGPT on stdout", 0, "Logged in using ChatGPT\n", true],
    ["ChatGPT after WARNING lines", 0, "WARNING: proceeding\nWARNING: x\nLogged in using ChatGPT\n", true],
    ["API key", 0, "Logged in using an API key - sk-proj-***abcd\n", false],
    ["not logged in", 1, "Not logged in\n", false],
  ];
  for (const [name, status, text, ok] of variants) {
    for (const stream of ["stdout", "stderr"]) {
      it(`${name} (${stream}): checkCli signedIn=${ok}`, () => {
        const fake = makeFakeCodex(); // the real fake binary prints the variant
        writeFileSync(fake.bin, `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nprintf ${JSON.stringify(text)} ${stream === "stderr" ? ">&2" : ""}\nexit ${status}\n`);
        const c = checkCli("codex", fake.bin, { PATH: "/bin:/usr/bin" }, defaultExec);
        expect(c.signedIn).toBe(ok);
        expect(c.apiKeyLogin === true).toBe(name === "API key");
        expect(JSON.stringify(cliWarnings([c]))).not.toMatch(/sk-/);
      });
    }
  }
  it("setup with an API-key login warns, never prints the key, and does not offer codex", async () => {
    const out: string[] = [];
    const home = tmp("mjr-home-");
    const code = await main(["setup", ENROLL, "--no-autostart", "--no-glm", "--config", join(home, "c.json")], {
      env: { MERGEJUDGE_URL: w.url, PATH: "/usr/bin" }, home, nodePath: "/usr/bin/node", fileExists: (p: string) => /\/(claude|codex)$/.test(p),
      exec: (b, a) => ({ status: 0, output: b.endsWith("codex") && a[0] === "login" ? "Logged in using an API key - sk-proj-***abcd\n" : "" }),
      out: (l) => out.push(l), err: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("codex: installed, not signed in (Codex is signed in with an API key, but the runner only uses a ChatGPT sign-in");
    expect(out.join("\n")).not.toContain("sk-proj");
    expect(w.reqs.find((q) => q.path === "/register")!.body.capabilities.map((c: any) => c.engine)).toEqual(["claude-code"]);
  });
  it("runner startup drops codex on API-key login; a codex job is nacked unsupported with a reason, engine never run", async () => {
    w.polls.push(pollJob(payloadWith({ engine: "codex", model: null })));
    const x = loop({ engine: "claude-code", engines: { "claude-code": {}, codex: {} } }, { exec: () => ({ status: 0, output: "Logged in using an API key - sk-x\n" }) });
    expect(await runLoop(x.o)).toBe(0);
    const n = w.of(/nack/)[0]!.body;
    expect(n.code).toBe("unsupported");
    expect(n.reason).toMatch(/API key.*ChatGPT/);
    expect(fx.records()).toHaveLength(0);
    expect(w.of(/heartbeat/).flatMap((h) => (h.body.capabilities ?? []).map((c: any) => c.engine))).not.toContain("codex");
  });
});
