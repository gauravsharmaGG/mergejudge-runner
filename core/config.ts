import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_POLICY_FILES, POLICY_MAX_EACH, POLICY_MAX_TOTAL } from "./policy.js";
import { assertSafeLearningBranch } from "./writes.js";
import { DEFAULT_ENABLED_PACKS, criterionSchema } from "./rubrics.js";

export const DEFAULT_PROTECTED = [
  ".github/**",
  "deploy/**",
  "**/auth/**",
  "**/migrations/**",
  "wrangler.toml",
  "_headers",
  "**/_headers",
  "**/.env*",
];
export const DEFAULT_DIFF_EXCLUDE = [
  "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/Cargo.lock",
  "**/composer.lock", "**/Gemfile.lock", "**/poetry.lock",
  "dist/**", "build/**", "out/**", "coverage/**", ".next/**",
  "**/*.min.js", "**/*.min.css", "**/*.map",
  "**/*.{png,jpg,jpeg,gif,webp,ico,svg,woff,woff2,ttf,eot,mp4,webm,pdf}",
  "**/generated/**", "**/*.generated.*",
];

export const DEFAULT_AUTO = ["docs/**", "**/*.md", "**/*.css", "public/**"];

/** Every supported `provider.type`; createProvider (src/llm/index.ts) must handle each one (compile-checked). */
export const PROVIDER_TYPES = ["openai-compatible", "openai", "anthropic", "zai", "workers-ai", "none"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

const providerSchema = z
  .object({
    type: z.enum(PROVIDER_TYPES).default("none"),
    /** openai only: "chat" (Chat Completions, default) or "responses" (Responses API). */
    api: z.enum(["chat", "responses"]).optional(),
    /** zai only: "paygo" (api.z.ai/api/paas/v4, default) or "coding" (coding-plan endpoint). */
    endpoint: z.enum(["paygo", "coding"]).optional(),
    base_url: z.string().optional(),
    model: z.string().optional(),
    api_key_env: z.string().optional(),
    /**
     * Model-call time limits. One call, including retries, stays within `budget_ms` (default 240s) so a review
     * fits the runner's 10-minute job and a Worker invocation. `timeout_ms` (default 120s) aborts a single attempt.
     * Retries (network, 408, 429, 5xx: up to `max_retries`; an attempt that timed out: up to `max_timeout_retries`,
     * counted inside `max_retries`) wait at most `max_delay_ms`, including a Retry-After header.
     * Env MERGEJUDGE_LLM_TIMEOUT_MS, MERGEJUDGE_LLM_MAX_RETRIES, MERGEJUDGE_LLM_MAX_TIMEOUT_RETRIES,
     * MERGEJUDGE_LLM_BUDGET_MS and MERGEJUDGE_LLM_MAX_DELAY_MS override these when set to integers.
     */
    timeout_ms: z.number().int().min(1_000).max(180_000).default(120_000),
    max_retries: z.number().int().min(0).max(4).default(2),
    max_timeout_retries: z.number().int().min(0).max(4).default(1),
    budget_ms: z.number().int().min(1_000).max(300_000).default(240_000),
    max_delay_ms: z.number().int().min(0).max(10_000).default(4_000),
  })
  .default({ type: "none", timeout_ms: 120_000, max_retries: 2, max_timeout_retries: 1, budget_ms: 240_000, max_delay_ms: 4_000 });

const approvalSchema = z
  .object({
    mode: z.enum(["auto-merge-only", "bot-approve", "none"]).default("none"),
    enabled: z.boolean().default(false),
    merge_method: z.enum(["squash", "merge", "rebase"]).default("squash"),
    human_approvers: z
      .object({
        auto: z.number().int().min(0).default(0),
        review: z.number().int().min(0).default(1),
        block: z.number().int().min(0).default(0),
      })
      .default({ auto: 0, review: 1, block: 0 }),
    /** Lanes the bot may APPROVE in (bot-approve mode). review/block also require human_approvers[lane] == 0 ("bot-only"). */
    bot_approve: z
      .object({ auto: z.boolean().default(true), review: z.boolean().default(false), block: z.boolean().default(false) })
      .default({ auto: true, review: false, block: false }),
  })
  .default({
    mode: "none",
    enabled: false,
    merge_method: "squash",
    human_approvers: { auto: 0, review: 1, block: 0 },
    bot_approve: { auto: true, review: false, block: false },
  });

export const DEFAULT_PROPOSAL_THRESHOLDS = { min_prs: 3, min_actors: 2, min_path_events: 2, comment_min_prs: 3, comment_min_actors: 2 };

/**
 * Default of `learning.from_comments`: learn from review comments that people with write access left on lines MergeJudge did not flag.
 * Off until the owner switches it on; making it on by default later is this one line.
 */
export const DEFAULT_LEARN_FROM_COMMENTS = false;

export const DEFAULT_CODE_AUTO = { enabled: false, paths: [] as string[], max_lines: 30, max_total_lines: 100 };
const codeAutoSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Globs a code file must match to be a candidate. Empty = every code path that is not protected. */
    paths: z.array(z.string()).default([]),
    /** Changed lines (additions + deletions) per file. */
    max_lines: z.number().int().positive().default(30),
    /** Changed lines over all candidate files in the PR; above it none of them is a candidate. */
    max_total_lines: z.number().int().positive().default(100),
  })
  .default(DEFAULT_CODE_AUTO);

