#!/usr/bin/env python3
"""Poll public job boards, keep software engineering jobs, tag their skills, write docs/jobs.js.

Rules only, no AI at runtime. Standard library only. Run: python3 fetch_jobs.py
Resume matching happens in the dashboard, against whichever resume the viewer uploads.
"""
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import cache, partial
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from extract import (degree, pick_pay, rich_text, salary, split_sections, structured_pay, tier_skills, work_mode,
                     years_min)
from scan_state import PREFIX, failed_over, held_over, is_slow, job_key, load_previous, merge, slot_open

ROOT = Path(__file__).parent
OUT = ROOT / "docs" / "jobs.js"
UA = "wradar/1.0 (+https://github.com/sudddy/wradar)"
NOW = datetime.now(timezone.utc)

US_STATES = ("alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho"
             "|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota"
             "|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|north carolina"
             "|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee"
             "|texas|utah|vermont|virginia|west virginia|wisconsin|wyoming")
CANADA = re.compile(
    r"\b(canada|canadian|vancouver(?!,?\s*wa\b)|toronto|montr[eé]al|calgary|ottawa|waterloo|kitchener|edmonton"
    r"|winnipeg|halifax|burnaby|qu[eé]bec|mississauga|markham|saskatoon|regina|british columbia|ontario|alberta"
    r"|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland)\b", re.I)
CA_PROV = re.compile(r",\s*(BC|ON|AB|QC|MB|NS|SK|NB|NL|PE)\b")
US = re.compile(
    r"\b(united states|usa|san francisco|new york|nyc|seattle|austin|boston|chicago|los angeles|denver"
    r"|atlanta|miami|palo alto|mountain view|sunnyvale|san jose|san mateo|menlo park|oakland|redmond|bellevue"
    r"|portland|salt lake|phoenix|dallas|houston|philadelphia|pittsburgh|minneapolis|raleigh|washington|bay area"
    rf"|silicon valley|brooklyn|santa clara|{US_STATES})\b|(?<![A-Za-z])u\.s\.(?![A-Za-z])", re.I)
US_CODE = re.compile(r"(?<![A-Za-z])US(?![A-Za-z])|,\s*(AL|AK|AZ|AR|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD"
                     r"|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b")
CALIFORNIA = re.compile(r",\s*CA\b")  # also ISO code for Canada, so only trusted when no Canadian marker
REMOTE = re.compile(r"\b(remote|anywhere|worldwide|global|distributed)\b", re.I)
AMERICAS = re.compile(r"north america|americas", re.I)
ELSEWHERE = re.compile(
    r"\b(europe|emea|uk|united kingdom|england|germany|france|spain|portugal|netherlands|poland|ireland|india"
    r"|apac|asia|australia|new zealand|latam|latin america|brazil|mexico|argentina|colombia|philippines|singapore"
    r"|japan|africa|israel|london|berlin|paris|amsterdam|lisbon|dublin|bangalore|bengaluru)\b", re.I)
# Job type: an explicit field or the title is trusted; the body only counts when it says so plainly.
TYPE_FIELD = [("Contract", r"contract|freelance|temporary|\btemp\b|fixed[-_ ]?term|short[-_ ]?term|seasonal"),
              ("Part-time", r"part[-_ ]?time"),
              ("Full-time", r"full[-_ ]?time|permanent|regular")]
TYPE_BODY = [("Contract", r"\b(contract|contractor|freelance) (role|position|opportunity|basis|engagement|assignment)\b"
                          r"|\bcontract[- ]to[- ]hire\b|\b(1099|c2c|corp[- ]to[- ]corp)\b|\b\d+[- ]month contract\b"),
             ("Part-time", r"\bpart[- ]time (role|position|basis|opportunity|job)\b|\bthis is a part[- ]time\b"),
             ("Full-time", r"\bfull[- ]time\b")]
