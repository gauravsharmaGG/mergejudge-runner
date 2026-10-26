import type { Aggregate } from "./aggregate.js";
import { LANE_ORDER, maxLane, type FileVerdict, type Lane } from "./types.js";

/** Lane-choice map (opt-in `review.lane_map`): explains how the PR lane was reached. Explanatory only, never changes a lane. */

export interface LaneBucket {
  /** First path segment, or "(root)" for files at the repo root. */
  name: string;
  counts: Record<Lane, number>;
  lane: Lane;
  /** Files whose lane equals the (non-auto) PR lane, i.e. the ones that raised it. */
  raisers: string[];
  files: { path: string; lane: Lane }[];
}

type MapAgg = Pick<Aggregate, "lane" | "files" | "labelReasons">;

export const ROOT_BUCKET = "(root)";
const MAX_MAP_BUCKETS = 8;
const fileCount = (b: LaneBucket) => b.counts.auto + b.counts.review + b.counts.block;

/** Group files by first path segment; buckets are sorted strictest lane first, then by size, then by name. */
export function groupBuckets(agg: Pick<Aggregate, "lane" | "files">): LaneBucket[] {
  const map = new Map<string, LaneBucket>();
  for (const f of agg.files) {
    const i = f.path.indexOf("/");
    const name = i > 0 ? f.path.slice(0, i) : ROOT_BUCKET;
    let b = map.get(name);
    if (!b) map.set(name, (b = { name, counts: { auto: 0, review: 0, block: 0 }, lane: "auto", raisers: [], files: [] }));
    b.counts[f.lane]++;
    b.lane = maxLane(b.lane, f.lane);
    b.files.push({ path: f.path, lane: f.lane });
    if (agg.lane !== "auto" && f.lane === agg.lane) b.raisers.push(f.path);
  }
  return [...map.values()].sort((a, b) => LANE_ORDER[b.lane] - LANE_ORDER[a.lane] || fileCount(b) - fileCount(a) || a.name.localeCompare(b.name));
}

/** Untrusted text into a mermaid-safe label: a conservative character set, capped. */
export function mermaidText(s: string, max = 40): string {
  const t = s.replace(/[^A-Za-z0-9._/ -]/g, "_").trim();
  return (t.length > max ? t.slice(0, max - 1) + "…" : t) || "_";
}

/** GitHub-native mermaid flowchart of the decision path: PR opened → buckets → label holds → PR lane. */
export function renderMermaid(agg: MapAgg, buckets = groupBuckets(agg)): string {
  const L: string[] = ["flowchart LR", `  S(["PR opened"])`];
  const shown = buckets.slice(0, MAX_MAP_BUCKETS);
  const inputs: string[] = [];
  shown.forEach((b, i) => {
    const n = fileCount(b);
    L.push(`  S --> B${i}["${mermaidText(b.name)}: ${n} file${n === 1 ? "" : "s"} → ${b.lane}"]`, `  class B${i} ${b.lane}`);
    inputs.push(`B${i}`);
  });
  if (buckets.length > shown.length) {
    L.push(`  S --> BM["+${buckets.length - shown.length} more buckets"]`);
    inputs.push("BM");
  }
  if (agg.labelReasons.length) {
    L.push(`  S --> LB["${agg.labelReasons.length} label hold${agg.labelReasons.length === 1 ? "" : "s"}"]`);
    inputs.push("LB");
  }
  L.push(`  F{{"PR lane: ${agg.lane}"}}`, `  class F ${agg.lane}`);
  if (!inputs.length) L.push("  S --> F");
  for (const id of inputs) L.push(`  ${id} --> F`);
  L.push("  classDef auto fill:#2da44e,color:#fff", "  classDef review fill:#bf8700,color:#fff", "  classDef block fill:#cf222e,color:#fff");
  return L.join("\n");
}

/* ---------- tiny GIF89a encoder (no dependencies) ---------- */

