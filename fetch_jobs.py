#!/usr/bin/env python3
"""Poll public job boards, keep jobs that fit the resume, score keyword matches, write docs/jobs.js.

Rules only, no AI at runtime. Standard library only. Run: python3 fetch_jobs.py
"""
import html
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "jobs.js"
PREFIX = "window.JOB_DATA = "
UA = "job-radar/1.0 (personal job search)"

CANADA = re.compile(
    r"\b(canada|canadian|vancouver(?!,?\s*wa\b)|toronto|montr[eé]al|calgary|ottawa|waterloo|kitchener|edmonton"
    r"|winnipeg|halifax|burnaby|qu[eé]bec|mississauga|markham|british columbia|ontario|alberta)\b", re.I)
CA_PROV = re.compile(r",\s*(BC|ON|AB|QC|MB|NS|SK|NB|NL|PE)\b")
US = re.compile(
    r"\b(united states|usa|u\.s\.|san francisco|new york|nyc|seattle|austin|boston|chicago|los angeles|denver"
    r"|atlanta|miami|palo alto|mountain view|sunnyvale|san jose|san mateo|menlo park|oakland|redmond|bellevue"
    r"|portland|salt lake|phoenix|dallas|houston|philadelphia|pittsburgh|minneapolis|raleigh|washington|bay area"
    r"|silicon valley|brooklyn)\b", re.I)
US_CODE = re.compile(r"(?<![A-Za-z])US(?![A-Za-z])|,\s*(AL|AK|AZ|AR|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD"
                     r"|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b")
CALIFORNIA = re.compile(r",\s*CA\b")  # also ISO code for Canada, so only trusted when no Canadian marker
REMOTE = re.compile(r"\b(remote|anywhere|worldwide|global|distributed)\b", re.I)
AMERICAS = re.compile(r"north america|americas", re.I)
ELSEWHERE = re.compile(
    r"\b(europe|emea|uk|united kingdom|england|germany|france|spain|portugal|netherlands|poland|ireland|india"
    r"|apac|asia|australia|new zealand|latam|latin america|brazil|mexico|argentina|colombia|philippines|singapore"
    r"|japan|africa|israel|london|berlin|paris|amsterdam|lisbon|dublin|bangalore|bengaluru)\b", re.I)
EXPERIENCE = re.compile(
    r"(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?years?(?:\s+of)?(?:\s+[\w/&-]+){0,5}?\s+experience", re.I)
COUNTRY = {"US": "United States", "CA": "Canada"}


def get_json(url):
    with urlopen(Request(url, headers={"User-Agent": UA, "Accept": "application/json"}), timeout=30) as r:
        return json.load(r)


def text(s):
    """HTML (possibly entity-escaped twice, as Greenhouse sends it) -> plain text."""
    return html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(s or "")))


def when(v):
    if v in (None, ""):
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, timezone.utc)
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (ValueError, OverflowError):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def join(*parts):
    return " / ".join(p for p in parts if p)


# ---- Sources: each returns [{title, company, location, url, posted, description}] ----

def greenhouse(slug, name):
    data = get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")
    return [dict(title=j["title"], company=name, location=(j.get("location") or {}).get("name", ""),
                 url=j["absolute_url"], posted=j.get("first_published") or j.get("updated_at"),
                 description=j.get("content", "")) for j in data["jobs"]]


def lever(slug, name):
    out = []
    for j in get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json"):
        c = j.get("categories") or {}
        lists = " ".join(f"{x.get('text', '')} {x.get('content', '')}" for x in j.get("lists") or [])
        out.append(dict(title=j["text"], company=name, url=j["hostedUrl"], posted=j.get("createdAt"),
                        location=join(c.get("location"), *(c.get("allLocations") or []), j.get("workplaceType"),
                                      COUNTRY.get(j.get("country"))),
                        description=join(j.get("descriptionPlain"), lists, j.get("additionalPlain"))))
    return out


