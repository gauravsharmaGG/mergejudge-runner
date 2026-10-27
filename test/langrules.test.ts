import { describe, expect, it } from "vitest";
import { buildLanguageRulesPrompt } from "../core/langrules.js";
import type { PrFile } from "../core/types.js";

const f = (path: string): PrFile => ({ path, status: "modified", additions: 1, deletions: 0 });

describe("buildLanguageRulesPrompt", () => {
  it("is empty without matching files", () => {
    expect(buildLanguageRulesPrompt([])).toBe("");
    expect(buildLanguageRulesPrompt([f("README.md")])).toBe("");
  });
  it("activates only TS rules for TS files", () => {
    const s = buildLanguageRulesPrompt([f("src/a.tsx")]);
    expect(s).toContain("TS/JS/React");
    expect(s).not.toContain("Python");
    expect(s).not.toContain("Go:");
  });
  it("combines mixed stacks", () => {
    const s = buildLanguageRulesPrompt([f("a.py"), f("b.go"), f("c.rs")]);
    expect(s).toContain("Python");
    expect(s).toContain("Go:");
    expect(s).toContain("Rust/C/C++/Java/Kotlin");
  });
  it("activates GitHub Actions rules for workflow paths", () => {
    expect(buildLanguageRulesPrompt([f(".github/workflows/ci.yml")])).toContain("GitHub Actions");
    expect(buildLanguageRulesPrompt([f("config/ci.yml")])).toBe("");
  });
  it("activates SQL rules for migrations", () => {
    expect(buildLanguageRulesPrompt([f("db/migrations/001_init.ts")])).toContain("SQL/migrations");
    expect(buildLanguageRulesPrompt([f("schema.sql")])).toContain("SQL/migrations");
  });
  it("stays bounded with every stack", () => {
    const s = buildLanguageRulesPrompt(["a.ts", "a.py", "a.go", "a.rs", ".github/workflows/x.yaml", "m.sql"].map(f));
    expect(s.length).toBeLessThanOrEqual(2500);
  });
});
