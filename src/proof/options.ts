/**
 * Owner-side settings for proof tests (beta). Proof tests execute code from the reviewed pull request, so the switch lives
 * with the runner owner (flag > env > runner config file > default OFF). The reviewed repository's `.mergejudge.yml`
 * has no say: its content is untrusted on the owner's machine.
 */

export interface ProofSettings { enabled?: boolean | null; maxPerPr?: number | null; timeoutSeconds?: number | null }

export interface ProofOptions {
  enabled: boolean;
  /** Most proof tests generated and run for one pull request (cost cap). */
  maxPerPr: number;
  /** Wall-clock limit for one test run (base or head). */
  timeoutMs: number;
}

export const PROOF_DEFAULTS = { maxPerPr: 3, timeoutSeconds: 20 } as const;
export const PROOF_BOUNDS = { maxPerPr: [1, 10], timeoutSeconds: [2, 120] } as const;

const TRUE_RE = /^(1|true|yes|on)$/i;
const FALSE_RE = /^(0|false|no|off|)$/i;

/** First candidate that is a boolean (or a recognisable boolean string) wins; anything else is skipped. */
function pickBool(candidates: unknown[]): boolean {
  for (const c of candidates) {
    if (typeof c === "boolean") return c;
    if (typeof c === "string") {
      if (TRUE_RE.test(c.trim())) return true;
      if (FALSE_RE.test(c.trim())) return false;
    }
  }
  return false;
}

/** First valid positive number wins, clamped to [lo, hi]; invalid values are skipped. */
function pickBounded(candidates: unknown[], [lo, hi]: readonly [number, number], dflt: number): number {
  for (const c of candidates) {
    const n = typeof c === "string" ? (c.trim() === "" ? NaN : Number(c)) : typeof c === "number" ? c : NaN;
    if (Number.isFinite(n) && n > 0) return Math.min(hi, Math.max(lo, n));
  }
  return dflt;
}

export function resolveProofOptions(env: Record<string, string | undefined>, file: ProofSettings = {}, flags: ProofSettings = {}): ProofOptions {
  const enabled = pickBool([flags.enabled, env.MERGEJUDGE_PROOF_TESTS, file.enabled]);
  const maxPerPr = Math.floor(pickBounded([flags.maxPerPr, env.MERGEJUDGE_PROOF_TESTS_MAX, file.maxPerPr], PROOF_BOUNDS.maxPerPr, PROOF_DEFAULTS.maxPerPr));
  const seconds = pickBounded([flags.timeoutSeconds, env.MERGEJUDGE_PROOF_TESTS_TIMEOUT_SECONDS, file.timeoutSeconds], PROOF_BOUNDS.timeoutSeconds, PROOF_DEFAULTS.timeoutSeconds);
  return { enabled, maxPerPr, timeoutMs: Math.floor(seconds * 1000) };
}