const DEFAULT_TRUSTED_AUTHORS: { enabled: boolean; users: string[]; applies_to: "code_auto" | "all_auto"; agents: "as_author" | "untrusted" } = {
  enabled: false, users: [], applies_to: "code_auto", agents: "as_author",
};

export const DEFAULT_PR_TEMPLATE_SECTIONS = ["Testing", "Risk", "How to revert"];
const DEFAULT_PR_TEMPLATE: { enabled: boolean; sections: string[]; min_chars: number; apply_to: "agents" | "all"; missing_lane: "review" | "block" } = {
  enabled: false, sections: DEFAULT_PR_TEMPLATE_SECTIONS, min_chars: 15, apply_to: "agents", missing_lane: "review",
};

export const configSchema = z.object({
  provider: providerSchema,
  lanes: z
    .object({
      auto: z.array(z.string()).default(DEFAULT_AUTO),
      protected: z.array(z.string()).default(DEFAULT_PROTECTED),
      max_auto_lines: z.number().int().positive().default(200),
      /** Opt-in lane for small code changes. Off by default: code files always need review. See docs/DESIGN.md. */
      code_auto: codeAutoSchema,
      /**
       * Opt-in gate for every auto path: only listed GitHub logins. Off by default = no author check.
       * `applies_to: all_auto` also covers the docs/style auto paths, not just lanes.code_auto candidates.
       */
      trusted_authors: z
        .object({
          enabled: z.boolean().default(false),
          /** GitHub logins, case-insensitive. Bots (login ending in [bot], user type Bot) are untrusted unless listed exactly. */
          users: z.array(z.string().trim().min(1).max(100)).default([]),
          applies_to: z.enum(["code_auto", "all_auto"]).default("code_auto"),
          /** What an agent-marked PR (label or MergeJudge-Actor trailer) counts as: its author's login, or untrusted. */
          agents: z.enum(["as_author", "untrusted"]).default("as_author"),
        })
        .default(DEFAULT_TRUSTED_AUTHORS),
    })
    .default({
      auto: DEFAULT_AUTO, protected: DEFAULT_PROTECTED, max_auto_lines: 200, code_auto: DEFAULT_CODE_AUTO,
      trusted_authors: DEFAULT_TRUSTED_AUTHORS,
    }),
  labels: z
    .object({
      block: z.array(z.string()).default(["do-not-merge"]),
      review: z.array(z.string()).default(["needs-review"]),
    })
    .default({ block: ["do-not-merge"], review: ["needs-review"] }),
  review: z
    .object({
      /** diff = changed hunks only (default). context = + full changed files, their imports and callers. deep = + read-only repo tools backed by an index. */
      mode: z.enum(["diff", "context", "deep"]).default("diff"),
      /** EXPERIMENTAL. triage = per-file risk triage (default). single = one review-focused prompt; every finding must sit on an added diff line. */
      style: z.enum(["triage", "single"]).default("triage"),
    })
    .default({ mode: "diff", style: "triage" }),
  context: z
    .object({
      max_bytes: z.number().int().positive().default(40_000),
      max_files: z.number().int().positive().max(100).default(25),
      max_symbols: z.number().int().nonnegative().max(10).default(3),
      max_callers: z.number().int().nonnegative().max(10).default(3),
      max_file_bytes: z.number().int().positive().default(12_000),
    })
    .default({ max_bytes: 40_000, max_files: 25, max_symbols: 3, max_callers: 3, max_file_bytes: 12_000 }),
  /** review.mode: deep. The loop is bounded by steps, total tokens (input+output over all calls) and wall time. */
  deep: z
    .object({
      max_steps: z.number().int().positive().max(20).default(6),
      max_tokens: z.number().int().positive().default(60_000),
      max_seconds: z.number().int().positive().max(600).default(120),
      /** Per tool result; larger outputs are cut. */
      max_tool_output_bytes: z.number().int().positive().max(40_000).default(6_000),
    })
    .default({ max_steps: 6, max_tokens: 60_000, max_seconds: 120, max_tool_output_bytes: 6_000 }),
  /** stored = index snapshots in R2 + embeddings in Vectorize (Worker). none = temporary in-memory index per review, nothing persisted. */
  index: z
    .object({ policy: z.enum(["stored", "none"]).default("stored") })
    .default({ policy: "stored" }),
  budget: z
    .object({
      max_tokens_per_pr: z.number().int().positive().default(28000),
      /** Unset = per-model default (budget.ts: 8000 for reasoning models, else 2500). Set = used as is, clamped to the PR budget. */
      max_output_tokens: z.number().int().positive().optional(),
    })
    .default({ max_tokens_per_pr: 28000 }),
  approval: approvalSchema,
  /**
   * Opt-in PR description check. Off by default; when on, a PR whose body does not really answer the
   * configured sections (template comments, placeholders and checkbox-only lines do not count) is raised
   * to `missing_lane`. Only ever raises. See src/prtemplate.ts.
   */
  pr_template: z
    .object({
      enabled: z.boolean().default(false),
      /** Sections the description must answer; the three defaults carry built-in aliases (src/prtemplate.ts). */
      sections: z.array(z.string().trim().min(1).max(80)).min(1).default(DEFAULT_PR_TEMPLATE_SECTIONS),
      /** Real text under each heading (characters after stripping comments/placeholders/checkbox lines). */
      min_chars: z.number().int().positive().max(2000).default(15),
      /** agents = only PRs carrying the agent marker (label `mergejudge:agent` or the body trailer); all = every PR. */
      apply_to: z.enum(["agents", "all"]).default("agents"),
      missing_lane: z.enum(["review", "block"]).default("review"),
    })
    .default(DEFAULT_PR_TEMPLATE),
  /** Repo guidance files from the base tip. Empty list disables policy injection. */
  policy_files: z.array(z.string()).max(10).default(DEFAULT_POLICY_FILES),
  /** Globs of policy paths to skip even if listed in policy_files. */
  policy_exclude: z.array(z.string()).default([]),
  policy: z
    .object({
      max_each_bytes: z.number().int().positive().default(POLICY_MAX_EACH),
      max_total_bytes: z.number().int().positive().default(8 * 1024),
    })
    .default({ max_each_bytes: POLICY_MAX_EACH, max_total_bytes: 8 * 1024 }),
  /** Globs excluded from the LLM prompt (still rule-laned). */
  diff_exclude: z.array(z.string()).default(DEFAULT_DIFF_EXCLUDE),
  rubrics: z
    .object({
      enabled: z.boolean().default(true),
      packs: z.array(z.string()).default(DEFAULT_ENABLED_PACKS),
      custom: z.array(criterionSchema).max(20).default([]),
      /** criterion id -> extra guidance for the model (built-in or custom criteria). Added by learning proposals; context only. */
      notes: z.record(z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/i), z.string().max(300)).default({}),
    })
    .default({ enabled: true, packs: DEFAULT_ENABLED_PACKS, custom: [], notes: {} }),
  /** Runner repos only: which engine/model the review should use (the runner nacks if it does not offer it). Panel setting wins over this. Patterns match packages/worker/src/engines.ts. */
  runner: z
    .object({
      engine: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,39}$/).nullable().default(null),
      model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/).nullable().default(null),
      /** deep mode on a runner: `worker` = the Worker reads the repo through the GitHub API and ships context (default); `local` = the runner reads its own git clone and nothing but SHAs leaves the Worker. */
      code_source: z.enum(["local", "worker"]).default("worker"),
    })
    .default({ engine: null, model: null, code_source: "worker" }),
  learning: z
    .object({
      enabled: z.boolean().default(true),
      /** Also learn from review comments by people with write access on lines MergeJudge did not flag. Needs `enabled`. Hosted App only. */
      from_comments: z.boolean().default(DEFAULT_LEARN_FROM_COMMENTS),
      propose_after: z.number().int().positive().default(10),
      /** Branch that stores lessons; PRs from this head are always block. */
      branch: z.string().default("mergejudge-learning"),
      /** Logins (case-insensitive) whose merges and label changes are never recorded as outcomes, e.g. a coding agent that acts through a human account. */
      exclude_actors: z.array(z.string().trim().min(1).max(100)).default([]),
      /** What it takes before a proposal PR edits files. Below these, the proposal is a record-only report. */
      proposal: z
        .object({
          /** false = never edit files; proposals stay record-only reports. */
          edits: z.boolean().default(true),
          /** "Too strict" on a criterion: at least this many different PRs ... */
          min_prs: z.number().int().min(2).default(DEFAULT_PROPOSAL_THRESHOLDS.min_prs),
          /** ... and this many different people. */
          min_actors: z.number().int().min(1).default(DEFAULT_PROPOSAL_THRESHOLDS.min_actors),
          /** "Too lenient" on a path: at least this many reverts or fix-follow-ups of auto PRs touching it. */
          min_path_events: z.number().int().min(2).default(DEFAULT_PROPOSAL_THRESHOLDS.min_path_events),
          /** Comment-based rubric proposals (`learning.from_comments`): a similar missed point on at least this many different PRs ... */
          comment_min_prs: z.number().int().min(2).default(DEFAULT_PROPOSAL_THRESHOLDS.comment_min_prs),
          /** ... raised by at least this many different people. */
          comment_min_actors: z.number().int().min(1).default(DEFAULT_PROPOSAL_THRESHOLDS.comment_min_actors),
        })
        .default({ edits: true, ...DEFAULT_PROPOSAL_THRESHOLDS }),
    })
    .default({ enabled: true, from_comments: DEFAULT_LEARN_FROM_COMMENTS, propose_after: 10, branch: "mergejudge-learning", exclude_actors: [], proposal: { edits: true, ...DEFAULT_PROPOSAL_THRESHOLDS } }),
});

