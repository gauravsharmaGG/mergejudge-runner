import type { Config } from "./config.js";
import { isAgentPr } from "./agent.js";
import { codeAutoDecision } from "./codeauto.js";
import { prTemplateRaise } from "./prtemplate.js";
import { classifyFiles, labelLane } from "./rules.js";
import type { LlmTriage } from "./triage.js";
import type { RubricResult } from "./rubrics.js";
import { trustedAuthor, type PrAuthor } from "./trusted.js";
import { LANE_ORDER, maxLane, type FileVerdict, type Lane, type PrFile } from "./types.js";

export interface Aggregate {
  lane: Lane;
  /** Structured explanation, derived from the final verdicts. Optional for older runner results. */
  explanation?: LaneExplanation;
  files: FileVerdict[];
  labelReasons: string[];
  summary: string;
  rubric: RubricResult[];
}

export interface LaneReason {
  kind: "file" | "hold" | "fallback";
  lane: Lane;
  path?: string;
  source?: FileVerdict["source"];
  messages: string[];
}

export interface LaneExplanation {
  summary: string;
  reasons: LaneReason[];
}

/** Use final verdicts, including server floors; never infer safety from extensions alone. */
export function explainLane(agg: Pick<Aggregate, "lane" | "files" | "labelReasons">): LaneExplanation {
  const reasons: LaneReason[] = agg.files.filter((f) => f.lane === agg.lane).map((f) => ({
    kind: "file", lane: f.lane, path: f.path, ...(f.source ? { source: f.source } : {}), messages: [...f.reasons],
  }));
  reasons.push(...agg.labelReasons.map((message): LaneReason => ({ kind: "hold", lane: agg.lane, messages: [message] })));
  const viaCode = agg.files.filter((f) => f.codeAuto);
  const name = agg.lane === "review" ? "needs review" : agg.lane;
  let why: string;
  if (agg.lane === "auto" && viaCode.length) {
    const first = viaCode[0]!;
    why = `auto via code_auto opt-in: AI said auto because ${first.llmReason ?? "(no reason)"}` +
      (viaCode.length > 1 ? ` (+${viaCode.length - 1} more code file${viaCode.length === 2 ? "" : "s"})` : ` (${first.path})`);
  } else if (agg.lane === "auto" && agg.files.length) {
    const docs = agg.files.every((f) => /\.md$/i.test(f.path));
    why = docs ? `docs-only (${agg.files.length} .md file${agg.files.length === 1 ? "" : "s"})` : `all ${agg.files.length} files pass auto-path rules`;
  } else {
    const first = reasons[0];
    why = first?.path ? `touches ${first.path}: ${first.messages.join("; ")}` : first?.messages.join("; ") || "no file or label reason supplied";
    if (reasons.length > 1) why += ` (+${reasons.length - 1} more reasons)`;
  }
  if (!reasons.length) reasons.push({ kind: "fallback", lane: agg.lane, messages: [why] });
  return { summary: `${name}: ${why}`, reasons };
}

export function deterministicSummary(files: PrFile[]): string {
  const add = files.reduce((n, f) => n + f.additions, 0);
  const del = files.reduce((n, f) => n + f.deletions, 0);
  return `${files.length} file${files.length === 1 ? "" : "s"} changed, +${add} / -${del} lines.`;
}

/** PR-level facts the deterministic raises need: the body (untrusted) and the author GitHub reports (trusted). */
export interface PrMeta {
  body?: string | null;
  user?: PrAuthor | null;
  /** Custom config file path(s) (Action `config_path`) treated like `.mergejudge.yml`. */
  configPaths?: string[];
}

/**
 * final(file) = max(rule, llm); final(PR) = max(files, labels, PR-level raises). LLM can only raise, with one
 * opt-in exception: a lanes.code_auto candidate (rule lane "review" + autoCandidate) becomes "auto" when
 * codeAutoDecision accepts the AI's verdict. The PR-level raises (pr_template, lanes.trusted_authors) only ever raise.
 * `pr` is optional and older callers omit it; without it both checks are skipped (a PR with no body and no
 * author information cannot be judged by them).
 */
