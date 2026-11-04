#!/usr/bin/env python3
"""Poll public job boards, keep every job in the US, Canada or remote, tag its skills, write docs/jobs.js and older.js.

Rules only, no AI at runtime. Standard library only. Run: python3 fetch_jobs.py
Fetching is in sources.py, the rules in rules.py. Resume matching happens in the dashboard, against whichever resume
the viewer uploads.
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from urllib.error import HTTPError

from rules import BACKEND, FAMILIES, FIELDS, FRONTEND, LADDER, LEVELS, ROLES, SEGMENT, evaluate, load_rules
from scan_state import (OLDER, PREFIX, failed_over, held_over, is_slow, job_key, load_previous, merge, same_job,
                        slot_open)
from sources import BOARDS, FEEDS, NOW

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "jobs.js"
FRESH_DAYS = 30  # jobs.js holds rows this new; the rest go to older.js, which the page loads after its first paint


def write_js(path, prefix, data):
    # errors: a lone surrogate from a source can't be encoded, and must not stop the scan; it is written as "?"
    path.write_text(prefix + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", errors="replace")


def describe(e):
    return f"HTTP {e.code}" if isinstance(e, HTTPError) else type(e).__name__


def run_source(task, r, cutoff, before):
    kind, entry = task
    if kind == "feed":
        name, fn, url = FEEDS[entry]
        src = dict(name=name, kind="Job boards", url=url)
    else:
        label, board, page = BOARDS[kind]
        slug, _, name = entry.partition("|")
        name = name or slug.split(".")[0].replace("-", " ").title()
        fn, src = partial(board, slug, name), dict(name=name, kind=label, url=page.format(
            slug.replace("/", ".myworkdayjobs.com/", 1) if kind == "workday" else slug))
    try:
        raw = fn()
    except Exception as e:  # one bad source must not sink the run
        return dict(src, ok=False, error=describe(e), seen=0, kept=0), []
    if raw and kind == "greenhouse":
        src["name"] = raw[0]["company"]  # Greenhouse returns the real company name; slugs are often cryptic
    rows, failed = [], 0
    for j in raw:
        try:
            row = evaluate(dict(j, source=src["kind"] if kind != "feed" else name), r, cutoff)
        except Exception:  # a lazy detail fetch failed; keep that job's row from the last scan, if it had one
            failed += 1
            row = before.get(job_key(j)) or before.get(same_job(j))  # the last scan may have kept another spelling
        if row:
            rows.append(row)
    return dict(src, ok=True, seen=len(raw), kept=len(rows), **({"skipped": failed} if failed else {})), rows


def main():
    r, prev = load_rules(), load_previous(OUT)
    cfg, run_slow = r["cfg"], slot_open(prev, NOW)
    last = prev.get("jobs", [])
    cutoff, before = NOW - timedelta(days=cfg["max_age_days"]), {**{same_job(j): j for j in last}, **{job_key(j): j for j in last}}
    tasks = [(kind, e) for kind, entries in cfg["boards"].items() for e in entries] + [("feed", f) for f in cfg["feeds"]]
    with ThreadPoolExecutor(12) as ex:
        results = list(ex.map(partial(run_source, r=r, cutoff=cutoff, before=before),
                              [t for t in tasks if run_slow or not is_slow(t)]))
    if not any(src["ok"] for src, _ in results):
        sys.exit("Every source failed; keeping the previous data.")  # don't wipe the dashboard on a network outage

    ran, failed_rows = failed_over(prev, [s for s, _ in results])
    held_sources, held_rows = ([], []) if run_slow else held_over(prev)
    jobs = sorted(merge(held_rows + failed_rows + [row for _, kept in results for row in kept], prev, NOW, cutoff,
                        own={label for label, _, _ in BOARDS.values()}), key=lambda j: j["posted"] or j["first_seen"], reverse=True)
    sources = sorted(ran + held_sources, key=lambda s: (not s["ok"], s["name"].lower()))
    old = lambda j: datetime.fromisoformat(j["posted"] or j["first_seen"]) < NOW - timedelta(days=FRESH_DAYS)  # noqa: E731
    data = dict(generated_at=NOW.isoformat(), slow_fetched_at=NOW.isoformat() if run_slow else prev["slow_fetched_at"],
                keywords=r["keywords"],  # the dashboard matches uploaded resumes with these
                rules=dict({k: cfg[k] for k in ("max_age_days", "locations", "scan_url")}, levels=LEVELS, ladder=LADDER,
                           families=FAMILIES, roles=ROLES, segment=SEGMENT, fields=FIELDS,
                           backend=sorted(BACKEND), frontend=sorted(FRONTEND)),
                sources=sources, jobs=[j for j in jobs if not old(j)])
    OUT.parent.mkdir(exist_ok=True)
    write_js(OUT, PREFIX, data)
    write_js(OUT.with_name("older.js"), OLDER, dict(generated_at=data["generated_at"], jobs=[j for j in jobs if old(j)]))
    OUT.with_name("scan.json").write_text(json.dumps(dict(generated_at=data["generated_at"], jobs=len(jobs))) + "\n")
    ok = sum(s["ok"] for s in sources)
    print(f"{len(jobs)} jobs kept from {sum(s['seen'] for s in sources)} seen; {ok}/{len(sources)} sources OK")
    for s in sources:
        if not s["ok"]:
            print(f"  failed: {s['name']} ({s['kind']}) — {s['error']}")


if __name__ == "__main__":
    main()
