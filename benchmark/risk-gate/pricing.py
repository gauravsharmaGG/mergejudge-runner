"""List-price token costs per 1M tokens, stdlib only, no secrets.

Prices checked 2026-11-04:
- Claude models: https://platform.claude.com/docs/en/about-claude/pricing
- GLM models:    https://docs.z.ai/guides/overview/pricing

`cache_write_5m` / `cache_write_1h` are the 5-minute and 1-hour cache-write
prices. Claude Code CLI 2.1.291 writes the 1-hour cache: on three real pass-2
calls (2026-11-04) its own total_cost_usd matched the 1h tier, so `cost_usd`
defaults to the 1h tier. claude-haiku-5-5 prices are the
<=100k-prompt tier. glm-5.3-flash charges cache writes at the input price.

Only what this benchmark needs. Unknown models raise ValueError; callers that
record costs should catch it and store None instead of guessing.
"""

from __future__ import annotations

import re

# Per 1M tokens, USD, list price.
PRICES_PER_MTOK = {
    # https://platform.claude.com/docs/en/about-claude/pricing
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.10, "cache_write_5m": 2.50, "cache_write_1h": 4.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00, "cache_read": 0.30, "cache_write_5m": 3.75, "cache_write_1h": 6.00},
    # <=100k prompt tier
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01, "cache_write_5m": 0.125, "cache_write_1h": 0.20},
    # https://docs.z.ai/guides/overview/pricing
    "glm-5.3-flash": {"input": 0.15, "output": 0.50, "cache_read": 0.03, "cache_write_5m": 0.15, "cache_write_1h": 0.15},
    "glm-5.3": {"input": 1.40, "output": 4.40, "cache_read": 0.26, "cache_write_5m": 1.40, "cache_write_1h": 1.40},
}

# What Claude Code CLI 2.1.291 resolved "sonnet" to on 2026-11-04.
ALIASES = {
    "sonnet": "claude-sonnet-5-5",
    "glm-flash": "glm-5.3-flash",
}

# Dated snapshots, e.g. claude-sonnet-5-5-20YYYYMMDD -> claude-sonnet-5-5.
_DATE_SUFFIX = re.compile(r"-\d{8}$")


def resolve_model(name: str) -> str:
    """Canonical price-table name for a CLI-reported model name, or ValueError."""
    n = (name or "").strip()
    if n in PRICES_PER_MTOK:
        return n
    if n in ALIASES:
        return ALIASES[n]
    stripped = _DATE_SUFFIX.sub("", n)
    if stripped in PRICES_PER_MTOK:
        return stripped
    if stripped in ALIASES:
        return ALIASES[stripped]
    raise ValueError(f"unknown model (no list price): {name!r}")


def cost_usd(model: str, usage: dict | None, cache_write_tier: str = "1h") -> float:
    """List-price cost in USD for one call: input + cache writes + cache reads + output.

    cache_write_tier: "1h" (what Claude Code CLI uses) or "5m".
    """
    p = PRICES_PER_MTOK[resolve_model(model)]
    u = usage or {}

    def tok(key: str) -> float:
        try:
            return float(u.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0

    return (
        tok("input_tokens") * p["input"]
        + tok("cache_creation_input_tokens") * p["cache_write_" + cache_write_tier]
        + tok("cache_read_input_tokens") * p["cache_read"]
        + tok("output_tokens") * p["output"]
    ) / 1_000_000