export function aggregate(files: PrFile[], labels: string[], cfg: Config, llm: LlmTriage | null, pr?: PrMeta): Aggregate {
  const findingPaths = new Set((llm?.findings ?? []).map((f) => f.path));
  const agentMarked = isAgentPr({ labels, body: pr?.body ?? null });
  const trust = trustedAuthor(cfg, { author: pr?.user ?? undefined, agentMarked });
  const verdicts = classifyFiles(files, cfg, pr?.configPaths).map((v): FileVerdict => {
    const l = llm?.files.get(v.path);
    if (v.autoCandidate) {
      const d = codeAutoDecision(v, { ai: l, findingPaths, rubric: llm?.rubric ?? [], author: pr?.user ?? undefined, agentMarked }, cfg);
      if (d.ok) {
        return {
          path: v.path, lane: "auto", source: "LLM", llmReason: d.reason, codeAuto: true,
          reasons: [`code_auto opt-in: small code file passed every rule; AI said auto: ${d.reason}`],
        };
      }
      // Say why an AI "auto" was refused, and always when the author gate refused it (rules-only runs too).
      if (l?.lane === "auto" || !trust.trusted) return { ...v, reasons: [...v.reasons, `code_auto not applied: ${d.why}`], source: "rule + LLM" };
    }
    const base: FileVerdict = { ...v, source: "rule" };
    if (!l) return base;
    const mine = (llm?.findings ?? []).filter((f) => f.path === v.path);
    // A raise that rests only on pre-existing issues is ignored: the rule lane stays.
    if (LANE_ORDER[l.lane] > LANE_ORDER[v.lane] && mine.length && mine.every((f) => f.preExisting))
      return { ...base, reasons: [...v.reasons, "AI raise ignored: only pre-existing issues"] };
    const raised = LANE_ORDER[l.lane] > LANE_ORDER[v.lane];
    const agrees = l.lane === v.lane && v.lane !== "auto";
    if (!raised && !agrees) return base;
    const lane = maxLane(v.lane, l.lane);
    // When the LLM raises an auto file, relabel the rule's reasons so they don't read as "safe".
    const reasons = raised && v.lane === "auto" ? v.reasons.map((r) => `rule: auto (${r})`) : [...v.reasons];
    if (raised) reasons.push(l.reason ? `LLM: ${l.reason}` : "LLM flagged this file");
    const source = v.lane === "auto" ? "LLM" : "rule + LLM";
    return { ...v, lane, reasons, source, ...(l.reason ? { llmReason: l.reason } : {}) };
  });
  // Failed high-severity rubric criteria (with verified evidence) raise the evidence file and the PR. Never lower.
  const rubric = llm?.rubric ?? [];
  for (const r of rubric) {
    if (!r.raiseTo || !r.evidence) continue;
    const i = verdicts.findIndex((v) => v.path === r.evidence!.path);
    if (i < 0) continue;
    const v = verdicts[i]!;
    const raised = LANE_ORDER[r.raiseTo] > LANE_ORDER[v.lane];
    const reasons = raised && v.lane === "auto" && v.source === "rule" ? v.reasons.map((x) => `rule: auto (${x})`) : [...v.reasons];
    reasons.push(`rubric ${r.id} failed`);
    const src = v.source ?? "rule";
    verdicts[i] = {
      ...v,
      lane: maxLane(v.lane, r.raiseTo),
      reasons,
      source: (src.includes("rubric") ? src : `${src} + rubric`) as FileVerdict["source"],
    };
  }
  for (const v of verdicts) if (v.codeAuto && v.lane !== "auto") delete v.codeAuto;
  // lanes.trusted_authors with applies_to: all_auto: auto-path (docs/style) files go to review for an
  // untrusted author too, exactly like lanes.code_auto candidates (which the gate above already refused).
  if (!trust.trusted && cfg.lanes.trusted_authors?.applies_to === "all_auto") {
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i]!;
      if (v.lane === "auto" && !v.codeAuto) verdicts[i] = { ...v, lane: "review", reasons: [...v.reasons, trust.why] };
    }
  }
  const lbl = labelLane(labels, cfg);
  let lane: Lane = lbl.lane;
  for (const v of verdicts) lane = maxLane(lane, v.lane);
  const labelReasons = [...lbl.reasons];
  // PR template check: a PR-level raise shown like a label reason, so "Why this lane?" explains it.
  const template = prTemplateRaise(cfg, { body: pr?.body ?? null, labels });
  if (template) {
    labelReasons.push(template.reason);
    lane = maxLane(lane, template.lane);
  }
  const result: Aggregate = {
    lane,
    files: verdicts,
    labelReasons,
    summary: llm?.summary || deterministicSummary(files),
    rubric,
  };
  result.explanation = explainLane(result);
  return result;
}
