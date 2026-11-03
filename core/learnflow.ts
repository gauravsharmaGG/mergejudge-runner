import type { Config } from "./config.js";
import { FEEDBACK_MARKER, LEARN_CMD, feedbackChanged, hasFeedback, parseFeedback } from "./feedback.js";
import {
  ensureLearningBranch, publishProposalPr, readLearningFile, upsertLearningFile, type Octokit, type Repo,
} from "./github.js";
import { appendLesson, buildLesson, buildProposal, parseLessons, LESSONS_PATH } from "./learning.js";
import { labelProposalPr, planProposal, type ExtraEvidence } from "./proposals.js";
import { isSummaryBody } from "./render.js";

type Log = { info: (m: string) => void; warning: (m: string) => void };

/** The subset of an issue_comment webhook payload used for learning. */
export interface FeedbackPayload {
  action?: string;
  comment?: unknown;
  issue?: unknown;
  sender?: unknown;
  changes?: { body?: { from?: string } };
}

export async function writerAllowed(ok: Octokit, repo: Repo, login: string): Promise<boolean> {
  try {
    const p = await ok.rest.repos.getCollaboratorPermissionLevel({ ...repo, username: login });
    return ["admin", "maintain", "write"].includes(p.data.permission);
  } catch { return false; }
}

async function storeLesson(
  ok: Octokit, repo: Repo, lesson: ReturnType<typeof buildLesson>, learningBranch: string, defaultBranch: string, log: Log,
): Promise<number> {
  await ensureLearningBranch(ok, repo, defaultBranch, learningBranch);
  const { text, sha } = await readLearningFile(ok, repo, LESSONS_PATH, learningBranch);
  const next = appendLesson(text, lesson);
  await upsertLearningFile(
    ok, repo, LESSONS_PATH, next, `learn: PR #${lesson.pr} (${lesson.source})`, sha, learningBranch, defaultBranch,
  );
  log.info(`Stored lesson for PR #${lesson.pr} on ${learningBranch}:${LESSONS_PATH}`);
  return parseLessons(next).length;
}

/**
 * Handle an issue_comment event: feedback checkbox ticks on the sticky comment or `/mergejudge learn`.
 * Write-access humans only. Stores a lesson on the learning branch (write guard). Shared by Action and Worker.
 * If `proposeOnMultiple` is set, a proposal PR is opened/updated each time the lesson count reaches a
 * multiple of learning.propose_after.
 */
