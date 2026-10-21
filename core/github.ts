import type * as github from "@actions/github";
import type { PrFile } from "./types.js";
import { CHECK_CONCLUSION, CHECK_NAME, MARKER, checkSummary } from "./render.js";
import type { Aggregate } from "./aggregate.js";
import { planInline, type InlinePlan } from "./inline.js";
import type { Finding } from "./triage.js";
import { LEARNING_BRANCH, LESSONS_PATH } from "./learning.js";
import { createGuardedWriter, LEGACY_PROPOSAL_BRANCH, PROPOSAL_BRANCH_PREFIX, type GitWriter } from "./writes.js";

export type Octokit = ReturnType<typeof github.getOctokit>;
export interface Repo { owner: string; repo: string }

/** Stands in for the files a bounded listing did not fetch. It has no patch, so the rules raise the lane to at least `review`. */
export const UNLISTED_FILES_PATH = "(more files not listed)";

/**
 * List the PR's files. With `maxFiles` (the Worker's platform bound) listing stops once more than that many files exist:
 * the first `maxFiles` come back plus one `UNLISTED_FILES_PATH` entry, so the list is longer than the bound and an incomplete
 * listing can only make the lane stricter. Without it, every file is listed (the Action and CLI).
 */
export async function fetchPrFiles(ok: Octokit, r: Repo, pull: number, maxFiles?: number): Promise<PrFile[]> {
  const opts = { ...r, pull_number: pull, per_page: 100 };
  let files;
  let more = false;
  if (maxFiles === undefined) files = await ok.paginate(ok.rest.pulls.listFiles, opts);
  else {
    files = [];
    for await (const page of ok.paginate.iterator(ok.rest.pulls.listFiles, opts)) {
      files.push(...page.data);
      if (files.length > maxFiles) { more = true; break; }
    }
    if (files.length > maxFiles) files.length = maxFiles;
  }
  const listed = files.map((f) => ({
    path: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
    previousPath: f.previous_filename,
  }));
  if (more) listed.push({ path: UNLISTED_FILES_PATH, status: "modified", additions: 0, deletions: 0, patch: undefined, previousPath: undefined });
  return listed;
}

export async function upsertStickyComment(ok: Octokit, r: Repo, pull: number, body: string): Promise<void> {
  const comments = await ok.paginate(ok.rest.issues.listComments, { ...r, issue_number: pull, per_page: 100 });
  const existing = comments.find((c) => c.body?.includes(MARKER) && c.user?.type === "Bot");
  if (existing) await ok.rest.issues.updateComment({ ...r, comment_id: existing.id, body });
  else await ok.rest.issues.createComment({ ...r, issue_number: pull, body });
}

export async function createCheckRun(ok: Octokit, r: Repo, headSha: string, agg: Aggregate): Promise<void> {
  const { title, summary } = checkSummary(agg);
  await ok.rest.checks.create({
    ...r,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: CHECK_CONCLUSION[agg.lane],
    output: { title, summary },
  });
}

export async function enableAutoMerge(
  ok: Octokit,
  pullRequestNodeId: string,
  method: "squash" | "merge" | "rebase",
): Promise<void> {
  await ok.graphql(
    `mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod }) { clientMutationId }
    }`,
    { id: pullRequestNodeId, mergeMethod: method.toUpperCase() },
  );
}

export async function approvePr(ok: Octokit, r: Repo, pull: number): Promise<void> {
  await ok.rest.pulls.createReview({
    ...r,
    pull_number: pull,
    event: "APPROVE",
    body: APPROVE_BODY,
  });
}

