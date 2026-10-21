/**
 * Local code source for deep reviews (`runner.code_source: local`, runner 0.4.0+).
 * The runner keeps a persistent partial bare clone per repo, fetches the job's base/head SHAs with its OWN git access,
 * computes the PR diff itself, and answers deep retrieval from an index of its own (src/deepindex.ts over `git ls-tree`/`cat-file`).
 * Nothing about the repo's contents came from the Worker; nothing but the review result goes back.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, JOB_LIMITS, partialIndexNote, updateIndex, type FileChange, type IndexLimits, type IndexSnapshot, type IndexSource } from "../core/deepindex.js";
import { retrieveDeepContext } from "../core/deepretrieve.js";
import type { ContextPiece } from "../core/context.js";
import { filterPolicyPaths } from "../core/policy.js";
import { excludeFromLlm } from "../core/rules.js";
import type { PrFile } from "../core/types.js";
import type { Config } from "../core/config.js";
import { cachePaths, cachePolicyFromEnv, cleanupCache, repoKey, SAFE_NAME, SnapshotStore, touchRepo, withRepoLock, type CachePaths, type CachePolicy } from "./cache.js";
import { GitError, runGit, scrubUrl, splitPatches } from "./git.js";
import { scanLocalDiff, type SecretScanResult } from "./secretscan.js";

export const DEFAULT_REMOTE_TEMPLATE = "https://github.com/{owner}/{repo}.git";
/**
 * Defaults for the local index: no 300-file cap, because the index lives on the runner's disk and a read is one `git cat-file`.
 * 20,000 files / 200 MB read / 15 minutes covers a large monorepo and keeps a single job from running away; a bigger repo gets a
 * relevance-ordered partial index (see `buildIndex` seeds) instead of failing.
 */
export const LOCAL_LIMITS: IndexLimits = { ...JOB_LIMITS, maxFiles: 20_000, maxTotalBytes: 200_000_000, maxMs: 15 * 60_000 };
/**
 * What the runner OWNER may set (env `MERGEJUDGE_LOCAL_INDEX_MAX_FILES` / `_MAX_MB` / `_MAX_SECONDS`, flags `--local-index-max-*`,
 * config file `localCode.indexMaxFiles` / `indexMaxMb` / `indexMaxSeconds`). Values outside the range are clamped, invalid ones ignored.
 * The reviewed repository's `.mergejudge.yml` has no say: its content is untrusted on the owner's machine.
 */
export const LOCAL_INDEX_BOUNDS = { files: [1_000, 100_000], mb: [10, 1_000], seconds: [30, 1_800] } as const;
const MAX_PR_FILES = 3000;
const MAX_PATCH_BYTES = 300_000;
const MAX_OVERLAY = 1000;
const MAX_CATCHUP_FILES = 5000;

/** A failure the job reports as its reason (explicit, actionable); never turns into a silent diff-only review. */
export class LocalCodeError extends Error {}

export interface LocalCodeOptions {
  paths: CachePaths;
  /** `{owner}` / `{repo}` placeholders. */
  remoteTemplate: string;
  env: Record<string, string | undefined>;
  policy: CachePolicy;
  limits: IndexLimits;
}

export interface LocalCodeSettings {
  remoteUrlTemplate?: string | null; cacheMaxGb?: number | null; keepSnapshots?: number | null; maxAgeDays?: number | null;
  indexMaxFiles?: number | null; indexMaxMb?: number | null; indexMaxSeconds?: number | null;
}

/** First valid number wins (flag > env > file); invalid (not a positive number) is skipped; the result is clamped to [lo, hi]. */
function boundedSetting(candidates: unknown[], [lo, hi]: readonly [number, number], dflt: number): number {
  for (const c of candidates) {
    const n = typeof c === "string" ? (c.trim() === "" ? NaN : Number(c)) : typeof c === "number" ? c : NaN;
    if (Number.isFinite(n) && n > 0) return Math.min(hi, Math.max(lo, n));
  }
  return dflt;
}

