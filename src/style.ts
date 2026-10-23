/**
 * MERGEJUDGE_REVIEW_STYLE=single|triage: local/runner override of `review.style` (EXPERIMENTAL). Read here, on the runner / CLI /
 * Action side only; core/ never reads the environment, so the hosted Worker cannot be switched by it.
 */
import type { Config } from "../core/config.js";
import { REVIEW_STYLES, type ReviewStyle } from "../core/single.js";

export const REVIEW_STYLE_ENV = "MERGEJUDGE_REVIEW_STYLE";

/** The style the environment asks for, or a warning when the value is invalid (then it is ignored). Unset/empty = no override. */
export function reviewStyleFromEnv(env: Record<string, string | undefined> = process.env): { style?: ReviewStyle; warning?: string } {
  const raw = env[REVIEW_STYLE_ENV]?.trim();
  if (!raw) return {};
  const v = raw.toLowerCase();
  if ((REVIEW_STYLES as readonly string[]).includes(v)) return { style: v as ReviewStyle };
  return { warning: `${REVIEW_STYLE_ENV} must be one of ${REVIEW_STYLES.join(", ")}; ignoring it.` };
}

/** A copy of `cfg` with the environment's style, if any. */
export function applyReviewStyleEnv(cfg: Config, env: Record<string, string | undefined> = process.env, warn: (m: string) => void = () => {}): Config {
  const r = reviewStyleFromEnv(env);
  if (r.warning) warn(r.warning);
  return r.style ? { ...cfg, review: { ...cfg.review, style: r.style } } : cfg;
}
