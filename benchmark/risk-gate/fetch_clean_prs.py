#!/usr/bin/env python3
"""Build a "presumed clean" PR bundle with the GitHub CLI (`gh api`), in the prs_50_bundle shape.

Bench-only. Run by a human with `gh` authenticated; the tests and the replay never call it.

Selection is deterministic: for each repo, merged PRs from a fixed week, oldest first. Skipped: bot authors,
PRs already in the Martian bundle (--exclude-bundle), and PRs a search finds a revert for. The first --per-repo
survivors are kept. "Clean" is only presumed: no revert was found by search, which is not proof of no bug.

    python3 fetch_clean_prs.py --exclude-bundle prs_50_bundle.json --out clean_bundle.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

REPOS = ["getsentry/sentry", "grafana/grafana", "calcom/cal.com", "discourse/discourse", "keycloak/keycloak"]
MERGED_RANGE = "2025-03-03..2025-03-07"
SEARCH_SLEEP_S = 2.5  # search API limit is 30 requests/min
CLEAN_BASIS = "merged, no revert found by search"


def gh_api(path: str) -> object:
    proc = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"gh api {path} failed: {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def search(q: str, per_page: int = 30) -> dict:
    time.sleep(SEARCH_SLEEP_S)
    enc = urllib.parse.quote(q, safe=":")
    return gh_api(f"search/issues?q={enc}&sort=created&order=asc&per_page={per_page}")


def is_bot(user: dict | None) -> bool:
    u = user or {}
    return u.get("type") == "Bot" or str(u.get("login", "")).endswith("[bot]")


def has_revert(repo: str, number: int, title: str) -> bool:
    """True if a search finds a revert PR that mentions #N, or one titled Revert "<title>"."""
    by_ref = search(f'repo:{repo} is:pr "Revert" "#{number}" in:title,body', per_page=5)
    if by_ref.get("total_count", 0) > 0:
        return True
    safe_title = title.replace('"', " ").strip()
    by_title = search(f'repo:{repo} is:pr in:title "Revert \\"{safe_title}\\""', per_page=5)
    return by_title.get("total_count", 0) > 0


def fetch_files(repo: str, number: int) -> list[dict]:
    files: list[dict] = []
    for page in (1, 2, 3):  # up to 300 files
        batch = gh_api(f"repos/{repo}/pulls/{number}/files?per_page=100&page={page}")
        files += [{
            "path": f["filename"], "status": f["status"],
            "additions": f.get("additions", 0), "deletions": f.get("deletions", 0),
            "previousPath": f.get("previous_filename"), "patch": f.get("patch") or "",
        } for f in batch]
        if len(batch) < 100:
            break
    return files


def build_entry(repo: str, number: int) -> dict:
    pr = gh_api(f"repos/{repo}/pulls/{number}")
    owner, name = repo.split("/")
    url = pr["html_url"]
    return {
        "golden_url": url, "fetched_from_url": url, "owner": owner, "repo": name, "pr_number": number,
        "source_repo": name, "pr_title": pr.get("title") or "", "pr_body": pr.get("body") or "",
        "base_sha": pr["base"]["sha"], "base_ref": pr["base"]["ref"],
        "head_sha": pr["head"]["sha"], "head_ref": pr["head"]["ref"],
        "author": (pr.get("user") or {}).get("login"), "author_type": (pr.get("user") or {}).get("type"),
        "labels": [l["name"] for l in pr.get("labels", [])],
        "files": fetch_files(repo, number),
        "golden_comments": [], "pr_labels": {}, "in_praf_38": False, "praf_id": f"{name}#{number}",
        "clean_basis": CLEAN_BASIS,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--exclude-bundle", type=Path, required=True, help="Martian bundle; its PRs are skipped")
    ap.add_argument("--per-repo", type=int, default=4)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    martian = json.loads(args.exclude_bundle.read_text())
    excluded = {(v.get("owner", ""), v.get("repo", ""), v.get("pr_number")) for v in martian.values()}
    bundle: dict[str, dict] = {}
    for listed in REPOS:
        # Search needs the current repo name (e.g. calcom/cal.com now redirects to a new name).
        try:
            repo = gh_api(f"repos/{listed}")["full_name"]
            res = search(f"repo:{repo} is:pr is:merged merged:{MERGED_RANGE}")
        except (RuntimeError, KeyError) as e:
            print(f"warning: skipping {listed}: {e}", file=sys.stderr)
            continue
        if repo != listed:
            print(f"note: {listed} is now {repo}", file=sys.stderr)
        owner, name = listed.split("/")
        kept = 0
        for item in res.get("items", []):
            if kept >= args.per_repo:
                break
            n = item["number"]
            if is_bot(item.get("user")) or (owner, name, n) in excluded:
                continue
            if has_revert(repo, n, item.get("title") or ""):
                print(f"skip {repo}#{n}: revert found", file=sys.stderr)
                continue
            entry = build_entry(repo, n)
            bundle[entry["fetched_from_url"]] = entry
            kept += 1
            print(f"kept {repo}#{n}", file=sys.stderr)
        if kept < args.per_repo:
            print(f"warning: only {kept}/{args.per_repo} PRs for {repo}", file=sys.stderr)
    args.out.write_text(json.dumps(bundle, indent=2))
    print(f"wrote {len(bundle)} PRs to {args.out}")


if __name__ == "__main__":
    main()
