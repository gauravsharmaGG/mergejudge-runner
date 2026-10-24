import { describe, expect, it } from "vitest";
import { scanSecrets } from "../core/rules.js";

// Built at runtime so no real-looking key sits in source.
const SK_TEST = "sk_test_" + "AbCd3FgH1jKl5NoP7qRs9TuV";
const REAL_AWS = "AKIA" + "Q7ZK3M9TXB2WPD4N";
const REAL_GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0kLmN1oP2qR3s";
const add = (line: string) => `@@ -0,0 +1 @@\n+${line}`;

describe("scanSecrets placeholders", () => {
  it("treats a word-only test api key as a placeholder in a test file", () => {
    const patch = add('  const r = new OpenAITopicRouter({ apiKey: "test-secret-value", model: "x" });');
    const r = scanSecrets(patch, "test/openai.test.ts");
    expect(r.blocked).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toContain("test placeholder");
    expect(r.skipped[0]).toContain("test path");
  });
  it("skips the same value outside a test path", () => {
    const r = scanSecrets(add('apiKey: "test-secret-value"'), "src/config.ts");
    expect(r.blocked).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).not.toContain("test path");
  });
  it.each(["dummy-key", "fake_token", "changeme", "example-api-key"])("skips %s", (v) => {
    const r = scanSecrets(add(`apiKey: "${v}"`), "src/config.ts");
    expect(r.blocked).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });
  it("still blocks a word-only value with no placeholder word", () => {
    expect(scanSecrets(add('apiKey: "orange-banana-grape"'), "src/a.ts").blocked).toEqual(["hard-coded api key"]);
  });
});

describe("scanSecrets still blocks real-looking secrets in test paths", () => {
  const paths = ["test/a.ts", "src/a.test.ts"];
  it.each(paths)("sk_test_ key with random body in %s", (p) => {
    const r = scanSecrets(add(`api_key = "${SK_TEST}"`), p);
    expect(r.blocked).toEqual(["hard-coded api key"]);
    expect(r.skipped).toEqual([]);
  });
  it.each(paths)("random mixed key with digits in %s", (p) => {
    expect(scanSecrets(add('apiKey: "a1B2c3D4e5F6g7H8i9J0kLmN"'), p).blocked).toEqual(["hard-coded api key"]);
  });
  it.each(paths)("AWS key and GitHub token in %s", (p) => {
    expect(scanSecrets(add(`k = "${REAL_AWS}"`), p).blocked).toEqual(["AWS access key"]);
    expect(scanSecrets(add(`t = "${REAL_GH}"`), p).blocked).toEqual(["GitHub token"]);
  });
  it("private key blocks are never skipped", () => {
    const r = scanSecrets(add("-----BEGIN PRIVATE KEY-----"), "test/k.ts");
    expect(r.blocked).toEqual(["private key block"]);
  });
});