export async function fetchRepoFile(ok: Octokit, r: Repo, path: string, ref: string): Promise<string | null> {
  try {
    const res = await ok.rest.repos.getContent({ ...r, path, ref });
    const d = res.data as { type?: string; content?: string; encoding?: string };
    if (d.type !== "file" || !d.content) return null;
    return Buffer.from(d.content, "base64").toString("utf8");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/**
 * Load config from the base branch's current tip (so config fixes on main apply to open PRs),
 * falling back to the PR's base SHA. Never reads from the PR head.
 */
export async function fetchBaseConfig(
  ok: Octokit, r: Repo, path: string, base: { ref?: string; sha?: string }, log: (m: string) => void = () => {},
): Promise<{ text: string | null; ref: string }> {
  if (base.ref) {
    try {
      return { text: await fetchRepoFile(ok, r, path, base.ref), ref: base.ref };
    } catch (e) {
      const status = (e as { status?: number }).status;
      log(`Could not read ${path} from base branch ${base.ref} (${typeof status === "number" ? `HTTP ${status}` : "request failed"}); falling back to base SHA.`);
      if (!base.sha) throw e; // nothing to fall back to; surface the real cause (e.g. 409 empty repo), not a generic one
    }
  }
  if (!base.sha) throw new Error("PR has no base ref or SHA; refusing to read config.");
  return { text: await fetchRepoFile(ok, r, path, base.sha), ref: base.sha };
}

/** Post LLM findings as one COMMENT review (never APPROVE), deduped against previous MergeJudge inline comments. */
export async function syncInlineFindings(
  ok: Octokit, r: Repo, pull: number, headSha: string, findings: Finding[],
  warn: (m: string) => void = () => {}, log: (m: string) => void = () => {}, reviewer?: string,
): Promise<InlinePlan> {
  const existing = await ok.paginate(ok.rest.pulls.listReviewComments, { ...r, pull_number: pull, per_page: 100 });
  const plan = planInline(
    findings,
    existing.map((c) => ({ id: c.id, body: c.body, isBot: c.user?.type === "Bot" })),
    { sha: headSha, reviewer },
  );
  const ours = new Set(existing.filter((c) => c.user?.type === "Bot").map((c) => c.id));
  let threads: Map<number, string> | null = null;
  for (const u of plan.update) {
    await ok.rest.pulls.updateReviewComment({ ...r, comment_id: u.id, body: u.body });
    if (!u.thread || !ours.has(u.id)) continue;
    try {
      threads ??= await reviewThreadsByRootComment(ok, r, pull);
      const tid = threads.get(u.id);
      if (!tid) { log(`No review thread found for comment ${u.id}; text updated only.`); continue; }
      const m = u.thread === "resolve" ? "resolveReviewThread" : "unresolveReviewThread";
      await ok.graphql(`mutation($id: ID!) { ${m}(input: { threadId: $id }) { thread { isResolved } } }`, { id: tid });
    } catch (e) {
      warn(`Could not ${u.thread} review thread for comment ${u.id} (${(e as Error).message}); text updated only.`);
    }
  }
  if (plan.create.length) {
    await ok.rest.pulls.createReview({
      ...r,
      pull_number: pull,
      commit_id: headSha,
      event: "COMMENT",
      comments: plan.create.map((c) => ({ path: c.path, line: c.line, side: "RIGHT" as const, body: c.body })),
    });
  }
  return plan;
}

/** Map root review-comment databaseId -> review thread node id (only threads whose first comment matches). */
export async function reviewThreadsByRootComment(ok: Octokit, r: Repo, pull: number): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const res: any = await ok.graphql(
      `query($o: String!, $n: String!, $p: Int!, $a: String) { repository(owner: $o, name: $n) { pullRequest(number: $p) {
        reviewThreads(first: 100, after: $a) { pageInfo { hasNextPage endCursor }
          nodes { id comments(first: 1) { nodes { databaseId } } } } } } }`,
      { o: r.owner, n: r.repo, p: pull, a: after },
    );
    const rt = res.repository.pullRequest.reviewThreads;
    for (const t of rt.nodes) {
      const id = t.comments.nodes[0]?.databaseId;
      if (typeof id === "number") out.set(id, t.id);
    }
    if (!rt.pageInfo.hasNextPage) break;
    after = rt.pageInfo.endCursor;
  }
  return out;
}

export const APPROVE_BODY = "MergeJudge: auto lane — approved.";

/** Dismiss APPROVED reviews authored by this token's identity that carry MergeJudge's approval body. */
export async function dismissOwnApprovals(ok: Octokit, r: Repo, pull: number, botLogin: string | null, message: string): Promise<number> {
  const reviews = await ok.paginate(ok.rest.pulls.listReviews, { ...r, pull_number: pull, per_page: 100 });
  let n = 0;
  for (const rv of reviews) {
    if (rv.state !== "APPROVED" || rv.user?.type !== "Bot" || !rv.body?.startsWith("MergeJudge:")) continue;
    if (botLogin && rv.user?.login !== botLogin) continue;
    await ok.rest.pulls.dismissReview({ ...r, pull_number: pull, review_id: rv.id, message });
    n++;
  }
  return n;
}