/** LOCAL_LIMITS adjusted by the owner's settings (flag > env > config file > default), always within LOCAL_INDEX_BOUNDS. */
export function resolveLocalLimits(env: Record<string, string | undefined>, file: LocalCodeSettings = {}, flags: LocalCodeSettings = {}): IndexLimits {
  const b = LOCAL_INDEX_BOUNDS;
  const files = boundedSetting([flags.indexMaxFiles, env.MERGEJUDGE_LOCAL_INDEX_MAX_FILES, file.indexMaxFiles], b.files, LOCAL_LIMITS.maxFiles);
  const mb = boundedSetting([flags.indexMaxMb, env.MERGEJUDGE_LOCAL_INDEX_MAX_MB, file.indexMaxMb], b.mb, LOCAL_LIMITS.maxTotalBytes / 1_000_000);
  const seconds = boundedSetting([flags.indexMaxSeconds, env.MERGEJUDGE_LOCAL_INDEX_MAX_SECONDS, file.indexMaxSeconds], b.seconds, LOCAL_LIMITS.maxMs / 1000);
  return { ...LOCAL_LIMITS, maxFiles: Math.floor(files), maxTotalBytes: Math.floor(mb * 1_000_000), maxMs: Math.floor(seconds * 1000) };
}

/** flag > env > config file > default. */
export function resolveLocalCode(env: Record<string, string | undefined>, file: LocalCodeSettings = {}, flags: LocalCodeSettings = {}, home?: string): LocalCodeOptions {
  const remoteTemplate = flags.remoteUrlTemplate || env.MERGEJUDGE_REMOTE_URL_TEMPLATE || file.remoteUrlTemplate || DEFAULT_REMOTE_TEMPLATE;
  if (!remoteTemplate.includes("{owner}") || !remoteTemplate.includes("{repo}")) throw new LocalCodeError("the git remote URL template must contain {owner} and {repo}");
  const base: CachePolicy = cachePolicyFromEnv({}, undefined);
  const fromFile = cachePolicyFromEnv({
    MERGEJUDGE_CACHE_MAX_GB: file.cacheMaxGb ? String(file.cacheMaxGb) : undefined,
    MERGEJUDGE_CACHE_KEEP_SNAPSHOTS: file.keepSnapshots ? String(file.keepSnapshots) : undefined,
    MERGEJUDGE_CACHE_MAX_AGE_DAYS: file.maxAgeDays ? String(file.maxAgeDays) : undefined,
  }, base);
  const policy = cachePolicyFromEnv({ ...env, ...(flags.cacheMaxGb ? { MERGEJUDGE_CACHE_MAX_GB: String(flags.cacheMaxGb) } : {}) }, fromFile);
  return { paths: cachePaths(env, home), remoteTemplate, env, policy, limits: resolveLocalLimits(env, file, flags) };
}

export function remoteUrl(template: string, owner: string, repo: string): string {
  if (!SAFE_NAME.test(owner) || !SAFE_NAME.test(repo) || owner.includes("..") || repo.includes("..")) throw new LocalCodeError(`refusing unsafe repository name "${owner}/${repo}"`);
  return template.replaceAll("{owner}", owner).replaceAll("{repo}", repo);
}

const ACCESS_RE = /could not read from remote|does not appear to be a git repository|authentication failed|could not read (username|password)|permission denied|repository not found|access denied|403|401|terminal prompts disabled|invalid credentials|not found/i;

function accessMessage(owner: string, repo: string, url: string): string {
  return `cannot read ${owner}/${repo} with this runner's own git access (${scrubUrl(url)}). Sign this machine in to GitHub for that repository (credential helper, \`gh auth setup-git\`, a deploy key or SSH remote via MERGEJUDGE_REMOTE_URL_TEMPLATE).`;
}

const gitDirOf = (o: LocalCodeOptions, key: string) => join(o.paths.repos, `${key}.git`);

/** Creates the partial bare clone if missing; points an existing one at the current remote template. */
async function ensureClone(o: LocalCodeOptions, owner: string, repo: string, signal?: AbortSignal): Promise<string> {
  const key = repoKey(owner, repo), dir = gitDirOf(o, key), url = remoteUrl(o.remoteTemplate, owner, repo);
  mkdirSync(o.paths.repos, { recursive: true });
  if (existsSync(join(dir, "HEAD"))) {
    await runGit(["remote", "set-url", "origin", url], { cwd: dir, env: o.env, signal });
    return dir;
  }
  rmSync(dir, { recursive: true, force: true });
  try { await runGit(["clone", "--bare", "--filter=blob:none", "--no-tags", "--quiet", "--", url, dir], { env: o.env, signal }); }
  catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (e instanceof GitError) throw new LocalCodeError(ACCESS_RE.test(e.stderr) ? accessMessage(owner, repo, url) : `git could not fetch ${owner}/${repo} from ${scrubUrl(url)} (${e.message})`);
    throw e;
  }
  return dir;
}

