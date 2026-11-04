#!/usr/bin/env python3
"""Offline replay of a pass-2 risk gate over the cached gate-off Martian baseline (bench-only).

No review or judge call is made. The replay is exact because in the harness pass 1 (fast) and pass 2
(deep) share the SAME pass-1 call and the Martian judge scores the union of fast+deep candidates in ONE
call, then splits the evals per profile. So for any PR, "deep with pass 2 skipped" == the cached fast eval.

`skip` means only "pass 2 is skipped" - never a merge decision.

Only `--mode rules+cheap` can call a model (the cheap gate model, and only for PRs the rules leave at skip);
its results are cached in `--cheap-cache` so reruns do not call again.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shlex
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pricing  # noqa: E402
import risk_gate  # noqa: E402

PRICE_MODEL = "claude-sonnet-5-5"  # list price used for the pass-2 savings


def load_harness():
    """Import harness/run_on_mini.py by path (for compute_profile_summary, prompt builders)."""
    spec = importlib.util.spec_from_file_location("run_on_mini", HERE / "harness" / "run_on_mini.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Cheap-model call cache (keyed by url + sha256(prompt)); written after every real call
# ---------------------------------------------------------------------------

class CheapCache:
    def __init__(self, path: Path | None):
        self.path = path
        self.data = json.loads(path.read_text()) if path and path.exists() else {}

    def runner_for(self, url: str, cmd: list[str] | None):
        def run(prompt: str) -> dict:
            key = f"{url}|{hashlib.sha256(prompt.encode()).hexdigest()}"
            if key in self.data:
                return self.data[key]
            res = risk_gate.run_cheap_gate(prompt, cmd=cmd)
            if not res.get("error"):  # failures are not cached: a rerun retries them
                self.data[key] = res
                if self.path:
                    self.path.write_text(json.dumps(self.data, indent=2))
            return res
        return run


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def core_tp(ev: dict, core_cats: set[str]) -> int:
    """Core-profile true positives of one eval (same category filter as compute_profile_summary)."""
    if ev.get("skipped"):
        return 0
    return sum(1 for x in ev.get("true_positives", []) if (x.get("category") or "bug") in core_cats)


def pct(n: float, d: float) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def sum_usage(rows: list[dict]) -> dict:
    keys = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")
    return {k: sum(int((r.get("gate_usage") or {}).get(k) or 0) for r in rows) for k in keys}


# ---------------------------------------------------------------------------
# Martian replay
# ---------------------------------------------------------------------------

def replay_mode(mode: str, checkpoint: dict, bundle: dict, h, cache: CheapCache,
                cheap_cmd: list[str] | None, token_ratio: float) -> dict:
    core_cats = h.PROFILE_CATEGORIES["core"]
    rows, fast_evals, deep_evals, used_evals = [], {}, {}, {}
    for url, rec in checkpoint.items():
        pr = bundle[url]
        g = risk_gate.gate(pr, mode, cheap_runner=cache.runner_for(url, cheap_cmd))
        skipped = g["verdict"] == "skip"
        fe, de = rec["fast"]["eval"], rec["deep"]["eval"]
        ue = fe if skipped else de
        fast_evals[url], deep_evals[url], used_evals[url] = fe, de, ue
        fast_c, deep_c = rec["fast"]["candidates"], rec["deep"]["candidates"]
        row = {
            "url": url, "verdict": g["verdict"], "pass2_skipped": skipped,
            "rules_verdict": g["rules_verdict"], "rules_reasons": g["rules_reasons"],
            "model_risk": g["model_risk"], "model_reason": g["model_reason"], "gate_error": g["error"],
            "gate_cost_usd_list": g["cost_usd_list"], "gate_usage": g["usage"],
            "fast_tp": core_tp(fe, core_cats), "fast_fp": fe.get("fp", 0),
            "deep_tp": core_tp(de, core_cats), "deep_fp": de.get("fp", 0),
            "used_tp": core_tp(ue, core_cats), "used_fp": ue.get("fp", 0),
            "has_goldens": not de.get("skipped"),
            "deep_only_candidates": sum(1 for c in deep_c if c not in fast_c),
        }
        row["deep_pays_off"] = row["has_goldens"] and row["deep_tp"] > row["fast_tp"]
        # Pass-2 cost of this PR in the gate-off baseline: real logged output tokens;
        # input is a chars/4 estimate x calibration ratio (see README).
        out_tok = int(rec["deep"]["meta"].get("output_tokens") or 0)
        p2_prompt = h.build_pass2_user_prompt(pr, rec["fast"]["findings"])
        in_tok = len(p2_prompt) / 4 * token_ratio
        row.update(p2_out_tokens=out_tok, p2_in_tokens=in_tok)
        if skipped:
            row.update(saved_out_tokens=out_tok, saved_in_tokens=in_tok,
                       saved_latency_s=float(rec["deep"].get("pass2_latency_s") or 0.0))
        rows.append(row)

    fast_s = h.compute_profile_summary(fast_evals)["core"]
    deep_s = h.compute_profile_summary(deep_evals)["core"]
    used_s = h.compute_profile_summary(used_evals)["core"]
    skipped_rows = [r for r in rows if r["pass2_skipped"]]
    kept_rows = [r for r in rows if not r["pass2_skipped"]]
    pays = [r for r in rows if r["deep_pays_off"]]
    pays_kept = [r for r in pays if not r["pass2_skipped"]]
    saved_in = sum(r["saved_in_tokens"] for r in skipped_rows)
    saved_out = sum(r["saved_out_tokens"] for r in skipped_rows)
    saved_usd = pricing.cost_usd(PRICE_MODEL, {"input_tokens": saved_in, "output_tokens": saved_out})
    # Same tokens priced the way Claude Code CLI bills a one-off call: the prompt is written to the
    # 1-hour cache (seen on the real calibration calls), so input costs the cache-write price.
    saved_usd_cli = pricing.cost_usd(PRICE_MODEL, {"cache_creation_input_tokens": saved_in, "output_tokens": saved_out})
    all_in = sum(r["p2_in_tokens"] for r in rows)
    all_out = sum(r["p2_out_tokens"] for r in rows)
    all_usd = pricing.cost_usd(PRICE_MODEL, {"input_tokens": all_in, "output_tokens": all_out})
    gate_usd = sum(r["gate_cost_usd_list"] or 0.0 for r in rows)
    cheap_rows = [r for r in rows if r["model_risk"] is not None or r["gate_error"]]
    return {
        "mode": mode, "num_prs": len(rows),
        "fast_core": fast_s, "deep_core": deep_s, "gated_core": used_s,
        "tp_lost_vs_deep": deep_s["tp"] - used_s["tp"],
        "fp_removed_vs_deep": deep_s["fp"] - used_s["fp"],
        "deep_findings_dropped": sum(r["deep_only_candidates"] for r in skipped_rows),
        "prs_skipping_pass2": len(skipped_rows), "pct_skipping_pass2": pct(len(skipped_rows), len(rows)),
        "deep_pays_off_prs": len(pays), "deep_pays_off_kept": len(pays_kept),
        "gate_recall_pct": pct(len(pays_kept), len(pays)),
        "gate_precision_pct": pct(len(pays_kept), len(kept_rows)),
        "pass2_tokens_saved": {"input_est": round(saved_in), "output_logged": saved_out},
        "pass2_latency_saved_s": round(sum(r["saved_latency_s"] for r in skipped_rows), 1),
        "pass2_usd_saved_list": round(saved_usd, 4),
        "pass2_usd_saved_cli_billing": round(saved_usd_cli, 4),
        "pass2_total_tokens_gate_off": {"input_est": round(all_in), "output_logged": all_out},
        "pass2_usd_total_gate_off_list": round(all_usd, 4),
        "pct_pass2_usd_saved": pct(saved_usd, all_usd),
        "gate_usd_list": round(gate_usd, 4),
        "net_usd_saved_list": round(saved_usd - gate_usd, 4),
        "cheap_gate": {"calls": len(cheap_rows), "usage": sum_usage(cheap_rows)},
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Clean-set replay (gate only; there is no review output for these PRs)
# ---------------------------------------------------------------------------

def replay_clean(mode: str, clean: dict, cache: CheapCache, cheap_cmd: list[str] | None) -> dict:
    rows = []
    for url, pr in clean.items():
        g = risk_gate.gate(pr, mode, cheap_runner=cache.runner_for(url, cheap_cmd))
        rows.append({"url": url, "verdict": g["verdict"], "rules_verdict": g["rules_verdict"],
                     "rules_reasons": g["rules_reasons"], "model_risk": g["model_risk"],
                     "model_reason": g["model_reason"], "gate_error": g["error"],
                     "gate_cost_usd_list": g["cost_usd_list"]})
    n = len(rows)
    sent = sum(1 for r in rows if r["verdict"] != "skip")
    return {"mode": mode, "num_prs": n, "pct_sent_to_pass2": pct(sent, n), "pct_skipped": pct(n - sent, n),
            "gate_usd_list": round(sum(r["gate_cost_usd_list"] or 0.0 for r in rows), 4), "rows": rows}


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------

def render_md(results: dict) -> str:
    out = ["# Gate replay (offline, cached gate-off baseline)", "",
           "`skip` = pass 2 is skipped (never a merge decision). Core profile. "
           f"Pass-2 input tokens are an estimate (chars/4 x {results['pass2_token_ratio']}); "
           "$ at Sonnet 5.5 list price with input at the base price; 'CLI billing' prices "
           "the same input at the 1-hour cache-write price, as Claude Code CLI bills a one-off call.", ""]
    m = results["martian"]
    if m:
        first = next(iter(m.values()))
        f, d = first["fast_core"], first["deep_core"]
        out += ["## Martian set (50 PRs, all bug-introducing)", "",
                "| mode | P | R | F1 | TP | FP | FN | TP lost vs deep | deep findings dropped | PRs skipping pass 2 | gate recall | gate precision |",
                "|---|---|---|---|---|---|---|---|---|---|---|---|"]
        row = lambda name, s, extra: (f"| {name} | {s['precision']} | {s['recall']} | {s['f1']} | {s['tp']} | {s['fp']} | {s['fn']} | " + extra + " |")
        out.append(row("fast (pass 1 only)", f, "- | - | - | - | -"))
        out.append(row("deep (gate off)", d, "0 | 0 | 0 (0%) | - | -"))
        for mode, r in m.items():
            if mode == "off":
                continue
            out.append(row(f"gated: {mode}", r["gated_core"],
                           f"{r['tp_lost_vs_deep']} | {r['deep_findings_dropped']} | {r['prs_skipping_pass2']} ({r['pct_skipping_pass2']}%) | "
                           f"{r['deep_pays_off_kept']}/{r['deep_pays_off_prs']} ({r['gate_recall_pct']}%) | {r['gate_precision_pct']}%"))
        out += ["", f"Gate off, pass 2 on all {first['num_prs']} PRs: {first['pass2_total_tokens_gate_off']['input_est']:,} input (est) / "
                f"{first['pass2_total_tokens_gate_off']['output_logged']:,} output tokens, ${first['pass2_usd_total_gate_off_list']} at list price.", "",
                "| mode | pass-2 tokens saved (in est / out logged) | latency saved | $ saved (list / CLI billing) | share of pass-2 $ | gate $ | net $ (list) | cheap calls | cheap tokens (in / cache read / cache write / out) |",
                "|---|---|---|---|---|---|---|---|---|"]
        for mode, r in m.items():
            if mode == "off":
                continue
            t, c = r["pass2_tokens_saved"], r["cheap_gate"]
            u = c["usage"]
            out.append(f"| {mode} | {t['input_est']:,} / {t['output_logged']:,} | {r['pass2_latency_saved_s']}s | "
                       f"${r['pass2_usd_saved_list']} / ${r['pass2_usd_saved_cli_billing']} | {r['pct_pass2_usd_saved']}% | ${r['gate_usd_list']} | ${r['net_usd_saved_list']} | {c['calls']} | "
                       f"{u['input_tokens']:,} / {u['cache_read_input_tokens']:,} / {u['cache_creation_input_tokens']:,} / {u['output_tokens']:,} |")
        out.append("")
    c = results["clean"]
    if c:
        out += ["## Presumed-clean set (merged, no revert found by search)", "",
                "| mode | PRs | sent to pass 2 | skipped | gate $ |", "|---|---|---|---|---|"]
        for mode, r in c.items():
            out.append(f"| {mode} | {r['num_prs']} | {r['pct_sent_to_pass2']}% | {r['pct_skipped']}% | ${r['gate_usd_list']} |")
        out.append("")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--checkpoint", type=Path, required=True)
    ap.add_argument("--bundle", type=Path, required=True)
    ap.add_argument("--mode", action="append", default=[], help="off|rules|rules+cheap; repeatable or comma list")
    ap.add_argument("--clean-bundle", type=Path, default=None)
    ap.add_argument("--cheap-cache", type=Path, default=None)
    ap.add_argument("--cheap-cmd", default=None, help="override cheap gate command (default: risk_gate.DEFAULT_CHEAP_CMD)")
    ap.add_argument("--pass2-token-ratio", type=float, default=1.0,
                    help="multiplier on the chars/4 pass-2 input estimate; calibrate from real logged usage")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--md", type=Path, default=None)
    args = ap.parse_args()

    modes = [m.strip() for part in args.mode for m in part.split(",") if m.strip()] or ["off", "rules"]
    for m in modes:
        if m not in ("off", "rules", "rules+cheap"):
            ap.error(f"unknown mode {m!r}")
    cheap_cmd = shlex.split(args.cheap_cmd) if args.cheap_cmd else None

    h = load_harness()
    checkpoint = json.loads(args.checkpoint.read_text())
    bundle = json.loads(args.bundle.read_text())
    clean = json.loads(args.clean_bundle.read_text()) if args.clean_bundle else None
    cache = CheapCache(args.cheap_cache)

    results = {"pass2_token_ratio": args.pass2_token_ratio, "price_model": PRICE_MODEL,
               "martian": {m: replay_mode(m, checkpoint, bundle, h, cache, cheap_cmd, args.pass2_token_ratio) for m in modes},
               "clean": {m: replay_clean(m, clean, cache, cheap_cmd) for m in modes} if clean else {}}
    md = render_md(results)
    print(md)
    if args.out:
        args.out.write_text(json.dumps(results, indent=2))
    if args.md:
        args.md.write_text(md)


if __name__ == "__main__":
    main()
