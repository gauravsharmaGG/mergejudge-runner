import { localImports, resolveImport, type ContextSource } from "./context.js";
import type { PrFile } from "./types.js";

/** A file next to a changed one. `risk` is set when it may break, e.g. "uses removed export `foo`". */
export interface Neighbour { path: string; risk?: string }
export interface WhereItSitsEntry { path: string; importedBy: Neighbour[]; imports: string[]; moreImportedBy: number; moreImports: number }
export interface WhereItSits { entries: WhereItSitsEntry[]; moreFiles: number }

interface Opts { max_files: number; max_neighbours: number; max_reads: number; max_searches: number; skip: (p: string) => boolean }
const DEFAULTS: Opts = { max_files: 5, max_neighbours: 3, max_reads: 20, max_searches: 5, skip: () => false };

const isCode = (p: string) => /\.(m|c)?[jt]sx?$/.test(p) || p.endsWith(".py");

/** Names exported on `-` lines of a patch that no `+` line exports again. */
export function removedExports(path: string, patch: string): string[] {
  const names = (sign: string): Set<string> => {
    const out = new Set<string>();
    for (const line of patch.split("\n")) {
      if (line[0] !== sign || line.startsWith(sign.repeat(3))) continue;
      const t = line.slice(1);
      if (path.endsWith(".py")) {
        const m = /^(?:async\s+)?(?:def|class)\s+(\w+)/.exec(t);
        if (m) out.add(m[1]!);
        continue;
      }
      const m = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type)\s+(\w+)/.exec(t);
      if (m) out.add(m[1]!);
      const list = /^\s*export\s*\{([^}]*)\}/.exec(t);
      for (const n of list?.[1]?.split(",") ?? []) {
        const name = n.trim().split(/\s+as\s+/).pop()!.trim();
        if (/^\w+$/.test(name)) out.add(name);
      }
    }
    return out;
  };
  const added = names("+");
  return [...names("-")].filter((n) => !added.has(n));
}

/** The word to code-search for: the file name without extension, or the folder name for index files. */
function searchTerm(path: string): string {
  const parts = path.split("/");
  const base = parts.pop()!.replace(/\.[^.]+$/, "");
  return base === "index" || base === "__init__" ? parts.pop() ?? "" : base;
}

const riskOf = (text: string, removed: string[]): string | undefined => {
  const hit = removed.find((n) => new RegExp(`\\b${n}\\b`).test(text));
  return hit ? `uses removed export \`${hit}\`` : undefined;
};

/**
 * Import neighbours of the changed files: what each imports and who imports it. Built only from the PR files, their text at head,
 * the path list and code search. Explanatory only; never throws.
 */
export async function buildWhereItSits(files: PrFile[], src: ContextSource, opts: Partial<Opts> = {}): Promise<WhereItSits | null> {
  const o = { ...DEFAULTS, ...opts };
  const cands = files.filter((f) => f.status !== "removed" && isCode(f.path) && !o.skip(f.path));
  if (!cands.length) return null;
  const all = await src.listPaths().catch(() => null);
  if (!all) return null;
  const paths = new Set(all);
  const changed = new Set(files.map((f) => f.path));
  let reads = 0;
  let searches = 0;
  const read = async (p: string): Promise<string | null> => {
    if (reads >= o.max_reads) return null;
    reads++;
    return src.readFile(p).catch(() => null);
  };
  const entries: WhereItSitsEntry[] = [];
  const shown = cands.slice(0, o.max_files);
  // Importer reads per file, so one widely used name cannot spend every read before later files get a turn.
  const perFile = Math.max(1, Math.floor((o.max_reads - shown.length) / shown.length));
  for (const f of shown) {
    const text = await read(f.path);
    const imports = [...new Set(text ? localImports(f.path, text).map((s) => resolveImport(f.path, s, paths)).filter((p): p is string => !!p && p !== f.path) : [])];
    const removed = f.patch ? removedExports(f.path, f.patch) : [];
    const importedBy: Neighbour[] = [];
    let more = 0;
    const term = searchTerm(f.path);
    if (term && searches < o.max_searches) {
      searches++;
      const hits = await src.searchSymbol(term).catch(() => [] as string[]);
      let looked = 0;
      for (const h of [...new Set(hits)]) {
        if (changed.has(h) || !paths.has(h) || !isCode(h)) continue;
        if (looked++ >= perFile) break;
        const t = await read(h);
        if (t === null || !localImports(h, t).some((s) => resolveImport(h, s, paths) === f.path)) continue;
        const risk = riskOf(t, removed);
        if (importedBy.length < o.max_neighbours) importedBy.push({ path: h, ...(risk ? { risk } : {}) });
        else more++;
      }
    }
    entries.push({ path: f.path, importedBy, imports: imports.slice(0, o.max_neighbours), moreImportedBy: more, moreImports: Math.max(0, imports.length - o.max_neighbours) });
  }
  return { entries, moreFiles: Math.max(0, cands.length - o.max_files) };
}

const cell = (p: string) => `\`${p.replace(/\|/g, "\\|")}\``;
const list = (items: string[], more: number) => (items.length ? [...items, ...(more ? [`+${more} more`] : [])].join(", ") : "—");

/** Markdown for the sticky comment: a collapsed table, one row per changed file. */
export function renderWhereItSits(w: WhereItSits): string[] {
  const rows = w.entries.map((e) => {
    const by = list(e.importedBy.map((n) => cell(n.path) + (n.risk ? ` ⚠️ ${n.risk}` : "")), e.moreImportedBy);
    return `| ${cell(e.path)} | ${by} | ${list(e.imports.map(cell), e.moreImports)} |`;
  });
  return [
    `<details><summary>Where it sits (${w.entries.length} file${w.entries.length === 1 ? "" : "s"})</summary>`,
    "",
    "| Changed file | Imported by | Imports |",
    "|---|---|---|",
    ...rows,
    "",
    ...(w.moreFiles > 0 ? [`…and ${w.moreFiles} more changed file${w.moreFiles === 1 ? "" : "s"} not shown.`] : []),
    "<sub>From import lines and code search only; may miss dynamic imports. Explanatory; does not change the lane.</sub>",
    "</details>",
    "",
  ];
}
