"""What one scan keeps from the last: first_seen, Workday dates, and the rows of slow sources between slots.

A job is lowercased company|title, because a role's URL can change from one scan to the next.
"""
import json
import re
from datetime import datetime

PREFIX = "window.JOB_DATA = "
SLOW = {"remotive", "workable", "workday", "smartrecruiters", "jobicy"}  # strict limits, or a detail call per job
SLOT_SECONDS = 6 * 3600
NEWER = dict(must=[], nice=[], salary=None, mode=None, degree=None, posted_approx=False)  # fields a row from older data lacks
LEGAL = {"inc", "llc", "ltd", "limited", "corp", "corporation", "co", "gmbh", "ag", "ab", "plc", "sa", "bv", "srl", "pty", "oy"}
SHORT = {"sr": "senior", "jr": "junior"}  # as the level rules read them


def load_previous(path):
    try:
        return json.loads(path.read_text()[len(PREFIX):].rstrip(";\n"))
    except (FileNotFoundError, ValueError):
        return {}


def job_key(j):
    return f"{j['company'].strip()}|{j['title'].strip()}".lower()  # evaluate() strips both


def same_job(j):
    """job_key read loosely, for one job listed twice: spacing, punctuation and a legal suffix ("Samsara Inc.") don't count."""
    words = lambda text: re.findall(r"[^\W_]+|[+#]+", text.lower())  # keeps C++ and C# apart
    company = words(j["company"])
    while len(company) > 1 and company[-1] in LEGAL:
        company.pop()
    title = [SHORT.get(w, w) for w in words(j["title"])]
    return " ".join(company) + "|" + "".join(title)  # joined, so Fullstack, Full-stack and Full Stack are one


def slot(t):
    return t.timestamp() // SLOT_SECONDS


def slot_open(prev, now):
    """True when slow sources last ran in an earlier 6-hour UTC slot, so they run at most 4 times a day."""
    last = prev.get("slow_fetched_at")
    return not last or slot(datetime.fromisoformat(last)) != slot(now)


def is_slow(task):
    kind, entry = task
    return (entry if kind == "feed" else kind) in SLOW


def held_over(prev):
    """-> (sources, rows) of the slow sources in the last scan, to stand in for the ones skipped this time."""
    sources = [s for s in prev.get("sources", []) if (s["name"] if s["kind"] == "Job boards" else s["kind"]).lower() in SLOW]
    return sources, [j for j in prev.get("jobs", []) if j["source"].lower() in SLOW]


def owns(src, job):
    """Feeds stamp their rows with their own name, company boards with the platform's. Greenhouse names can end in a space."""
    return job["source"] == src["name"] if src["kind"] == "Job boards" else (job["source"], job["company"]) == (
        src["kind"], src["name"].strip())


def failed_over(prev, sources):
    """-> (sources, rows): a source that failed this scan keeps its last name and its rows from the last scan."""
    last = {s["url"]: s["name"] for s in prev.get("sources", [])}  # a failed Greenhouse board only knows its slug
    sources = [s if s["ok"] else dict(s, name=last.get(s["url"], s["name"])) for s in sources]
    failed = [s for s in sources if not s["ok"]]
    return sources, [j for j in prev.get("jobs", []) if any(owns(s, j) for s in failed)]


def carry(row, before, now):
    """first_seen survives between scans. Workday dates are relative to the scan, so the oldest one wins."""
    if not before:
        return dict(row, first_seen=now.isoformat())
    row = dict(row, first_seen=before["first_seen"])
    if (before["source"] == row["source"] == "Workday"
            and datetime.fromisoformat(before["posted"]) < datetime.fromisoformat(row["posted"])):
        row.update(posted=before["posted"], posted_approx=before.get("posted_approx", row["posted_approx"]))
    return row


def merge(rows, prev, now, cutoff, own=()):
    """One row per job, as boards often repeat a role per city and two sources can list one job written a little differently.
    The row kept is the one the last scan had, else one from the company's own board (a source in own), so its link and its
    tracker key hold still. A carried row can't outlive the cutoff."""
    before, out = {job_key(j): j for j in prev.get("jobs", [])}, {}
    loose = {same_job(j): j for j in prev.get("jobs", [])}  # the last scan's copy, when another spelling of it is all that's left
    rows = sorted(({**NEWER, **r} for r in rows), key=lambda r: (job_key(r) not in before, r["source"] not in own))  # NEWER: a held or failed source's rows may come from older data
    for row in rows:
        key = same_job(row)
        if key in out:
            out[key]["where"] = sorted(set(out[key]["where"]) | set(row["where"]))
            continue
        last = before.get(job_key(row)) or loose.get(key)
        if last and last["company"] == row["company"]:  # same board's other spelling: keep the title, so the tracker key holds
            row = dict(row, title=last["title"])
        kept = carry(row, last, now)
        if datetime.fromisoformat(kept["posted"] or kept["first_seen"]) >= cutoff:  # app's age; a copy too old lets the next stand in
            out[key] = kept
    return list(out.values())