ROLE = re.compile(r"engineer|developer|swe\b|programmer|technical staff", re.I)
# Seniority and role family come from the title; a title like "Software Engineer" falls back to its skills.
LEVELS = [("Staff+", r"(?<!technical )\bstaff\b|\b(principal|distinguished|architect|fellow)\b"),
          ("Senior", r"\b(senior|sr\.?|lead|iii|iv)\b"),
          ("Junior", r"\b(junior|jr\.?|entry|associate|i)\b")]
FAMILIES = [("Full stack", r"full[- ]?stack"),
            ("Backend", r"back[- ]?end|server[- ]side|\bapi\b|distributed systems|\bpayments?\b|ledger|integrations?\b"),
            ("Frontend", r"front[- ]?end|\bui\b|\bweb developer"),
            ("Mobile", r"\b(ios|android|mobile|react native)\b"),
            ("Security", r"security"),
            ("ML / AI", r"machine learning|\bml\b|\bai\b|\bllms?\b|deep learning|\bnlp\b"),
            ("Data", r"\bdata\b|analytics|\betl\b"),
            ("DevOps / SRE", r"devops|\bsre\b|site reliability|infrastructure|\bplatform\b|\bcloud\b|reliability"),
            ("QA / Test", r"\bqa\b|\btest|sdet|quality"),
            ("Embedded", r"embedded|firmware")]
BACKEND = {"Java", "Go", "Python", "Kotlin", "Scala", "Rust", "C#", ".NET", "Ruby on Rails", "Node.js", "Spring Boot",
           "Django", "Kafka", "PostgreSQL", "MySQL", "Redis", "Microservices", "Distributed Systems", "gRPC", "REST APIs"}
FRONTEND = {"React", "Angular", "Vue.js", "Next.js", "Redux", "HTML/CSS"}
COUNTRY = {"US": "United States", "USA": "United States", "CA": "Canada", "CAN": "Canada"}


def fetch(url, body=None):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        body, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    with urlopen(Request(url, data=body, headers=headers), timeout=30) as r:
        return r.read()


def get_json(url, body=None):
    return json.loads(fetch(url, body))


def text(s):
    """HTML (possibly entity-escaped twice, as Greenhouse sends it) -> plain text."""
    return html.unescape(re.sub(r"<[^>]+>", " ", html.unescape(s or "")))


def when(v):
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v / 1000 if v > 1e11 else v, timezone.utc)
        s = re.sub(r"\s+", " ", str(v).strip())
        for parse in (lambda: datetime.fromisoformat(s.replace("Z", "+00:00")),
                      lambda: datetime.strptime(s, "%B %d, %Y"),  # Amazon: "October 30, 2026"
                      lambda: parsedate_to_datetime(s)):  # RSS
            try:
                d = parse()
                return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                pass
    except (ValueError, OverflowError):
        pass
    return None


def join(*parts):
    return " / ".join(p for p in parts if p)


def days_ago(s):
    """Workday's "Posted Today" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" -> days."""
    s = s.lower()
    if "today" in s:
        return 0
    if "yesterday" in s:
        return 1
    m = re.search(r"(\d+)(\+?)", s)
    return int(m.group(1)) + bool(m.group(2)) if m else 0


# ---- Company boards: fn(slug, name) -> [{title, company, location, url, posted, type, description}] ----
# location / type / description may be functions; they are only called for jobs that pass the cheaper rules.

