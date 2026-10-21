import { describe, expect, it } from "vitest";
import { createLogger, redact, redactedLogs, tokenPrefix } from "../src/redact.js";
import { claudeArgs, engineEnv, parseClaudeEnvelope } from "../src/engine.js";
import { defaultConfigPath, validateUrl } from "../src/config.js";
import { parseRetryAfter } from "../src/api.js";

describe("redact", () => {
  it("masks runner tokens, bearer headers, API keys and env-style assignments", () => {
    const tok = `mjr_a_${"x".repeat(43)}`;
    const s = redact(`auth Bearer ${tok} key sk-ant-api03-abcdef ANTHROPIC_API_KEY=sk-123456 MERGEJUDGE_RUNNER_TOKEN=abc ghp_${"a".repeat(30)} ok`);
    expect(s).not.toMatch(/mjr_a_|sk-ant|sk-123456|ghp_|=abc/);
    expect(s).toContain("ok");
  });
  it("masks explicit secrets (>= 6 chars) and ignores trivial ones", () => {
    expect(redact("the password hunter22 here", ["hunter22"])).toBe("the password [redacted] here");
    expect(redact("a b c", ["a"])).toBe("a b c");
  });
  it("logger redacts messages and fields", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), () => ["topsecret-value"], () => new Date(0));
    log.warn("failed for topsecret-value", { err: "Bearer abcdefgh12345", n: 3, skip: undefined });
    expect(lines[0]).toBe('1970-01-01T00:00:00.000Z WARN failed for [redacted] err="[redacted]" n=3');
  });
  it("tokenPrefix shows only the start", () => {
    expect(tokenPrefix(`mjr_a_${"z".repeat(43)}`)).toBe("mjr_a_zzzz…");
  });
  it("masks emails, auth headers, long base64 and long hex", () => {
    expect(redact("ping ada@example.com now")).toBe("ping [redacted] now");
    const header = redact("x-api-key: supersecretvalue and authorization: Bearer abcdefghijklmnop");
    expect(header).not.toContain("supersecretvalue");
    expect(header).not.toContain("abcdefghijklmnop");
    expect(redact(`hex ${"ab".repeat(20)} end`)).toBe("hex [redacted] end");
    expect(redact("sha abcdef1")).toBe("sha abcdef1");
    const b64 = Buffer.from("x".repeat(40)).toString("base64");
    expect(redact(`blob ${b64} end`)).not.toContain(b64);
    const pem = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`;
    expect(redact(`key ${pem} done`)).not.toContain("AAAA");
    expect(redact(`key ${pem} done`)).toContain("done");
  });
  it("drops prompts, diffs and model output instead of printing a slice", () => {
    const secret = "CUSTOMER_FN_pay_amount";
    expect(redact(`diff --git a/a.ts b/a.ts\n+${secret}`)).toBe("[redacted]");
    expect(redact(`@@ -1,2 +1,2 @@\n+${secret}`)).toBe("[redacted]");
    expect(redact(`<untrusted_pr_data>${secret}</untrusted_pr_data>`)).toBe("[redacted]");
    expect(redact(`{"summary":"${secret}","files":[{"lane":"review"}]}`)).toBe("[redacted]");
    expect(redact("x".repeat(4001))).toBe("[redacted]");
  });
  it("redactedLogs is the Action logging path", () => {
    const lines: string[] = [];
    const log = redactedLogs({ info: (m) => lines.push(`I ${m}`), warning: (m) => lines.push(`W ${m}`) }, ["ghp_exampletokenvalue"]);
    log.info("token ghp_exampletokenvalue email a@b.co");
    log.warning(`diff --git a/a.ts b/a.ts\n+code`);
    expect(lines[0]).toBe("I token [redacted] email [redacted]");
    expect(lines[1]).toBe("W [redacted]");
  });
});

describe("engine helpers", () => {
  it("env is an allowlist copy without credentials", () => {
    const e = engineEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", MERGEJUDGE_X: "1", OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", FOO: "bar", CLAUDE_CODE_OAUTH_TOKEN: "own-login", TMPDIR: "/t" });
    expect(e).toEqual({ PATH: "/bin", HOME: "/h", TMPDIR: "/t", CLAUDE_CODE_OAUTH_TOKEN: "own-login" });
  });
  it("args never contain a prompt and disable tools", () => {
    const a = claudeArgs("sonnet");
    expect(a).toEqual(["-p", "--output-format", "json", "--no-session-persistence", "--disable-slash-commands", "--model", "sonnet", "--tools", ""]);
  });
  it("parses the json envelope (object or event array) and rejects errors", () => {
    expect(parseClaudeEnvelope(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi" })).text).toBe("hi");
    expect(parseClaudeEnvelope(JSON.stringify([{ type: "system" }, { type: "result", subtype: "success", result: "yo" }])).text).toBe("yo");
    expect(() => parseClaudeEnvelope("nope")).toThrow(/not JSON/);
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: true, result: "x" }))).toThrow(/error/);
    expect(() => parseClaudeEnvelope(JSON.stringify({ type: "result", subtype: "success", result: "  " }))).toThrow(/empty/);
  });
});

describe("config + api helpers", () => {
  it("url validation", () => {
    expect(validateUrl("https://app.mergejudge.si/")).toBe("https://app.mergejudge.si");
    expect(validateUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(validateUrl("http://127.0.0.1:1")).toBe("http://127.0.0.1:1");
    expect(() => validateUrl("http://app.mergejudge.si")).toThrow();
    expect(() => validateUrl("ftp://x")).toThrow();
    expect(() => validateUrl("https://u:p@x.si")).toThrow();
  });
  it("default config path honours XDG_CONFIG_HOME", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/mergejudge-runner/config.json");
    expect(defaultConfigPath({}, "/home/u")).toBe("/home/u/.config/mergejudge-runner/config.json");
  });
  it("retry-after parsing", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("99999")).toBe(300_000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});
