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
  it("flag on adds counts, buckets and per-file labels without mermaid", () => {
    const { body, agg } = mk(true);
    expect(body).toContain("### 🗺️ Lane choice map");
    expect(body).not.toContain("```mermaid");
    expect(body).toContain("| Bucket |");
    expect(body).toContain("| docs | 2 | 0 | 0 | - |");
    expect(body).toContain("🟢 `auto` docs/a.md");
    expect(body).toContain("`mergejudge/lane`");
    expect(body).toContain(`\`${agg.lane}\``);
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
  it("renders a standalone one-file map", () => {
    const agg = aggregate([pf("src/only.ts")], [], parseConfig(""), null);
    const body = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true });
    expect(body).toContain("Why this lane? 🟡 `review` — src/only.ts set the PR lane.");
    expect(body).toContain("🟢 **auto 0** · 🟡 **review 1** · 🔴 **block 0** — 1 file total");
    expect(body).not.toContain("mermaid");
    expect(body).not.toContain("Deeper view");
  });
  it("smokes a 25-file PR with all raisers and more than ten auto files", () => {
    const paths = [
      ...Array.from({ length: 15 }, (_, i) => `docs/guide-${i}.md`),
      ...Array.from({ length: 4 }, (_, i) => `src/module-${i}.ts`),
      ...Array.from({ length: 6 }, (_, i) => `sensitive/change-${i}.ts`),
    ];
    const cfg = parseConfig('lanes:\n  protected:\n    - "sensitive/**"\n');
    const agg = aggregate(paths.map(pf), [], cfg, null);
    const body = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true });
    expect(agg.lane).toBe("block");
    expect(body).toContain("🟢 **auto 15** · 🟡 **review 4** · 🔴 **block 6** — 25 files total");
    const lead = body.split("\n").find((line) => line.startsWith("Why this lane?"))!;
    const bucket = body.split("\n").find((line) => line.startsWith("| sensitive |"))!;
    const list = body.split("### Per-file lanes (25)")[1]!.split("### Files needing human review")[0]!;
    for (const path of paths) expect(list).toContain(path);
    for (const path of paths.slice(19)) {
      expect(lead).toContain(path);
      expect(bucket).toContain(path);
      expect(list).toContain(`${path} — **PR-lane raiser**`);
    }
    expect(list.indexOf(paths[24]!)).toBeLessThan(list.indexOf(paths[15]!));
    expect(list.indexOf(paths[18]!)).toBeLessThan(list.indexOf(paths[0]!));
    expect(body).not.toContain("mermaid");
    const imageBody = renderComment({ agg, mode: "rules-only", tokensEstimate: 0, notes: [], laneMap: true, laneMapImageUrl: "https://x.test/map.gif" });
    expect(imageBody.indexOf("![Lane map]")).toBeLessThan(imageBody.indexOf("Why this lane?"));
    expect(imageBody).toContain("*Decision path: PR opened → directory buckets");
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
