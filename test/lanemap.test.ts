import { describe, expect, it } from "vitest";
import { aggregate } from "../core/aggregate.js";
import { parseConfig } from "../core/config.js";
import { buildLaneMapGif, groupBuckets, mermaidText, renderMermaid } from "../core/lanemap.js";
import { renderComment } from "../core/render.js";
import type { PrFile } from "../core/types.js";

const pf = (path: string): PrFile => ({ path, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" });
const files = ["docs/a.md", "docs/b.md", "src/x.ts", "src/y.ts", "migrations/001.sql", "README.md", ...Array.from({ length: 12 }, (_, i) => `pkg${i}/f.ts`)];
const mk = (lane_map?: boolean) => {
  const cfg = parseConfig(lane_map === undefined ? "" : `review:\n  lane_map: ${lane_map}\n`);
  const agg = aggregate(files.map(pf), [], cfg, null);
  return { cfg, agg, body: renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: cfg.review.lane_map }) };
};

describe("review.lane_map flag", () => {
  it("defaults to false", () => {
    expect(parseConfig("").review.lane_map).toBe(false);
    expect(parseConfig("review:\n  mode: context\n").review.lane_map).toBe(false);
  });
  it("is enabled by review.lane_map: true", () => {
    expect(parseConfig("review:\n  lane_map: true\n").review.lane_map).toBe(true);
  });
  it("flag off leaves the sticky unchanged", () => {
    const { agg, body } = mk();
    expect(body).not.toContain("Lane choice map");
    expect(body).not.toContain("mermaid");
    expect(body).toBe(renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [] }));
    expect(mk(false).body).toBe(body);
  });
  it("flag on leads with raisers and counts without mermaid", () => {
    const { body, agg } = mk(true);
    expect(body).toContain("### 🗺️ Lane choice map");
    expect(body).not.toContain("```mermaid");
    expect(body).toContain("| Bucket |");
    expect(body).toContain("| docs | 2 | 0 | 0 |");
    expect(body).toContain("| docs/a.md | 🟢 `auto`");
    expect(body).toContain("`mergejudge/lane`");
    expect(body).toContain(`PR lane: ${agg.lane}`);
    expect(body).not.toContain("Deeper view");
    expect(body).not.toContain("![Lane map]");
  });
  it("embeds image and panel link only when valid https URLs are given", () => {
    const { agg } = mk(true);
    const r = (o: object) => renderComment({ agg, mode: "m", tokensEstimate: 0, notes: [], laneMap: true, ...o });
    expect(r({ laneMapImageUrl: "https://x.test/m.gif", panelUrl: "https://panel.test/pr/1" })).toContain("![Lane map](https://x.test/m.gif)");
    expect(r({ panelUrl: "https://panel.test/pr/1" })).toContain("[Deeper view in MergeJudge panel](https://panel.test/pr/1)");
    const bad = r({ laneMapImageUrl: "javascript:alert(1)", panelUrl: "http://x) [y](z" });
    expect(bad).not.toContain("![Lane map]");
    expect(bad).not.toContain("Deeper view");
    expect(r({ laneMap: false, panelUrl: "https://panel.test/" })).not.toContain("Deeper view");
  });
  it.each(["README.md", "src/app.ts"])("stands alone for one file: %s", (path) => {
    const agg = aggregate([pf(path)], [], parseConfig(""), null);
    const body = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true });
    expect(body).not.toContain("mermaid");
    expect(body).toContain("1 file total");
    expect(body).toContain(`| ${path} |`);
    expect(body.indexOf("Why this lane?")).toBeLessThan(body.indexOf("**auto:"));
    expect(body).not.toContain("Deeper view");
  });
  it("smokes a 25-file PR with every raiser before review and a 16-file auto sample", () => {
    const paths = [
      ...Array.from({ length: 16 }, (_, i) => `docs/page${i}.md`),
      ...Array.from({ length: 4 }, (_, i) => `src/file${i}.ts`),
      ...Array.from({ length: 5 }, (_, i) => `migrations/change${i}.sql`),
    ];
    const cfg = parseConfig("review:\n  lane_map: true\n");
    const agg = aggregate(paths.map(pf), [], cfg, {
      summary: "25-file smoke fixture", findings: [], rubric: [],
      files: new Map(paths.slice(20).map((path) => [path, { lane: "block" as const, reason: "Unsafe migration needs correction" }])),
    });
    const original = agg.files.map((f) => f.path);
    const body = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: cfg.review.lane_map });
    expect(body).not.toContain("mermaid");
    expect(body).toContain("**auto: 16** · 🟡 **review: 4** · 🔴 **block: 5** · 25 files total");
    const lead = body.split("\n").find((line) => line.startsWith("Why this lane?"))!;
    for (const path of paths.slice(20)) {
      expect(lead).toContain(path);
      expect(body).toContain(`| ${path} | 🔴 \`block\` **Raiser** |`);
    }
    for (const path of paths) expect(body).toContain(`| ${path} |`);
    expect(body.indexOf("| migrations/change4.sql |")).toBeLessThan(body.indexOf("| src/file0.ts |"));
    expect(body.indexOf("| src/file3.ts |")).toBeLessThan(body.indexOf("| docs/page0.md |"));
    expect(agg.files.map((f) => f.path)).toEqual(original);
    const imageBody = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true, laneMapImageUrl: "https://x.test/path.gif" });
    expect(imageBody.indexOf("![Lane map]")).toBeLessThan(imageBody.indexOf("Why this lane?"));
    expect(imageBody).toContain("*Decision path:");
  });
  it("keeps late raisers visible when the file table reaches its row cap", () => {
    const agg = aggregate([
      ...Array.from({ length: 110 }, (_, i) => pf(`docs/page${i}.md`)),
      ...Array.from({ length: 5 }, (_, i) => pf(`src/raiser${i}.ts`)),
    ], [], parseConfig(""), null);
    const body = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true });
    for (let i = 0; i < 5; i++) expect(body).toContain(`| src/raiser${i}.ts | 🟡 \`review\` **Raiser** |`);
    expect(body).toContain("**auto: 110** · 🟡 **review: 5** · 🔴 **block: 0** · 115 files total");
    expect(body).toContain("15 more not shown (115 in total)");
    expect(body).not.toContain("| docs/page95.md |");
  });
  it("names PR-level holds even when no file raises the lane", () => {
    const agg = aggregate([pf("README.md")], [], parseConfig(""), null);
    agg.lane = "review";
    agg.labelReasons = ["PR template missing tests"];
    const body = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true });
    expect(body).toContain("Why this lane? review: PR template missing tests reached or held the PR lane.");
    expect(body).not.toContain("**Raiser**");
  });
  it("does not change the PR lane", () => {
    expect(mk(true).agg.lane).toBe(mk(false).agg.lane);
  });
});