const hasCommit = async (dir: string, sha: string, env: LocalCodeOptions["env"]) => (await runGit(["cat-file", "-e", `${sha}^{commit}`], { cwd: dir, env, allowFail: true })).code === 0;
const pin = (sha: string) => `refs/mj/${sha}`;

/** Fetches the job's commits into the clone and pins them (refs/mj/<sha>) so gc keeps them while they are in use. */
async function fetchCommits(o: LocalCodeOptions, dir: string, owner: string, repo: string, shas: string[], prNumber: number, signal?: AbortSignal): Promise<void> {
  const url = remoteUrl(o.remoteTemplate, owner, repo);
  for (const sha of shas) if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new LocalCodeError(`job carries an invalid commit id`);
  const missing: string[] = [];
  for (const sha of shas) if (!(await hasCommit(dir, sha, o.env))) missing.push(sha);
  if (missing.length) {
    try { await runGit(["fetch", "--no-tags", "--quiet", "--filter=blob:none", "origin", ...missing.map((s) => `+${s}:${pin(s)}`)], { cwd: dir, env: o.env, signal }); }
    catch (e) {
      // A server that will not serve bare SHAs: the PR ref carries the head, the default branch carries the base.
      await runGit(["fetch", "--no-tags", "--quiet", "--filter=blob:none", "origin", `+refs/pull/${prNumber}/head:refs/mj/pr-${prNumber}`, "+HEAD:refs/mj/default"], { cwd: dir, env: o.env, signal, allowFail: true });
      const still: string[] = [];
      for (const sha of missing) if (!(await hasCommit(dir, sha, o.env))) still.push(sha);
      if (still.length) {
        if (e instanceof GitError) throw new LocalCodeError(ACCESS_RE.test(e.stderr) ? accessMessage(owner, repo, url) : `commit ${still[0]!.slice(0, 7)} is not available from ${scrubUrl(url)} (force-pushed away or not reachable)`);
        throw e;
      }
    }
  }
  for (const sha of shas) await runGit(["update-ref", pin(sha), sha], { cwd: dir, env: o.env, allowFail: true });
}

// ---------------- diff ----------------
function parseNameStatus(out: string): { status: string; path: string; previousPath?: string }[] {
  const parts = out.split("\0");
  const res: { status: string; path: string; previousPath?: string }[] = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i++];
    if (!st) continue;
    const c = st[0]!;
    if (c === "R" || c === "C") { const from = parts[i++]!, to = parts[i++]!; res.push({ status: c === "R" ? "renamed" : "added", path: to, ...(c === "R" ? { previousPath: from } : {}) }); }
    else { const p = parts[i++]!; res.push({ status: c === "A" ? "added" : c === "D" ? "removed" : "modified", path: p }); }
  }
  return res;
}

function parseNumstat(out: string): Map<string, { add: number; del: number }> {
  const m = new Map<string, { add: number; del: number }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length;) {
    const head = parts[i++];
    if (!head) continue;
    const [a, d, p] = head.split("\t");
    let path = p ?? "";
    if (path === "") { i++; path = parts[i++] ?? ""; } // rename: "add\tdel\t" NUL old NUL new
    m.set(path, { add: a === "-" ? 0 : Number(a), del: d === "-" ? 0 : Number(d) });
  }
  return m;
}

export { splitPatches };