def greenhouse(slug, name):
    return [dict(title=j["title"], company=j.get("company_name") or name, url=j["absolute_url"],
                 posted=j.get("first_published") or j.get("updated_at"), description=j.get("content", ""),
                 location=join((j.get("location") or {}).get("name"),
                               *(o.get("location") or o.get("name") for o in j.get("offices") or [])))
            for j in get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")["jobs"]]


def lever(slug, name):
    out = []
    for j in get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json"):
        c, pay = j.get("categories") or {}, j.get("salaryRange") or {}
        lists = "".join(f"<p>{x.get('text', '')}</p><ul>{x.get('content', '')}</ul>" for x in j.get("lists") or [])
        out.append(dict(title=j["text"], company=name, url=j["hostedUrl"], posted=j.get("createdAt"),
                        type=c.get("commitment"), mode=j.get("workplaceType"),
                        salary=structured_pay(pay.get("min"), pay.get("max"), pay.get("currency"), pay.get("interval")),
                        location=join(c.get("location"), *(c.get("allLocations") or []), j.get("workplaceType"),
                                      COUNTRY.get(j.get("country"))),
                        description=j.get("description", "") + lists + j.get("additional", "")))
    return out


def ashby(slug, name):
    out = []
    for j in get_json(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true")["jobs"]:
        if j.get("isListed") is False:
            continue
        addr = (j.get("address") or {}).get("postalAddress") or {}
        remote = j.get("workplaceType") == "Remote" or (j.get("isRemote") and not j.get("workplaceType"))
        location = join(j.get("location"), *(s.get("location") for s in j.get("secondaryLocations") or []),
                        addr.get("addressCountry"), "Remote" if remote else "")
        pays = [structured_pay(c.get("minValue"), c.get("maxValue"), c.get("currencyCode"), c.get("interval"))
                for t in (j.get("compensation") or {}).get("compensationTiers") or []  # one per region, any currency
                for c in t.get("components") or [] if c.get("compensationType") == "Salary"]
        out.append(dict(title=j["title"], company=name, url=j["jobUrl"], posted=j.get("publishedAt"),
                        type=j.get("employmentType"), mode=j.get("workplaceType"), location=location,
                        salary=pick_pay([p for p in pays if p], where(location)),
                        description=j.get("descriptionHtml") or j.get("descriptionPlain", "")))
    return out


def smartrecruiters(slug, name):
    api, out, offset = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings", [], 0
    while True:
        page = get_json(f"{api}?limit=100&offset={offset}")
        for p in page["content"]:
            loc = p.get("location") or {}
            out.append(dict(title=p["name"], company=name, url=f"https://jobs.smartrecruiters.com/{slug}/{p['id']}",
                            posted=p.get("releasedDate"), type=(p.get("typeOfEmployment") or {}).get("label"),
                            mode="Hybrid" if loc.get("hybrid") else "Remote" if loc.get("remote") else None,
                            location=join(loc.get("fullLocation"), COUNTRY.get(str(loc.get("country")).upper()),
                                          "Remote" if loc.get("remote") and not loc.get("hybrid") else ""),
                            description=lambda pid=p["id"]: "".join(
                                f"<p>{s.get('title', '')}</p>{s.get('text', '')}"
                                for s in get_json(f"{api}/{pid}")["jobAd"]["sections"].values())))
        offset += 100
        if offset >= min(page["totalFound"], 1000):
            return out


def workable(slug, name):
    return [dict(title=j["title"], company=name, url=j["url"], posted=j.get("published_on") or j.get("created_at"),
                 type=j.get("employment_type"), description=j.get("description", ""),
                 location=join(j.get("city"), j.get("state"), j.get("country"), "Remote" if j.get("telecommuting") else "",
                               *(" ".join(v for v in loc.values() if isinstance(v, str)) for loc in j.get("locations") or [])))
            for j in get_json(f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true")["jobs"]]


def workday(spec, name, query="software engineer", limit=200):
    """spec is "<tenant>.<wdN>/<site>", e.g. "nvidia.wd5/NVIDIAExternalCareerSite"."""
    host, site = spec.split("/")
    base = f"https://{host}.myworkdayjobs.com"
    api, out, total = f"{base}/wday/cxs/{host.split('.')[0]}/{site}", [], limit
    for offset in range(0, limit, 20):
        if offset >= total:
            break
        page = get_json(f"{api}/jobs", {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": query})
        if not page.get("jobPostings"):
            break
        total = page.get("total") or total  # only the first page reports it
        for p in page.get("jobPostings", []):
            if "title" not in p:  # Workday's own board lists the odd posting with no title
                continue
            info = cache(lambda path=p["externalPath"]: get_json(api + path)["jobPostingInfo"])
            loc = p.get("locationsText", "")
            out.append(dict(title=p["title"], company=name, url=f"{base}/{site}{p['externalPath']}",
                            posted=NOW - timedelta(days=days_ago(p.get("postedOn", ""))),
                            posted_approx="+" in p.get("postedOn", ""),
                            location=(lambda i=info: join(i().get("location"), *(i().get("additionalLocations") or []),
                                                          (i().get("country") or {}).get("descriptor")))
                            if re.fullmatch(r"\d+ Locations", loc) else loc,
                            type=lambda i=info: i().get("timeType"),
                            description=lambda i=info: i().get("jobDescription", "")))
    return out


BOARDS = {"greenhouse": ("Greenhouse", greenhouse, "https://boards.greenhouse.io/{}"),
          "lever": ("Lever", lever, "https://jobs.lever.co/{}"),
          "ashby": ("Ashby", ashby, "https://jobs.ashbyhq.com/{}"),
          "smartrecruiters": ("SmartRecruiters", smartrecruiters, "https://jobs.smartrecruiters.com/{}"),
          "workable": ("Workable", workable, "https://apply.workable.com/{}"),
          "workday": ("Workday", workday, "https://{}")}


# ---- Job feeds and big-company sites: fn() -> same shape ----

def remotive():
    return [dict(title=j["title"], company=j["company_name"], url=j["url"], posted=j.get("publication_date"),
                 type=j.get("job_type"), location="Remote " + (j.get("candidate_required_location") or ""),
                 description=j.get("description", ""))
            for j in get_json("https://remotive.com/api/remote-jobs?category=software-dev")["jobs"]]


def remoteok():
    return [dict(title=j["position"], company=j.get("company", ""), url=j.get("url", ""), posted=j.get("date"),
                 location="Remote " + (j.get("location") or ""),
                 description=j.get("description", "") + " " + " ".join(j.get("tags") or []))
            for j in get_json("https://remoteok.com/api") if "position" in j]  # first item is a legal notice


def jobicy():
    return [dict(title=j["jobTitle"], company=j["companyName"], url=j["url"], posted=j.get("pubDate"),
                 type=" ".join(j.get("jobType") or []), location="Remote " + str(j.get("jobGeo", "")),
                 description=j.get("jobDescription", ""))
            for geo in ("usa", "canada")
            for j in get_json(f"https://jobicy.com/api/v2/remote-jobs?count=100&geo={geo}").get("jobs", [])]


def himalayas():
    return [dict(title=j["title"], company=j["companyName"], url=j["applicationLink"], posted=j.get("pubDate"),
                 type=j.get("employmentType"), location="Remote " + ", ".join(j.get("locationRestrictions") or []),
                 description=j.get("description", ""))
            for country in ("United States", "Canada") for page in range(1, 11)
            for j in get_json(f"https://himalayas.app/jobs/api/search?q=software%20engineer"
                              f"&country={quote(country)}&page={page}")["jobs"]]


def weworkremotely():
    out = []
    for cat in ("back-end-programming", "full-stack-programming", "devops-sysadmin"):
        for it in ET.fromstring(fetch(f"https://weworkremotely.com/categories/remote-{cat}-jobs.rss")).iter("item"):
            company, _, title = it.findtext("title", "").partition(": ")
            out.append(dict(title=title or company, company=company, url=it.findtext("link", ""),
                            posted=it.findtext("pubDate"), type=it.findtext("type"),
                            location="Remote " + join(it.findtext("region"), it.findtext("country"), it.findtext("state")),
                            description=it.findtext("description", "")))
    return out


def workingnomads():
    return [dict(title=j["title"], company=j["company_name"], url=j["url"], posted=j.get("pub_date"),
                 location="Remote " + (j.get("location") or ""),
                 description=f"{j.get('description', '')} {j.get('tags') or ''}")
            for j in get_json("https://www.workingnomads.com/api/exposed_jobs/") if j.get("category_name") == "Development"]


def themuse():
    base = ("https://www.themuse.com/api/public/jobs?category=Software%20Engineering&level=Senior%20Level"
            "&level=Mid%20Level&location=United%20States&location=Canada&location=Flexible%20%2F%20Remote")
    out, page, pages = [], 0, 1
    while page < min(pages, 40):
        data = get_json(f"{base}&page={page}")
        pages, page = data["page_count"], page + 1
        out += [dict(title=j["name"], company=j["company"]["name"], url=j["refs"]["landing_page"],
                     posted=j.get("publication_date"), location=join(*(l["name"] for l in j.get("locations") or [])),
                     description=j.get("contents", "")) for j in data["results"]]
    return out


def hackernews():
    """This month's "Ask HN: Who is hiring?" thread. First line is usually "Company | Role | Location | Type"."""
    hits = get_json("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10")["hits"]
    story = next(h for h in hits if "who is hiring" in h["title"].lower())
    out = []
    for c in get_json(f"https://hn.algolia.com/api/v1/items/{story['objectID']}")["children"]:
        first = text((c.get("text") or "").split("<p>")[0])
        parts = [p.strip() for p in re.split(r"\s*[|,;]\s*", first)]
        if first.count("|") < 2:
            continue
        out.append(dict(title=next((p for p in parts[1:] if ROLE.search(p)), parts[1]), company=parts[0],
                        url=f"https://news.ycombinator.com/item?id={c['id']}", posted=c.get("created_at"),
                        type=first, location=first, description=c.get("text", "")))
    return out


def amazon():
    url = ("https://www.amazon.jobs/en/search.json?base_query=software%20engineer&result_limit=100&sort=recent"
           "&normalized_country_code%5B%5D=USA&normalized_country_code%5B%5D=CAN&offset=")
    return [dict(title=j["title"], company="Amazon", url="https://www.amazon.jobs" + j["job_path"],
                 posted=j.get("posted_date"), type=j.get("job_schedule_type"),
                 location=join(j.get("normalized_location"), COUNTRY.get(j.get("country_code"))),
                 description="<br>".join(v or "" for v in (
                     j.get("description"), "BASIC QUALIFICATIONS", j.get("basic_qualifications"),
                     "PREFERRED QUALIFICATIONS", j.get("preferred_qualifications"))))
            for offset in (0, 100, 200) for j in get_json(url + str(offset))["jobs"]]


FEEDS = {"remotive": ("Remotive", remotive, "https://remotive.com"),
         "remoteok": ("RemoteOK", remoteok, "https://remoteok.com"),
         "jobicy": ("Jobicy", jobicy, "https://jobicy.com"),
         "himalayas": ("Himalayas", himalayas, "https://himalayas.app/jobs"),
         "weworkremotely": ("We Work Remotely", weworkremotely, "https://weworkremotely.com"),
         "workingnomads": ("Working Nomads", workingnomads, "https://www.workingnomads.com"),
         "themuse": ("The Muse", themuse, "https://www.themuse.com/search"),
         "hackernews": ("HN Who's Hiring", hackernews, "https://news.ycombinator.com/submitted?id=whoishiring"),
         "amazon": ("Amazon Jobs", amazon, "https://www.amazon.jobs")}


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


def job_type(field, title, body):
    for s, rules in ((field, TYPE_FIELD), (title, TYPE_FIELD), (body, TYPE_BODY)):
        for name, rx in rules:
            if s and re.search(rx, s, re.I):
                return name
    return "Not specified"


def level(title):
    return next((name for name, rx in LEVELS if re.search(rx, title, re.I)), "Mid")


def family(title, found):
    name = next((name for name, rx in FAMILIES if re.search(rx, title, re.I)), None)
    if name:
        return name
    be, fe = len(found & BACKEND) >= 2, len(found & FRONTEND) >= 2
    return "Full stack" if be and fe else "Backend" if be else "Frontend" if fe else "General"


def load_rules(root=ROOT):
    cfg = json.loads((root / "config.json").read_text())
    keywords = {k: v for k, v in json.loads((root / "keywords.json").read_text()).items() if not k.startswith("_")}
    return dict(cfg=cfg, keywords=keywords, kw=compile_keywords(keywords),
                include=re.compile(cfg["title_include"], re.I), exclude=re.compile(cfg["title_exclude"], re.I))


def evaluate(job, r, cutoff):
    """Apply the rules to one raw job, cheapest first. Returns the dashboard row, or None if it doesn't qualify."""
    val = lambda k: job[k]() if callable(job.get(k)) else job.get(k)  # noqa: E731
    title, cfg = job["title"].strip(), r["cfg"]
    if not r["include"].search(title) or r["exclude"].search(title):
        return None
    posted = when(job["posted"])
    if (posted and posted < cutoff) or not str(job["url"]).startswith(("https://", "http://")):
        return None
    location = val("location") or ""
    tags = [t for t in where(location) if t in cfg["locations"]]
    if not tags:
        return None
    body = rich_text(val("description"))
    sec, found = split_sections(body), skills(r["kw"], f"{title}\n{body}")
    names = [k for k in r["kw"] if k in found]
    must, nice = tier_skills(names, title, sec, r["kw"])
    return dict(title=title, company=job["company"].strip(), where=tags, location=location[:120],
                url=job["url"], posted=posted.isoformat() if posted else None, source=job["source"],
                type=job_type(val("type"), title, body), level=level(title), role=family(title, found),
                applicants=job.get("applicants"),  # no public board API exposes this; dashboard shows "Not available"
                skills=names, must=must, nice=nice, years_required=years_min(sec),
                salary=job.get("salary") or salary(body, tags), mode=work_mode(job.get("mode"), title, location, body),
                degree=degree(sec), posted_approx=bool(job.get("posted_approx")))


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
            row = before.get(job_key(j))
        if row:
            rows.append(row)
    return dict(src, ok=True, seen=len(raw), kept=len(rows), **({"skipped": failed} if failed else {})), rows


def main():
    r, prev = load_rules(), load_previous(OUT)
    cfg, run_slow = r["cfg"], slot_open(prev, NOW)
    cutoff, before = NOW - timedelta(days=cfg["max_age_days"]), {job_key(j): j for j in prev.get("jobs", [])}
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
    data = dict(generated_at=NOW.isoformat(), slow_fetched_at=NOW.isoformat() if run_slow else prev["slow_fetched_at"],
                keywords=r["keywords"],  # the dashboard matches uploaded resumes with these
                rules=dict({k: cfg[k] for k in ("max_age_days", "locations", "scan_url")}, levels=LEVELS, families=FAMILIES,
                           backend=sorted(BACKEND), frontend=sorted(FRONTEND)),
                sources=sources, jobs=jobs)
    OUT.parent.mkdir(exist_ok=True)
    # errors: a lone surrogate from a source can't be encoded, and must not stop the scan; it is written as "?"
    OUT.write_text(PREFIX + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", errors="replace")
    OUT.with_name("scan.json").write_text(json.dumps(dict(generated_at=data["generated_at"], jobs=len(jobs))) + "\n")
    ok = sum(s["ok"] for s in sources)
    print(f"{len(jobs)} jobs kept from {sum(s['seen'] for s in sources)} seen; {ok}/{len(sources)} sources OK")
    for s in sources:
        if not s["ok"]:
            print(f"  failed: {s['name']} ({s['kind']}) — {s['error']}")


if __name__ == "__main__":
    main()