function octokitWriter(ok: Octokit, r: Repo): GitWriter {
  return {
    async getRef(ref) {
      const res = await ok.rest.git.getRef({ ...r, ref });
      return { sha: res.data.object.sha };
    },
    async createRef(ref, sha) {
      await ok.rest.git.createRef({ ...r, ref, sha });
    },
    async deleteRef(ref) {
      await ok.rest.git.deleteRef({ ...r, ref });
    },
    async updateRef(ref, sha, force) {
      await ok.rest.git.updateRef({ ...r, ref, sha, force });
    },
    async commitFile({ parentSha, path, contentBase64, message }) {
      const parent = await ok.rest.git.getCommit({ ...r, commit_sha: parentSha });
      const blob = await ok.rest.git.createBlob({ ...r, content: contentBase64, encoding: "base64" });
      const tree = await ok.rest.git.createTree({
        ...r, base_tree: parent.data.tree.sha,
        tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }],
      });
      const commit = await ok.rest.git.createCommit({ ...r, message, tree: tree.data.sha, parents: [parentSha] });
      return commit.data.sha;
    },
    async commitFiles({ parentSha, files, message }) {
      const parent = await ok.rest.git.getCommit({ ...r, commit_sha: parentSha });
      const blobs = [];
      for (const f of files) {
        const blob = await ok.rest.git.createBlob({ ...r, content: f.contentBase64, encoding: "base64" });
        blobs.push({ path: f.path, mode: "100644" as const, type: "blob" as const, sha: blob.data.sha });
      }
      const tree = await ok.rest.git.createTree({ ...r, base_tree: parent.data.tree.sha, tree: blobs });
      const commit = await ok.rest.git.createCommit({ ...r, message, tree: tree.data.sha, parents: [parentSha] });
      return commit.data.sha;
    },
    async createOrUpdateFile({ path, contentBase64, message, branch, sha }) {
      await ok.rest.repos.createOrUpdateFileContents({
        ...r, path, message, content: contentBase64, branch, ...(sha ? { sha } : {}),
      });
    },
  };
}

/** Guarded writer: only learning.branch or mergejudge/proposal-* may be written. */
export function guardedRepoWriter(
  ok: Octokit, r: Repo, learningBranch: string, defaultBranch = "main",
) {
  return createGuardedWriter(octokitWriter(ok, r), { learningBranch, defaultBranch });
}

/** Ensure the learning branch exists (branched from default). Returns its tip SHA. */
export async function ensureLearningBranch(
  ok: Octokit, r: Repo, defaultBranch = "main", learningBranch = LEARNING_BRANCH,
): Promise<string> {
  return guardedRepoWriter(ok, r, learningBranch, defaultBranch).ensureBranchFrom(defaultBranch);
}

/** Read a text file from the learning branch (null if missing). */
export async function readLearningFile(
  ok: Octokit, r: Repo, path = LESSONS_PATH, learningBranch = LEARNING_BRANCH,
): Promise<{ text: string | null; sha: string | null }> {
  try {
    const res = await ok.rest.repos.getContent({ ...r, path, ref: learningBranch });
    const d = res.data as { type?: string; content?: string; sha?: string };
    if (d.type !== "file" || !d.content) return { text: null, sha: d.sha ?? null };
    return { text: Buffer.from(d.content, "base64").toString("utf8"), sha: d.sha ?? null };
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { text: null, sha: null };
    throw e;
  }
}

/** Create or update a file on the learning branch (guarded). */
export async function upsertLearningFile(
  ok: Octokit, r: Repo, path: string, content: string, message: string, sha: string | null,
  learningBranch = LEARNING_BRANCH, defaultBranch = "main",
): Promise<void> {
  const w = guardedRepoWriter(ok, r, learningBranch, defaultBranch);
  await w.ensureBranchFrom(defaultBranch);
  await w.writeFile(path, content, message, learningBranch, sha);
}

/**
 * Publish the learning proposal (head must be mergejudge/proposal-*). An open proposal PR (on the head
 * branch or the legacy branch) is updated in place: its branch is force-moved to a fresh single commit
 * on the default branch, never deleted, so GitHub keeps the PR open. Otherwise the branch is created
 * (or force-reset if stale) and a PR opened. Never merges. All git/contents writes go through the guard.
 */