/** PR files exactly as the Worker would list them (merge-base diff, renames detected), patches included except for diff_exclude and huge ones. */
export async function localPrFiles(dir: string, baseSha: string, headSha: string, cfg: Pick<Config, "diff_exclude">, env: LocalCodeOptions["env"], signal?: AbortSignal): Promise<PrFile[]> {
  const range = `${baseSha}...${headSha}`;
  const g = { cwd: dir, env, signal };
  const [ns, num, diff] = await Promise.all([
    runGit(["diff", "-M", "--name-status", "-z", range], g),
    runGit(["diff", "-M", "--numstat", "-z", range], g),
    runGit(["diff", "-M", "-U3", "--no-color", "--no-ext-diff", range], { ...g, maxBytes: 256 * 1024 * 1024 }),
  ]);
  const status = parseNameStatus(ns.stdout).slice(0, MAX_PR_FILES);
  const counts = parseNumstat(num.stdout), patches = splitPatches(diff.stdout);
  const { skipped } = excludeFromLlm(status, cfg.diff_exclude);
  const skip = new Set(skipped);
  return status.map((f) => {
    const c = counts.get(f.path);
    const patch = skip.has(f.path) ? undefined : patches.get(f.path);
    return { path: f.path, status: f.status, additions: c?.add ?? 0, deletions: c?.del ?? 0, ...(f.previousPath ? { previousPath: f.previousPath } : {}), ...(patch && patch.length <= MAX_PATCH_BYTES ? { patch } : {}) };
  });
}

// ---------------- IndexSource over git ----------------
/** Files of one commit: listPaths = `git ls-tree -r`, readFile = one persistent `git cat-file --batch`. Missing blobs are fetched in bulk first. */
export class GitSource implements IndexSource {
  private oids = new Map<string, string>();
  private listed = false;
  private proc?: ReturnType<typeof spawn>;
  private buf = Buffer.alloc(0);
  private waiter?: () => void;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private dir: string, private sha: string, private env: LocalCodeOptions["env"], private limits: IndexLimits, private signal?: AbortSignal) {}

  private async list(): Promise<void> {
    if (this.listed) return;
    const r = await runGit(["ls-tree", "-r", "-z", "--full-tree", this.sha], { cwd: this.dir, env: this.env, signal: this.signal, maxBytes: 256 * 1024 * 1024 });
    for (const line of r.stdout.split("\0")) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
      if (m && m[2] === "blob" && m[1] !== "120000") this.oids.set(m[4]!, m[3]!);
    }
    this.listed = true;
  }

  async listPaths(): Promise<string[]> {
    await this.list();
    return [...this.oids.keys()]; // buildIndex calls prefetch() for the files it is about to read, in its own order
  }

  /** One `git fetch --stdin` for the blobs of `paths` that the partial clone does not have yet (best effort: reads fall back to lazy fetch). */
  async prefetch(paths: string[]): Promise<void> {
    await this.list();
    const oids = [...new Set(paths.flatMap((p) => this.oids.get(p) ?? []))];
    if (!oids.length) return;
    const check = await runGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { cwd: this.dir, env: { ...this.env, GIT_NO_LAZY_FETCH: "1" }, input: oids.join("\n") + "\n", allowFail: true, signal: this.signal });
    const missing = check.stdout.split("\n").flatMap((l) => (/^([0-9a-f]+) missing$/.exec(l)?.[1] ?? []));
    for (let i = 0; i < missing.length; i += 2000) {
      await runGit(["fetch", "origin", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin"], {
        cwd: this.dir, env: this.env, input: missing.slice(i, i + 2000).join("\n") + "\n", allowFail: true, signal: this.signal,
      });
    }
  }

  private start() {
    if (this.proc) return;
    const env = { ...process.env, ...this.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;
    this.proc = spawn("git", ["cat-file", "--batch"], { cwd: this.dir, env, stdio: ["pipe", "pipe", "ignore"], signal: this.signal });
    this.proc.stdout!.on("data", (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.waiter?.(); });
    this.proc.on("close", () => { this.closed = true; this.waiter?.(); });
    this.proc.on("error", () => { this.closed = true; this.waiter?.(); });
    this.proc.stdin!.on("error", () => {});
  }

  private async need(pred: () => boolean): Promise<boolean> {
    while (!pred()) {
      if (this.closed) return false;
      await new Promise<void>((r) => { this.waiter = r; });
    }
    return true;
  }

  private async readOne(path: string): Promise<string | null> {
    await this.list();
    const oid = this.oids.get(path);
    if (!oid) return null;
    this.start();
    this.proc!.stdin!.write(`${oid}\n`);
    if (!(await this.need(() => this.buf.includes(10)))) return null;
    const nl = this.buf.indexOf(10);
    const header = this.buf.subarray(0, nl).toString("utf8");
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) { this.buf = this.buf.subarray(nl + 1); return null; } // "<oid> missing"
    const size = Number(m[2]);
    if (!(await this.need(() => this.buf.length >= nl + 1 + size + 1))) return null;
    const body = this.buf.subarray(nl + 1, nl + 1 + size);
    this.buf = this.buf.subarray(nl + 1 + size + 1);
    return body.includes(0) ? null : body.toString("utf8");
  }

  /** An arrow property: updateIndex takes `src.readFile` unbound. */
  readFile = (path: string): Promise<string | null> => {
    const next = this.chain.then(() => this.readOne(path), () => this.readOne(path));
    this.chain = next.catch(() => {});
    return next;
  };

  close() { try { this.proc?.stdin?.end(); this.proc?.kill(); } catch { /* gone */ } }
}

