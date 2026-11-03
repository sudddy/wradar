"""What one scan keeps from the last: first_seen, Workday dates, and the rows of slow sources between slots.

A job is lowercased company|title, because a role's URL can change from one scan to the next.
"""
import json
from datetime import datetime

PREFIX = "window.JOB_DATA = "
SLOW = {"remotive", "workable", "workday", "smartrecruiters", "jobicy"}  # strict limits, or a detail call per job
SLOT_SECONDS = 6 * 3600
NEWER = dict(must=[], nice=[], salary=None, mode=None, degree=None, posted_approx=False)  # fields a row from older data lacks


def load_previous(path):
    try:
        return json.loads(path.read_text()[len(PREFIX):].rstrip(";\n"))
    except (FileNotFoundError, ValueError):
        return {}


def job_key(j):
    return f"{j['company'].strip()}|{j['title'].strip()}".lower()  # evaluate() strips both


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


def merge(rows, prev, now, cutoff):
    """One row per company+title, as boards often repeat a role per city. A carried row can't outlive the cutoff."""
    before, out = {job_key(j): j for j in prev.get("jobs", [])}, {}
    for row in rows:
        row, key = {**NEWER, **row}, job_key(row)  # a held or failed source's rows may come from older data
        if key in out:
            out[key]["where"] = sorted(set(out[key]["where"]) | set(row["where"]))
        else:
            out[key] = carry(row, before.get(key), now)
    return [j for j in out.values() if datetime.fromisoformat(j["posted"] or j["first_seen"]) >= cutoff]  # app's age