// 0 background, 1 auto, 2 review, 3 block, 4 track, 5 start box, 6/7 spare
const PALETTE = [[255, 255, 255], [45, 164, 78], [191, 135, 0], [207, 34, 46], [225, 228, 232], [87, 96, 106], [255, 255, 255], [0, 0, 0]];
const LANE_COLOR: Record<Lane, number> = { auto: 1, review: 2, block: 3 };
const MIN_CODE = 3; // 8 colours

/** GIF flavour of LZW: variable code width, clear code when the 4096-entry table is full. */
export function lzw(pixels: Uint8Array, minCode = MIN_CODE): number[] {
  const out: number[] = [];
  let cur = 0, nbits = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  const put = (code: number) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) { out.push(cur & 255); cur >>>= 8; nbits -= 8; }
  };
  let dict = new Map<number, number>();
  put(clear);
  let prefix = pixels[0]!;
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i]!, key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    put(prefix);
    dict.set(key, next);
    // The decoder adds its entry one code later than we do, so widen only once `next` no longer fits.
    if (next === (1 << size) && size < 12) size++;
    next++;
    if (next >= 4096) { put(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  put(prefix);
  put(eoi);
  if (nbits > 0) out.push(cur & 255);
  return out;
}

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const W = 360, ROW = 26, PAD = 10, BAR_X = 120, BAR_W = 220;

/**
 * Animated GIF of the decision path: one row per step (PR opened, one per bucket, label holds, PR lane), revealed frame
 * by frame, then looping. Bars are coloured by lane (green auto, amber review, red block) and sized by file count.
 * Pure and deterministic; the caller hosts the bytes (the sticky comment only ever embeds a URL).
 */
export function buildLaneMapGif(agg: MapAgg): Uint8Array {
  const shown = groupBuckets(agg).slice(0, MAX_MAP_BUCKETS);
  const maxN = Math.max(1, ...shown.map(fileCount));
  const rows: { color: number; frac: number }[] = [{ color: 5, frac: 0.15 }];
  for (const b of shown) rows.push({ color: LANE_COLOR[b.lane], frac: Math.max(0.1, fileCount(b) / maxN) });
  if (agg.labelReasons.length) rows.push({ color: LANE_COLOR[agg.lane], frac: 0.3 });
  rows.push({ color: LANE_COLOR[agg.lane], frac: 1 });
  const H = rows.length * ROW + PAD * 2;

  const bytes: number[] = [..."GIF89a"].map((c) => c.charCodeAt(0));
  bytes.push(...u16(W), ...u16(H), 0x80 | 0x70 | (MIN_CODE - 1), 0, 0);
  for (const c of PALETTE) bytes.push(...c);
  bytes.push(0x21, 0xff, 11, ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0); // loop forever

  for (let visible = 1; visible <= rows.length; visible++) {
    const px = new Uint8Array(W * H);
    const rect = (x: number, y: number, w: number, h: number, c: number) => {
      for (let yy = y; yy < y + h; yy++) px.fill(c, yy * W + x, yy * W + x + w);
    };
    rows.forEach((r, i) => {
      const y = PAD + i * ROW;
      const on = i < visible;
      rect(PAD, y + 4, BAR_X - PAD - 8, ROW - 8, on ? r.color : 4); // step box
      rect(BAR_X, y + 4, BAR_W, ROW - 8, 4); // track
      if (on) rect(BAR_X, y + 4, Math.round(BAR_W * r.frac), ROW - 8, r.color);
    });
    const delay = visible === rows.length ? 250 : 70; // hold the final lane longer
    bytes.push(0x21, 0xf9, 4, 0, ...u16(delay), 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, ...u16(W), ...u16(H), 0, MIN_CODE);
    const data = lzw(px);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

/* ---------- markdown ---------- */

export interface LaneMapOptions {
  /** The sticky already leads with its outcome. */
  omitOutcome?: boolean;
  /** https URL of a hosted copy of `buildLaneMapGif` output. Embedded only when it is a plain https URL. */
  imageUrl?: string;
  /** MergeJudge panel URL; one optional link line, the map stands alone without it. */
  panelUrl?: string;
}

const plainHttps = (u?: string) => (u && /^https:\/\/[^\s()<>"'`]+$/.test(u) ? u : undefined);

/** Hooks the renderer supplies so this module does not import render.ts (which imports it). */
export interface LaneMapRenderEnv {
  emoji: Record<Lane, string>;
  escape: (s: string) => string;
  maxRows: number;
  more: (shown: number, total: number) => string[];
  checkName: string;
  /** Escaped reason text, including any additional AI explanation. */
  reason?: (file: FileVerdict) => string;
}

export function renderLaneMap(agg: MapAgg, env: LaneMapRenderEnv, opts: LaneMapOptions = {}): string[] {
  const { emoji, escape: esc } = env;
  const buckets = groupBuckets(agg);
  const out: string[] = [];
  const img = plainHttps(opts.imageUrl);
  if (img) out.push(`![Lane map](${img})`, "", "_Decision path: PR opened → directory buckets → label / PR holds → final lane; green = auto, amber = review, red = block._", "");
  const raisers = agg.files.filter((f) => agg.lane !== "auto" && f.lane === agg.lane);
  const causes = [
    ...raisers.slice(0, env.maxRows).map((f) => esc(f.path)),
    ...(raisers.length > env.maxRows ? [`${raisers.length - env.maxRows} more files`] : []),
    ...agg.labelReasons.slice(0, env.maxRows).map(esc),
  ];
  const why = causes.length
    ? `raised by ${causes.join("; ")}`
    : agg.lane === "auto" ? `all ${agg.files.length} files are auto; no holds raised the lane` : "no file or hold reason supplied";
  if (!opts.omitOutcome) out.push(`Why this lane? ${emoji[agg.lane]} \`${agg.lane}\` — ${why}.`, "");
  const counts = { auto: 0, review: 0, block: 0 };
  for (const f of agg.files) counts[f.lane]++;
  out.push(`${emoji.auto} \`auto ${counts.auto}\` · ${emoji.review} \`review ${counts.review}\` · ${emoji.block} \`block ${counts.block}\` · **${agg.files.length} files total**`, "", "### 🗺️ Lane choice map", "");
  if (buckets.length) {
    out.push("| Bucket | " + emoji.auto + " auto | " + emoji.review + " review | " + emoji.block + " block |", "|---|---|---|---|");
    for (const b of buckets.slice(0, env.maxRows)) {
      out.push(`| ${esc(b.name)} | ${b.counts.auto} | ${b.counts.review} | ${b.counts.block} |`);
    }
    out.push(...env.more(env.maxRows, buckets.length), "");
  }
  if (agg.files.length) {
    // Sort a copy before capping so late input paths that raise the lane are never displaced by auto files.
    const files = [...agg.files].sort((a, b) => LANE_ORDER[b.lane] - LANE_ORDER[a.lane]);
    out.push(`### File lanes (${agg.files.length})`, "", "Raisers first, then other review/block files, then auto files (up to " + env.maxRows + " rows).", "",
      "| File | Lane | Source | Reason |", "|---|---|---|---|");
    for (const f of files.slice(0, env.maxRows)) {
      const raised = agg.lane !== "auto" && f.lane === agg.lane ? " · **raiser**" : "";
      out.push(`| ${esc(f.path)} | ${emoji[f.lane]} \`${f.lane}\`${raised} | ${esc(f.source ?? "rule")} | ${env.reason?.(f) || esc(f.reasons.join("; ")) || "-"} |`);
    }
    out.push(...env.more(env.maxRows, files.length), "");
  }
  out.push(`${emoji.review} \`review\` is advisory (\`${env.checkName}\` stays neutral); ${emoji.block} \`block\` fails \`${env.checkName}\`. The map only explains the lane.`, "");
  const panel = plainHttps(opts.panelUrl);
  if (panel) out.push(`[Deeper view in MergeJudge panel](${panel})`, "");
  return out;
}