// ---------------- the whole preparation ----------------
export interface LocalJobInput {
  owner: string; repo: string; prNumber: number; baseSha: string; headSha: string;
  cfg: Config; cfgRef: string;
}
export interface LocalJobData {
  files: PrFile[];
  pieces: ContextPiece[];
  policyFiles: Record<string, string>;
  notes: string[];
  /** Secret scan of the full local diff (every changed file, not just the ones with a patch). */
  secrets: SecretScanResult;
}

async function nameStatusChanges(dir: string, from: string, to: string, env: LocalCodeOptions["env"], signal?: AbortSignal): Promise<FileChange[]> {
  const r = await runGit(["diff", "-M", "--name-status", "-z", from, to], { cwd: dir, env, signal });
  return parseNameStatus(r.stdout).flatMap((f) => [...(f.previousPath ? [{ path: f.previousPath, removed: true }] : []), { path: f.path, removed: f.status === "removed" }]);
}

const inUse = new Set<string>();

/**
 * Everything a deep review needs from the repo, computed locally under the repo's lock: clone/fetch, PR diff,
 * base snapshot (incremental from the newest earlier one, else a full build), head overlay, retrieval.
 */
export async function prepareLocalJob(o: LocalCodeOptions, j: LocalJobInput, log: (m: string) => void, signal?: AbortSignal): Promise<LocalJobData> {
  const key = repoKey(j.owner, j.repo);
  remoteUrl(o.remoteTemplate, j.owner, j.repo); // validates the names before any path is built
  inUse.add(key);
  try {
    return await withRepoLock(o.paths, key, async () => {
      mkdirSync(o.paths.idx, { recursive: true });
      touchRepo(o.paths, key);
      const dir = await ensureClone(o, j.owner, j.repo, signal);
      await fetchCommits(o, dir, j.owner, j.repo, [j.baseSha, j.headSha], j.prNumber, signal);
      const notes: string[] = [];
      const secrets = await scanLocalDiff(dir, j.baseSha, j.headSha, j.headSha, o.env, log, signal);
      const files = await localPrFiles(dir, j.baseSha, j.headSha, j.cfg, o.env, signal);
      const skipFn = (p: string) => excludeFromLlm([{ path: p }], j.cfg.diff_exclude).skipped.length > 0;
      const kept = files.filter((f) => !skipFn(f.path));

      const store = new SnapshotStore(join(o.paths.idx, key));
      const base = new GitSource(dir, j.baseSha, o.env, o.limits, signal), head = new GitSource(dir, j.headSha, o.env, o.limits, signal);
      try {
        let snap: IndexSnapshot | null = store.get(j.baseSha);
        if (snap) notes.push(`index snapshot for base ${j.baseSha.slice(0, 7)} reused`);
        const prev = snap ? null : store.latest();
        if (!snap && prev && (await hasCommit(dir, prev.sha, o.env))) {
          const changes = await nameStatusChanges(dir, prev.sha, j.baseSha, o.env, signal);
          if (changes.length <= MAX_CATCHUP_FILES) {
            await base.prefetch(changes.filter((c) => !c.removed).map((c) => c.path));
            snap = (await updateIndex(prev, base, changes, j.baseSha, o.limits)).snapshot;
            notes.push(`index updated incrementally from ${prev.sha.slice(0, 7)} (${changes.length} changed file(s))`);
          }
        }
        if (!snap) {
          // Seeded: if a cap stops the build, the files this PR touches come first. A complete build is identical to an unseeded one.
          const built = await buildIndex(base, { repo: `${j.owner}/${j.repo}`, sha: j.baseSha }, o.limits, Date.now, { seeds: { files: kept.flatMap((f) => [{ path: f.path, patch: f.patch }, ...(f.previousPath ? [{ path: f.previousPath, patch: f.patch }] : [])]) } });
          if (!built.snapshot) throw new LocalCodeError(`could not list the files of ${j.baseSha.slice(0, 7)} in the local clone`);
          snap = built.snapshot;
          notes.push(`index built from scratch (${Object.keys(snap.files).length} file(s))`);
        }
        // A relevance-ordered partial index is biased to this PR: use it now, but never keep it for other PRs to reuse.
        if (!snap.partial?.ordered && (snap.sha !== j.baseSha || !store.get(j.baseSha))) store.put(snap);
        if (snap.partial?.ordered) notes.push(`Deep mode ${partialIndexNote(snap)}; not saved for other pull requests.`);
        else if (snap.partial) notes.push(`index is partial (${snap.partial.indexed}/${snap.partial.total} files: ${snap.partial.reason})`);

        const changes: FileChange[] = files.slice(0, MAX_OVERLAY).flatMap((f) => [
          ...(f.previousPath ? [{ path: f.previousPath, removed: true }] : []),
          { path: f.path, removed: f.status === "removed" },
        ]);
        await head.prefetch(changes.filter((c) => !c.removed).map((c) => c.path));
        const overlay = (await updateIndex(snap, head, changes, j.headSha, o.limits)).snapshot;
        const r = await retrieveDeepContext(overlay, kept, { skip: skipFn }, log);

        const policyFiles: Record<string, string> = {};
        const cfgSha = /^[0-9a-f]{7,64}$/.test(j.cfgRef) ? j.cfgRef : j.baseSha;
        const policySource = cfgSha === j.baseSha ? base : new GitSource(dir, cfgSha, o.env, o.limits, signal);
        for (const p of filterPolicyPaths(j.cfg.policy_files, j.cfg.policy_exclude)) {
          const t = await policySource.readFile(p).catch(() => null);
          if (t) policyFiles[p] = t.slice(0, j.cfg.policy.max_each_bytes + 1); // +1 char so loadPolicies still sees the cut
        }
        if (policySource !== base) (policySource as GitSource).close();
        notes.push("Deep mode on a runner with a local clone: repo context was retrieved from an index on this machine and reviewed in one pass (no tool calls).");
        return { files, pieces: r.pieces, policyFiles, notes, secrets };
      } finally { base.close(); head.close(); }
    }, signal);
  } finally { inUse.delete(key); }
}