export type Config = z.infer<typeof configSchema>;

/** Comment learning is active only when learning is on AND `learning.from_comments` is set. */
export const learnsFromComments = (cfg: Pick<Config, "learning">): boolean => cfg.learning.enabled && cfg.learning.from_comments;
export type ProviderConfig = Config["provider"];

export function parseConfig(text: string | undefined | null): Config {
  let raw: unknown = {};
  if (text && text.trim()) {
    try {
      raw = parse(text) ?? {};
    } catch (e) {
      throw new Error(`Invalid .mergejudge.yml (YAML): ${(e as Error).message}`);
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    // Alias: rubric_packs: [] disables; rubric_packs: [security] sets packs.
    if ("rubric_packs" in o) {
      const packs = o.rubric_packs;
      const rubrics = (typeof o.rubrics === "object" && o.rubrics && !Array.isArray(o.rubrics) ? { ...(o.rubrics as object) } : {}) as Record<string, unknown>;
      if (Array.isArray(packs)) {
        rubrics.packs = packs;
        if (packs.length === 0) rubrics.enabled = false;
      }
      o.rubrics = rubrics;
      delete o.rubric_packs;
    }
  }
  const res = configSchema.safeParse(raw);
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid .mergejudge.yml: ${msg}`);
  }
  assertSafeLearningBranch(res.data.learning.branch);
  return res.data;
}

export interface ProviderOverrides {
  type?: string;
  base_url?: string;
  model?: string;
  api_key_env?: string;
}

/** Action inputs (non-empty) override the yaml provider block. */
export function applyProviderOverrides(cfg: Config, o: ProviderOverrides): Config {
  const p = { ...cfg.provider };
  if (o.type) {
    const t = z.enum(PROVIDER_TYPES).safeParse(o.type);
    if (!t.success) throw new Error(`Invalid provider input type: ${o.type}`);
    p.type = t.data;
  }
  if (o.base_url) p.base_url = o.base_url;
  if (o.model) p.model = o.model;
  if (o.api_key_env) p.api_key_env = o.api_key_env;
  return { ...cfg, provider: p };
}