def ashby(slug, name):
    out = []
    for j in get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}")["jobs"]:
        if j.get("isListed") is False:
            continue
        addr = ((j.get("address") or {}).get("postalAddress") or {})
        out.append(dict(title=j["title"], company=name, url=j["jobUrl"], posted=j.get("publishedAt"),
                        location=join(j.get("location"), *(s.get("location") for s in j.get("secondaryLocations") or []),
                                      addr.get("addressCountry"), "Remote" if j.get("isRemote") else ""),
                        description=j.get("descriptionPlain") or j.get("descriptionHtml", "")))
    return out


BOARDS = {"Greenhouse": (greenhouse, "https://boards.greenhouse.io/{}"),
          "Lever": (lever, "https://jobs.lever.co/{}"),
          "Ashby": (ashby, "https://jobs.ashbyhq.com/{}")}


def remotive():
    return [dict(title=j["title"], company=j["company_name"], url=j["url"], posted=j.get("publication_date"),
                 location="Remote " + (j.get("candidate_required_location") or ""), description=j.get("description", ""))
            for j in get_json("https://remotive.com/api/remote-jobs?category=software-dev")["jobs"]]


def remoteok():
    return [dict(title=j["position"], company=j.get("company", ""), url=j.get("url", ""), posted=j.get("date"),
                 location="Remote " + (j.get("location") or ""),
                 description=j.get("description", "") + " " + " ".join(j.get("tags") or []))
            for j in get_json("https://remoteok.com/api") if "position" in j]  # first item is a legal notice


def jobicy():
    return [dict(title=j["jobTitle"], company=j["companyName"], url=j["url"], posted=j.get("pubDate"),
                 location="Remote " + str(j.get("jobGeo", "")), description=j.get("jobDescription", ""))
            for geo in ("usa", "canada")
            for j in get_json(f"https://jobicy.com/api/v2/remote-jobs?count=100&geo={geo}").get("jobs", [])]


FEEDS = {"remotive": ("Remotive", remotive, "https://remotive.com"),
         "remoteok": ("RemoteOK", remoteok, "https://remoteok.com"),
         "jobicy": ("Jobicy", jobicy, "https://jobicy.com")}


def run_company(entry):
    slug, _, name = entry.partition("|")
    name = name or slug.replace("-", " ").title()
    err = "not found on Greenhouse, Lever or Ashby"
    for ats, (fn, page) in BOARDS.items():
        try:
            jobs = fn(slug, name)
        except HTTPError as e:
            if e.code != 404:
                err = f"{ats}: HTTP {e.code}"
            continue
        except Exception as e:  # one bad board must not sink the run
            err = f"{ats}: {type(e).__name__}"
            continue
        if jobs:
            return dict(name=name, kind=ats, url=page.format(slug), ok=True), [dict(j, source=ats) for j in jobs]
    return dict(name=name, kind="Company board", url="", ok=False, error=err), []


def run_feed(key):
    name, fn, url = FEEDS[key]
    try:
        return dict(name=name, kind="Job feed", url=url, ok=True), [dict(j, source=name) for j in fn()]
    except Exception as e:
        return dict(name=name, kind="Job feed", url=url, ok=False, error=type(e).__name__), []


# ---- Rules ----

def compile_keywords(d):
    out = {}
    for name, aliases in d.items():
        if name.startswith("_"):
            continue
        pats = []
        for a in aliases:
            if a.startswith("re:"):
                pats.append(a[3:])
            else:
                p = r"(?<![A-Za-z0-9])" + re.escape(a.lstrip("=")) + r"(?![A-Za-z0-9+#])"
                pats.append(p if a.startswith("=") else f"(?i:{p})")
        out[name] = re.compile("|".join(pats))
    return out


def skills(kw, s):
    return {name for name, rx in kw.items() if rx.search(s)}


def where(loc):
    canada = bool(CANADA.search(loc) or CA_PROV.search(loc))
    tags = (["Canada"] if canada else []) + (["US"] if US.search(loc) or US_CODE.search(loc)
                                             or (CALIFORNIA.search(loc) and not canada) else [])
    if REMOTE.search(loc) and (tags or AMERICAS.search(loc) or not ELSEWHERE.search(loc)):
        tags.append("Remote")
    return tags