/** After a job: drop pins of commits no snapshot needs, then apply the cache limits. Never throws. */
export async function afterLocalJob(o: LocalCodeOptions, owner: string, repo: string, log: (m: string) => void): Promise<void> {
  try {
    const key = repoKey(owner, repo), dir = gitDirOf(o, key);
    if (existsSync(dir)) {
      await withRepoLock(o.paths, key, async () => {
        const keep = new Set(new SnapshotStore(join(o.paths.idx, key)).list().map((s) => s.sha));
        const refs = (await runGit(["for-each-ref", "--format=%(refname)", "refs/mj/"], { cwd: dir, env: o.env, allowFail: true })).stdout.split("\n").filter(Boolean);
        for (const r of refs) if (!keep.has(r.slice("refs/mj/".length))) await runGit(["update-ref", "-d", r], { cwd: dir, env: o.env, allowFail: true });
      });
    }
    const res = cleanupCache(o.paths, o.policy, inUse);
    if (res.prunedSnapshots || res.evicted.length) log(`local cache: pruned ${res.prunedSnapshots} snapshot(s), evicted ${res.evicted.map((e) => `${e.key} (${e.reason})`).join(", ") || "none"}`);
  } catch (e) { log(`local cache cleanup failed: ${(e as Error).message.slice(0, 160)}`); }
}