export async function publishProposalPr(
  ok: Octokit, r: Repo, opts: {
    learningBranch: string; defaultBranch: string; headBranch: string;
    title: string; body: string; filePath: string; fileContent: string;
    /** Several files instead of filePath/fileContent (a proposal with real edits). Paths are checked by the write guard. */
    files?: { path: string; content: string }[];
  },
): Promise<{ number: number; url: string; created: boolean }> {
  if (!opts.headBranch.startsWith(PROPOSAL_BRANCH_PREFIX)) {
    throw new Error(`proposal head must start with ${PROPOSAL_BRANCH_PREFIX}`);
  }
  const w = guardedRepoWriter(ok, r, opts.learningBranch, opts.defaultBranch);
  const baseSha = (await ok.rest.git.getRef({ ...r, ref: `heads/${opts.defaultBranch}` })).data.object.sha;
  const file = { path: opts.filePath, content: opts.fileContent, message: opts.title };
  const reset = (branch: string) => opts.files
    ? w.resetBranchToFilesCommit(branch, baseSha, opts.files, opts.title)
    : w.resetBranchToFileCommit(branch, baseSha, file);

  const existing = await findOpenProposalPr(ok, r, opts.headBranch);
  if (existing) {
    await reset(existing.headRef);
    await ok.rest.pulls.update({ ...r, pull_number: existing.number, title: opts.title, body: opts.body });
    return { number: existing.number, url: existing.url, created: false };
  }

  let branchExists = true;
  try {
    await ok.rest.git.getRef({ ...r, ref: `heads/${opts.headBranch}` });
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    branchExists = false;
  }
  if (branchExists) {
    await reset(opts.headBranch);
  } else {
    await w.createBranch(opts.headBranch, baseSha);
    if (opts.files) await reset(opts.headBranch);
    else await w.writeFile(opts.filePath, opts.fileContent, opts.title, opts.headBranch, null);
  }
  const pr = await ok.rest.pulls.create({
    ...r, title: opts.title, head: opts.headBranch, base: opts.defaultBranch, body: opts.body,
  });
  return { number: pr.data.number, url: pr.data.html_url, created: true };
}

const PROPOSAL_MARKER = "<!-- mergejudge:learning-proposal -->";

interface OpenProposal { number: number; url: string; headRef: string }

/**
 * Find the open proposal PR: head is the configured branch, or (compat) the legacy branch from this
 * repo (not a fork) whose body carries the proposal marker. The configured branch wins.
 */
async function findOpenProposalPr(ok: Octokit, r: Repo, headBranch: string): Promise<OpenProposal | null> {
  const sameRepo = (p: { head: { repo?: { full_name?: string } | null } }) =>
    p.head.repo?.full_name?.toLowerCase() === `${r.owner}/${r.repo}`.toLowerCase();
  const list = (branch: string) =>
    ok.paginate(ok.rest.pulls.list, { ...r, state: "open", head: `${r.owner}:${branch}`, per_page: 10 });
  const current = (await list(headBranch)).find((p) => p.head.ref === headBranch && sameRepo(p));
  if (current) return { number: current.number, url: current.html_url, headRef: headBranch };
  if (headBranch === LEGACY_PROPOSAL_BRANCH) return null;
  const legacy = (await list(LEGACY_PROPOSAL_BRANCH)).find(
    (p) => p.head.ref === LEGACY_PROPOSAL_BRANCH && sameRepo(p) && p.body?.includes(PROPOSAL_MARKER),
  );
  return legacy ? { number: legacy.number, url: legacy.html_url, headRef: LEGACY_PROPOSAL_BRANCH } : null;
}

/** ContextSource over the GitHub API at a fixed head commit: 1 tree call, 1 call per file, 1 per symbol search. */
export function githubContextSource(ok: Octokit, r: Repo, headSha: string): import("./context.js").ContextSource {
  return {
    async listPaths() {
      const t = await ok.rest.git.getTree({ ...r, tree_sha: headSha, recursive: "true" });
      if (t.data.truncated) return null;
      return t.data.tree.filter((e) => e.type === "blob" && e.path).map((e) => e.path!);
    },
    readFile: (path) => fetchRepoFile(ok, r, path, headSha),
    async searchSymbol(symbol) {
      const q = `${symbol} repo:${r.owner}/${r.repo}`;
      const res = await ok.rest.search.code({ q, per_page: 10 });
      return res.data.items.map((i) => i.path);
    },
  };
}

/**
 * Files changed between two commits (compare API, up to 300 files), as index changes. `files` is null when
 * the diff is too large or the call fails; `status` is GitHub's relation of `to` to `from` (ahead, behind, ...).
 */
export async function compareChangedFiles(
  ok: Octokit, r: Repo, from: string, to: string,
): Promise<{ files: import("./deepindex.js").FileChange[] | null; status: string }> {
  const files: import("./deepindex.js").FileChange[] = [];
  let status = "";
  for (let page = 1; page <= 3; page++) {
    const res = await ok.rest.repos.compareCommitsWithBasehead({ ...r, basehead: `${from}...${to}`, per_page: 100, page });
    status = res.data.status;
    const batch = res.data.files ?? [];
    for (const f of batch) {
      if (f.status === "renamed" && f.previous_filename) files.push({ path: f.previous_filename, removed: true });
      files.push({ path: f.filename, removed: f.status === "removed" });
    }
    if (batch.length < 100) return { files, status };
  }
  return { files: null, status };
}
