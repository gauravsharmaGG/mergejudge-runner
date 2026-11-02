import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../core/config.js";
import type { ContextSource } from "../core/context.js";
import { produceReviewResult } from "../core/review.js";
import type { PrFile } from "../core/types.js";
import { buildWhereItSits, removedExports, renderWhereItSits } from "../core/whereitsits.js";

const pf = (path: string, patch = "", status = "modified"): PrFile => ({ path, status, additions: 1, deletions: 1, patch });
/** Fake repo: `texts` are file contents, `hits` maps a search word to paths. */
const fake = (texts: Record<string, string>, hits: Record<string, string[]> = {}, paths: string[] | null = Object.keys(texts)) => {
  const src = {
    listPaths: vi.fn(async () => paths),
    readFile: vi.fn(async (p: string) => texts[p] ?? null),
    searchSymbol: vi.fn(async (s: string) => hits[s] ?? []),
  };
  return src satisfies ContextSource;
};
const imp = (name: string) => `import { x } from "../core/${name}.js";\n`;

describe("buildWhereItSits", () => {
  it("finds imports and importers, caps them and counts the rest", async () => {
    const texts: Record<string, string> = {
      "core/a.ts": `import "./b.js";\nimport "./c.js";\nimport "./d.js";\nimport "./e.js";\nimport "./z.js";\n`,
      "core/b.ts": "", "core/c.ts": "", "core/d.ts": "", "core/e.ts": "",
    };
    const users = ["src/u1.ts", "src/u2.ts", "src/u3.ts", "src/u4.ts", "src/u5.ts"];
    for (const u of users) texts[u] = imp("a");
    const w = (await buildWhereItSits([pf("core/a.ts")], fake(texts, { a: users })))!;
    expect(w.entries[0]).toMatchObject({
      imports: ["core/b.ts", "core/c.ts", "core/d.ts"], moreImports: 1,
      importedBy: [{ path: "src/u1.ts" }, { path: "src/u2.ts" }, { path: "src/u3.ts" }], moreImportedBy: 2,
    });
  });

  it("drops unconfirmed hits and changed files as neighbours", async () => {
    const texts = { "core/a.ts": "", "core/b.ts": imp("a"), "src/no.ts": 'import "../core/other.js";', "src/ok.ts": imp("a") };
    const w = (await buildWhereItSits([pf("core/a.ts"), pf("core/b.ts")], fake(texts, { a: ["src/no.ts", "core/b.ts", "src/ok.ts", "src/ghost.ts"] })))!;
    expect(w.entries[0]!.importedBy.map((n) => n.path)).toEqual(["src/ok.ts"]);
    expect(w.entries[0]!.moreImportedBy).toBe(0);
  });

  it("marks importers of a removed export", async () => {
    const patch = "@@ -1,2 +1,2 @@\n-export function foo() {}\n-export const keep = 1;\n+export const keep = 2;";
    const texts = { "core/a.ts": "", "src/x.ts": imp("a") + "foo();", "src/y.ts": imp("a") + "keep;" };
    const w = (await buildWhereItSits([pf("core/a.ts", patch)], fake(texts, { a: ["src/x.ts", "src/y.ts"] })))!;
    expect(w.entries[0]!.importedBy).toEqual([{ path: "src/x.ts", risk: "uses removed export `foo`" }, { path: "src/y.ts" }]);
  });

  it("reads removed exports from TS lists and Python defs", () => {
    expect(removedExports("a.ts", "-export { a, b as c };\n-export async function d() {}\n+export const a = 1;")).toEqual(["c", "d"]);
    expect(removedExports("a.py", "-def gone():\n-class Old:\n+def gone():\n-    def method(self):")).toEqual(["Old"]);
  });

  it("uses the folder name for index files", async () => {
    const src = fake({ "core/util/index.ts": "" });
    await buildWhereItSits([pf("core/util/index.ts")], src);
    expect(src.searchSymbol).toHaveBeenCalledWith("util");
  });

  it("limits files, reports moreFiles, honours skip and ignores non-code and removed files", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `core/${n}.ts`);
    const texts = Object.fromEntries(names.map((n) => [n, ""]));
    const list = [...names.map((n) => pf(n)), pf("README.md"), pf("core/gone.ts", "", "removed"), pf("core/skipme.ts")];
    const w = (await buildWhereItSits(list, fake(texts), { max_files: 5, skip: (p) => p.includes("skipme") }))!;
    expect(w.entries.map((e) => e.path)).toEqual(names.slice(0, 5));
    expect(w.moreFiles).toBe(2);
    expect(await buildWhereItSits([pf("README.md"), pf("x.ts", "", "removed")], fake({}))).toBeNull();
  });

  it("returns null when listPaths is null and never throws", async () => {
    expect(await buildWhereItSits([pf("core/a.ts")], fake({}, {}, null))).toBeNull();
    const bad: ContextSource = { listPaths: async () => ["core/a.ts"], readFile: async () => { throw new Error("x"); }, searchSymbol: async () => { throw new Error("y"); } };
    expect((await buildWhereItSits([pf("core/a.ts")], bad))!.entries[0]).toMatchObject({ imports: [], importedBy: [] });
  });

  it("honours the read cap and does not count unread hits", async () => {
    const users = ["src/u1.ts", "src/u2.ts", "src/u3.ts"];
    const texts: Record<string, string> = { "core/a.ts": "" };
    for (const u of users) texts[u] = imp("a");
    const src = fake(texts, { a: users });
    const w = (await buildWhereItSits([pf("core/a.ts")], src, { max_reads: 2, max_neighbours: 1 }))!;
    expect(src.readFile).toHaveBeenCalledTimes(2);
    expect(w.entries[0]).toMatchObject({ importedBy: [{ path: "src/u1.ts" }], moreImportedBy: 0 });
  });

  it("shares importer reads per file so a hub name cannot starve later files", async () => {
    const hub = Array.from({ length: 30 }, (_, i) => `src/h${i}.ts`);
    const texts: Record<string, string> = { "core/utils.ts": "", "core/b.ts": "", "src/y.ts": imp("b") };
    for (const h of hub) texts[h] = imp("utils");
    const w = (await buildWhereItSits([pf("core/utils.ts"), pf("core/b.ts")], fake(texts, { utils: hub, b: ["src/y.ts"] })))!;
    expect(w.entries[1]).toMatchObject({ path: "core/b.ts", importedBy: [{ path: "src/y.ts" }] });
  });

  it("honours the search cap", async () => {
    const src = fake({ "core/a.ts": "", "core/b.ts": "" });
    await buildWhereItSits([pf("core/a.ts"), pf("core/b.ts")], src, { max_searches: 1 });
    expect(src.searchSymbol).toHaveBeenCalledTimes(1);
  });
});