export async function runFeedback(o: {
  ok: Octokit; repo: Repo; payload: FeedbackPayload; defaultBranch: string;
  loadConfig: () => Promise<Config>; log: Log; proposeOnMultiple?: boolean;
}): Promise<"stored" | "ignored"> {
  const { ok, repo, payload, defaultBranch, log } = o;
  const comment = payload.comment as {
    id: number; body?: string; user?: { login?: string; type?: string }; html_url?: string;
  } | undefined;
  const issue = payload.issue as { number?: number; pull_request?: unknown } | undefined;
  // Checkbox ticks edit the *bot's* sticky comment; the human is payload.sender.
  const sender = payload.sender as { login?: string; type?: string } | undefined;
  if (!comment || !issue?.pull_request || !issue.number) {
    log.info("Not a PR comment event; nothing to do.");
    return "ignored";
  }

  const isStickyPre = isSummaryBody(comment.body) && !!comment.body?.includes(FEEDBACK_MARKER);
  if (!isStickyPre && !LEARN_CMD.test(comment.body ?? "")) { log.info("Comment is not MergeJudge feedback; ignoring."); return "ignored"; }
  const cfg = await o.loadConfig();
  if (!cfg.learning.enabled) { log.info("Learning disabled in config."); return "ignored"; }

  const isSticky = isSummaryBody(comment.body) && !!comment.body?.includes(FEEDBACK_MARKER);
  const isLearnCmd = LEARN_CMD.test(comment.body ?? "");
  if (!isSticky && !isLearnCmd) { log.info("Comment is not MergeJudge feedback; ignoring."); return "ignored"; }

  // Who acted: for sticky edits use sender (the human who ticked); for learn commands use comment author.
  const actorLogin = isSticky ? sender?.login : comment.user?.login;
  const actorType = isSticky ? sender?.type : comment.user?.type;
  if (!actorLogin) return "ignored";
  if (actorType === "Bot") { log.info("Ignoring bot actor."); return "ignored"; }

  // Checkbox ticks arrive as comment edits; only act when the feedback set changed.
  if (isSticky && payload.action === "edited") {
    const changes = payload.changes;
    if (!feedbackChanged(changes?.body?.from, comment.body)) {
      log.info("Feedback checkboxes unchanged; ignoring.");
      return "ignored";
    }
  } else if (isSticky && payload.action === "created") {
    // Fresh sticky posts start with empty checkboxes — nothing to learn yet.
    log.info("New sticky comment; waiting for checkbox ticks.");
    return "ignored";
  } else if (isLearnCmd && comment.user?.type === "Bot") {
    log.info("Ignoring learn command from a bot.");
    return "ignored";
  }

  const fb = parseFeedback(comment.body);
  if (!hasFeedback(fb)) { log.info("No feedback checked / no learn note."); return "ignored"; }
  const login = actorLogin;
  if (!(await writerAllowed(ok, repo, login))) {
    log.info(`Ignoring feedback from ${login} (no write access).`);
    return "ignored";
  }

  const pr = (await ok.rest.pulls.get({ ...repo, pull_number: issue.number })).data;
  const outcome = pr.merged ? "merged" as const : pr.state === "closed" ? "closed" as const : "open" as const;
  // Recover lane / failed criteria from the sticky comment when possible.
  const sticky = isSticky ? comment.body! :
    (await ok.paginate(ok.rest.issues.listComments, { ...repo, issue_number: issue.number, per_page: 100 }))
      .find((c) => isSummaryBody(c.body))?.body ?? "";
  const laneMatch = sticky.match(/\*\*Overall lane:\*\*\s*[^\n]*`?(auto|review|block)`?/i);
  const lane = (laneMatch?.[1] as "auto" | "review" | "block") ?? "review";
  const failed = [...new Set([...sticky.matchAll(/^\s*-\s*❌\s*`([^`]+)`/gm)].map((m) => m[1]!))];
  const lesson = buildLesson({
    pr: issue.number,
    url: pr.html_url,
    headSha: pr.head.sha,
    lane,
    summary: sticky.split("\n").find((l) => l && !l.startsWith("<") && !l.startsWith("#") && !l.startsWith("*")) ?? "",
    failedCriteria: failed,
    feedback: fb,
    outcome,
    by: login,
    source: isLearnCmd ? "learn_cmd" : "checkbox",
  });
  let count: number;
  try {
    count = await storeLesson(ok, repo, lesson, cfg.learning.branch, defaultBranch, log);
  } catch (e) {
    log.warning(`Could not store lesson (${(e as Error).message}). Need contents:write (App Contents: Read and write).`);
    return "ignored";
  }
  if (o.proposeOnMultiple && count > 0 && count % cfg.learning.propose_after === 0) {
    log.info(`Lesson count ${count} reached a multiple of propose_after=${cfg.learning.propose_after}; proposing.`);
    await runPropose({ ok, repo, cfg, defaultBranch, log });
  }
  return "stored";
}

/**
 * Open or update the learning proposal PR when enough lessons exist, or (Worker) when D1 outcome evidence yields at
 * least one real, guarded edit. Returns its number, or null.
 * Read-only until a proposal exists: a repo with too few lessons and no qualifying edit gets no GitHub write at all —
 * no learning branch, no commit, no PR. Lessons are read from the configured learning branch, so once
 * there are enough of them the branch already exists and nothing needs to be created for the read.
 */
export async function runPropose(o: {
  ok: Octokit; repo: Repo; cfg: Config; defaultBranch: string; log: Log;
  /** Worker only: extra evidence from D1 (outcomes, dismissed findings). Called once. With too few lessons it is the only way to a proposal, and then only a real edit opens one. */
  evidence?: () => Promise<ExtraEvidence>;
}): Promise<number | null> {
  const { ok, repo, cfg, defaultBranch, log } = o;
  if (!cfg.learning.enabled) { log.info("Learning disabled."); return null; }
  const { text } = await readLearningFile(ok, repo, LESSONS_PATH, cfg.learning.branch);
  const lessons = parseLessons(text);
  const lessonProposal = buildProposal(lessons, { threshold: cfg.learning.propose_after });
  // Too few lessons: the Worker's D1 evidence (outcomes, dismissed findings) may still justify real edits on its own.
  // Without an evidence source (the Action) or with edits off, this is the old early return: no write, no extra read.
  const outcomesOnly = !lessonProposal;
  if (outcomesOnly && (!o.evidence || !cfg.learning.proposal.edits)) {
    log.info(`Not enough lessons to propose (${lessons.length}/${cfg.learning.propose_after}).`);
    return null;
  }
  const proposal = lessonProposal ?? { title: "", body: "" };
  const head = "mergejudge/proposal-learning";
  try {
    // Real edits when evidence crosses a threshold; otherwise the record-only report file, as before.
    const plan = await planProposal({
      ok, repo, cfg, defaultBranch, lessons, extra: await o.evidence?.().catch(() => ({})) ?? {}, reportBody: proposal.body, log,
    }).catch((e) => { log.warning(`Could not plan proposal edits (${(e as Error).message}); record-only.`); return null; });
    if (outcomesOnly && !plan) {
      log.info(`Not enough lessons (${lessons.length}/${cfg.learning.propose_after}) and no outcome evidence crossed a threshold; nothing to propose.`);
      return null;
    }
    const pr = await publishProposalPr(ok, repo, {
      learningBranch: cfg.learning.branch,
      defaultBranch,
      headBranch: head,
      title: plan?.title ?? proposal.title,
      body: plan?.body ?? proposal.body,
      filePath: "MERGEJUDGE_LEARNING_PROPOSAL.md",
      fileContent: proposal.body,
      ...(plan ? { files: plan.files } : {}),
    });
    await labelProposalPr(ok, repo, pr.number, log);
    log.info(`${pr.created ? "Opened" : "Updated"} learning proposal PR #${pr.number}: ${pr.url}`);
    return pr.number;
  } catch (e) {
    log.warning(`Could not open learning proposal (${(e as Error).message}).`);
    return null;
  }
}