def years_required(body):
    return max((int(m.group(1)) for m in EXPERIENCE.finditer(body) if 0 < int(m.group(1)) <= 15), default=None)


def load_rules(root=ROOT):
    cfg = json.loads((root / "config.json").read_text())
    kw = compile_keywords(json.loads((root / "keywords.json").read_text()))
    return dict(cfg=cfg, kw=kw, resume=skills(kw, (root / "resume.txt").read_text()),
                include=re.compile(cfg["title_include"], re.I), exclude=re.compile(cfg["title_exclude"], re.I))


def evaluate(job, r, cutoff):
    """Apply the rules to one raw job. Returns the dashboard row, or None if it doesn't qualify."""
    title, cfg = job["title"].strip(), r["cfg"]
    if not r["include"].search(title) or r["exclude"].search(title):
        return None
    tags = [t for t in where(job["location"]) if t in cfg["locations"]]
    posted = when(job["posted"])
    if not tags or (posted and posted < cutoff) or not str(job["url"]).startswith(("https://", "http://")):
        return None
    body = text(job["description"])
    found = skills(r["kw"], f"{title}\n{body}")
    matched = [k for k in r["kw"] if k in found and k in r["resume"]]
    if len(matched) < cfg["min_matched_keywords"]:
        return None
    return dict(title=title, company=job["company"].strip(), where=tags, location=job["location"][:160],
                url=job["url"], posted=posted.isoformat() if posted else None, source=job["source"],
                applicants=job.get("applicants"),  # no public board API exposes this; dashboard shows "Not available"
                score=round(100 * len(matched) / len(found)), matched=matched,
                missing=[k for k in r["kw"] if k in found and k not in r["resume"]],
                years_required=years_required(body))


def previous_first_seen():
    try:
        return {j["url"]: j["first_seen"] for j in json.loads(OUT.read_text()[len(PREFIX):].rstrip(";\n"))["jobs"]}
    except (FileNotFoundError, ValueError, KeyError):
        return {}


def main():
    r = load_rules()
    cfg, now = r["cfg"], datetime.now(timezone.utc)
    cutoff = now - timedelta(days=cfg["max_age_days"])
    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(run_company, cfg["companies"])) + list(ex.map(run_feed, cfg["feeds"]))
    if not any(src["ok"] for src, _ in results):
        sys.exit("Every source failed; keeping the previous data.")  # don't wipe the dashboard on a network outage

    seen, rows = previous_first_seen(), {}
    for src, raw in results:
        src["seen"] = len(raw)
        kept = [row for row in (evaluate(j, r, cutoff) for j in raw) if row]
        src["kept"] = len(kept)
        for row in kept:  # one row per company+title; boards often repeat a role per city
            key = (row["company"].lower(), row["title"].lower())
            if key in rows:
                rows[key]["where"] = sorted(set(rows[key]["where"]) | set(row["where"]))
            else:
                rows[key] = dict(row, first_seen=seen.get(row["url"], now.isoformat()))

    jobs = sorted(rows.values(), key=lambda j: (-j["score"], -len(j["matched"]), j["company"]))
    data = dict(generated_at=now.isoformat(), candidate=cfg["candidate"], years_experience=cfg["years_experience"],
                resume_skills=[k for k in r["kw"] if k in r["resume"]],
                sources=sorted((s for s, _ in results), key=lambda s: (not s["ok"], s["name"].lower())), jobs=jobs)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(PREFIX + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
    ok = sum(s["ok"] for s, _ in results)
    print(f"{len(jobs)} jobs kept from {sum(s['seen'] for s, _ in results)} seen; {ok}/{len(results)} sources OK")
    for s, _ in results:
        if not s["ok"]:
            print(f"  failed: {s['name']} — {s['error']}")


if __name__ == "__main__":
    main()