describe("bucket grouping", () => {
  it("groups by first path segment, strictest first, with raisers", () => {
    const { agg } = mk(true);
    const b = groupBuckets(agg);
    expect(b).toHaveLength(16);
    expect(b.find((x) => x.name === "docs")!.counts).toEqual({ auto: 2, review: 0, block: 0 });
    expect(b.find((x) => x.name === "(root)")!.files).toHaveLength(1);
    expect(b[b.length - 1]!.lane).toBe("auto");
    expect(b[0]!.lane).toBe(agg.lane);
    if (agg.lane !== "auto") expect(b.flatMap((x) => x.raisers).length).toBe(agg.files.filter((f) => f.lane === agg.lane).length);
  });
  it("caps mermaid buckets and sanitizes names", () => {
    const { agg } = mk(true);
    expect(renderMermaid(agg)).toContain("more buckets");
    expect(mermaidText('a"];x-->y`<b>')).not.toMatch(/["\]`<>]/);
  });
});

/** Minimal GIF LZW decoder, to prove the encoder output is valid, not just well-headed. */
function decodeFirstFrame(g: Uint8Array): Uint8Array {
  let p = 13 + 3 * (1 << ((g[10]! & 7) + 1));
  while (g[p] !== 0x2c) {
    if (g[p] === 0x21) { p += 2; while (g[p] !== 0) p += g[p]! + 1; p++; } else throw new Error("bad block");
  }
  const w = g[p + 5]! | (g[p + 6]! << 8), h = g[p + 7]! | (g[p + 8]! << 8);
  p += 10;
  const min = g[p++]!;
  const data: number[] = [];
  while (g[p] !== 0) { data.push(...g.slice(p + 1, p + 1 + g[p]!)); p += g[p]! + 1; }
  const clear = 1 << min, eoi = clear + 1;
  let size = min + 1, next = eoi + 1, bits = 0, cur = 0, di = 0;
  let table: number[][] = [];
  const reset = () => { table = []; for (let i = 0; i < clear; i++) table[i] = [i]; table[clear] = []; table[eoi] = []; size = min + 1; next = eoi + 1; };
  const out: number[] = [];
  let prev: number[] | null = null;
  reset();
  for (;;) {
    while (bits < size) { cur |= (data[di++] ?? 0) << bits; bits += 8; }
    const code = cur & ((1 << size) - 1);
    cur >>>= size; bits -= size;
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;
    const entry: number[] = table[code] ?? [...prev!, prev![0]!];
    out.push(...entry);
    if (prev) { table[next++] = [...prev, entry[0]!]; if (next === (1 << size) && size < 12) size++; }
    prev = entry;
  }
  expect(out.length).toBe(w * h);
  return Uint8Array.from(out);
}

describe("buildLaneMapGif", () => {
  it("returns a small animated GIF89a", () => {
    const gif = buildLaneMapGif(mk(true).agg);
    expect(new TextDecoder().decode(gif.slice(0, 6))).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(gif.length).toBeGreaterThan(100);
    expect(gif.length).toBeLessThan(80 * 1024);
    expect(new TextDecoder().decode(gif)).toContain("NETSCAPE2.0");
  });
  it("is deterministic and handles an empty PR", () => {
    const agg = mk(true).agg;
    expect(buildLaneMapGif(agg)).toEqual(buildLaneMapGif(agg));
    const empty = buildLaneMapGif({ lane: "auto", files: [], labelReasons: ["x"] });
    expect(new TextDecoder().decode(empty.slice(0, 6))).toBe("GIF89a");
  });
  it("LZW round-trips", () => {
    const px = decodeFirstFrame(buildLaneMapGif(mk(true).agg));
    expect(new Set(px).size).toBeGreaterThan(1);
  });
});