describe("renderWhereItSits", () => {
  it("renders the table", () => {
    const lines = renderWhereItSits({
      entries: [
        { path: "core/a.ts", importedBy: [{ path: "src/x.ts", risk: "uses removed export `foo`" }, { path: "src/y.ts" }], moreImportedBy: 2, imports: ["core/b.ts"], moreImports: 0 },
        { path: "core/p|q.ts", importedBy: [], moreImportedBy: 0, imports: [], moreImports: 0 },
      ],
      moreFiles: 3,
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "<details><summary>Where it sits (2 files)</summary>

      | Changed file | Imported by | Imports |
      |---|---|---|
      | \`core/a.ts\` | \`src/x.ts\` ⚠️ uses removed export \`foo\`, \`src/y.ts\`, +2 more | \`core/b.ts\` |
      | \`core/p\\|q.ts\` | — | — |

      …and 3 more changed files not shown.
      <sub>From import lines and code search only; may miss dynamic imports. Explanatory; does not change the lane.</sub>
      </details>
      "
    `);
  });
});

describe("produceReviewResult flag", () => {
  const files = [pf("core/a.ts", "@@ -1 +1 @@\n+x")];
  const run = async (flag: boolean) => {
    const src = fake({ "core/a.ts": "", "src/x.ts": imp("a") }, { a: ["src/x.ts"] });
    const cfg = parseConfig(`provider:\n  type: none\ncomment:\n  where_it_sits: ${flag}\n`);
    const r = await produceReviewResult({
      pr: { number: 1, node_id: "n", head: { sha: "abc" } }, cfgRef: "main", files, cfg, provider: null,
      log: { info: vi.fn(), warning: vi.fn() }, readRepoFile: async () => null, contextSource: src,
    } as never);
    return { body: (r as { body: string }).body, src };
  };
  it("adds the section only when on, and touches nothing when off", async () => {
    const off = await run(false);
    const on = await run(true);
    expect(off.body).not.toContain("Where it sits");
    expect(off.src.listPaths).not.toHaveBeenCalled();
    expect(on.body).toContain("Where it sits (1 file)");
    expect(on.body).toContain("`src/x.ts`");
    expect(on.body.replace(/<details><summary>Where it sits[\s\S]*?<\/details>\n\n/, "")).toBe(off.body);
  });
});

describe("renderComment", () => {
  it("shows the table only when given one", async () => {
    const { renderComment } = await import("../core/render.js");
    const w = { entries: [{ path: "core/a.ts", importedBy: [], moreImportedBy: 0, imports: ["core/b.ts"], moreImports: 0 }], moreFiles: 0 };
    const agg = { lane: "review", files: [], labelReasons: [], summary: "s", explanation: "e" } as never;
    const body = renderComment({ agg, mode: "m", tokensEstimate: 1, notes: [], policyFiles: [], whereItSits: w });
    expect(body).toContain("Where it sits (1 file)");
    expect(renderComment({ agg, mode: "m", tokensEstimate: 1, notes: [], policyFiles: [] })).not.toContain("Where it sits");
  });
});
