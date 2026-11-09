"""Fetch raw jobs from public job boards and feeds. One adapter per source type, standard library only.

Each adapter returns [{title, company, location, url, posted, type, description}], plus dept, the board's department or
category, where the payload has one; rules.evaluate() decides what is kept and reads dept only to place the role.
"""
import html
import json
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from functools import cache
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from extract import pick_pay, structured_pay
from rules import ROLE, where

UA = "wradar/1.0 (+https://github.com/sudddy/wradar)"
NOW = datetime.now(timezone.utc)
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
                 dept=join(*(d.get("name") for d in j.get("departments") or [])),
                 location=join((j.get("location") or {}).get("name"),
                               *(o.get("location") or o.get("name") for o in j.get("offices") or [])))
            for j in get_json(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true")["jobs"]]


def lever(slug, name):
    out = []
    for j in get_json(f"https://api.lever.co/v0/postings/{slug}?mode=json"):
        c, pay = j.get("categories") or {}, j.get("salaryRange") or {}
        lists = "".join(f"<p>{x.get('text', '')}</p><ul>{x.get('content', '')}</ul>" for x in j.get("lists") or [])
        out.append(dict(title=j["text"], company=name, url=j["hostedUrl"], posted=j.get("createdAt"),
                        type=c.get("commitment"), mode=j.get("workplaceType"), dept=join(c.get("department"), c.get("team")),
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
                        dept=join(j.get("department"), j.get("team")), salary=pick_pay([p for p in pays if p], where(location)),
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
                            dept=join((p.get("function") or {}).get("label"), (p.get("department") or {}).get("label")),
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
                 type=j.get("employment_type"), description=j.get("description", ""), dept=j.get("department"),
                 location=join(j.get("city"), j.get("state"), j.get("country"), "Remote" if j.get("telecommuting") else "",
                               *(" ".join(v for v in loc.values() if isinstance(v, str)) for loc in j.get("locations") or [])))
            for j in get_json(f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true")["jobs"]]


def workday(spec, name, query="", limit=200):
    """spec is "<tenant>.<wdN>/<site>", e.g. "nvidia.wd5/NVIDIAExternalCareerSite". An empty search lists newest first."""
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
                 description=j.get("description", ""), dept=j.get("category"))
            for j in get_json("https://remotive.com/api/remote-jobs")["jobs"]]


def remoteok():
    return [dict(title=j["position"], company=j.get("company", ""), url=j.get("url", ""), posted=j.get("date"),
                 location="Remote " + (j.get("location") or ""),
                 description=j.get("description", "") + " " + " ".join(j.get("tags") or []))
            for j in get_json("https://remoteok.com/api") if "position" in j]  # first item is a legal notice


def jobicy():
    return [dict(title=j["jobTitle"], company=j["companyName"], url=j["url"], posted=j.get("pubDate"),
                 type=" ".join(j.get("jobType") or []), location="Remote " + str(j.get("jobGeo", "")),
                 description=j.get("jobDescription", ""), dept=join(*(j.get("jobIndustry") or [])))
            for geo in ("usa", "canada")
            for j in get_json(f"https://jobicy.com/api/v2/remote-jobs?count=100&geo={geo}").get("jobs", [])]


def himalayas():
    return [dict(title=j["title"], company=j["companyName"], url=j["applicationLink"], posted=j.get("pubDate"),
                 type=j.get("employmentType"), location="Remote " + ", ".join(j.get("locationRestrictions") or []),
                 description=j.get("description", ""))
            for country in ("United States", "Canada") for page in range(1, 11)
            for j in get_json(f"https://himalayas.app/jobs/api/search?country={quote(country)}&page={page}")["jobs"]]


WWR_FEEDS = ("back-end-programming", "full-stack-programming", "devops-sysadmin", "front-end-programming", "customer-support",
             "product", "design", "sales-and-marketing", "management-and-finance")


def weworkremotely():
    out = []
    for cat in WWR_FEEDS:
        for it in ET.fromstring(fetch(f"https://weworkremotely.com/categories/remote-{cat}-jobs.rss")).iter("item"):
            company, _, title = it.findtext("title", "").partition(": ")
            out.append(dict(title=title or company, company=company, url=it.findtext("link", ""),
                            posted=it.findtext("pubDate"), type=it.findtext("type"), dept=it.findtext("category"),
                            location="Remote " + join(it.findtext("region"), it.findtext("country"), it.findtext("state")),
                            description=it.findtext("description", "")))
    return out


def workingnomads():
    return [dict(title=j["title"], company=j["company_name"], url=j["url"], posted=j.get("pub_date"),
                 location="Remote " + (j.get("location") or ""), dept=j.get("category_name"),
                 description=f"{j.get('description', '')} {j.get('tags') or ''}")
            for j in get_json("https://www.workingnomads.com/api/exposed_jobs/")]


def themuse():
    base = "https://www.themuse.com/api/public/jobs?location=United%20States&location=Canada&location=Flexible%20%2F%20Remote"
    out, page, pages = [], 0, 1
    while page < min(pages, 99):  # page 100 is refused; results aren't sorted by date, so this is a sample
        data = get_json(f"{base}&page={page}")
        pages, page = data["page_count"], page + 1
        out += [dict(title=j["name"], company=j["company"]["name"], url=j["refs"]["landing_page"],
                     posted=j.get("publication_date"), location=join(*(l["name"] for l in j.get("locations") or [])),
                     dept=join(*(c.get("name") for c in j.get("categories") or [])),
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
    url = ("https://www.amazon.jobs/en/search.json?base_query=&result_limit=100&sort=recent"
           "&normalized_country_code%5B%5D=USA&normalized_country_code%5B%5D=CAN&offset=")
    return [dict(title=j["title"], company="Amazon", url="https://www.amazon.jobs" + j["job_path"],
                 posted=j.get("posted_date"), type=j.get("job_schedule_type"), dept=j.get("job_category"),
                 location=join(j.get("normalized_location"), COUNTRY.get(j.get("country_code"))),
                 description="<br>".join(v or "" for v in (
                     j.get("description"), "BASIC QUALIFICATIONS", j.get("basic_qualifications"),
                     "PREFERRED QUALIFICATIONS", j.get("preferred_qualifications"))))
            for offset in range(0, 1000, 100) for j in get_json(url + str(offset))["jobs"]]  # newest 1,000: about 2 weeks


ADZUNA_COUNTRIES = {"us": ("United States", "USD"), "ca": ("Canada", "CAD")}
ADZUNA_ASKS = {"contract": "contract_type", "part_time": "contract_time"}  # the filter asked for -> the ad's field it sets


def adzuna_keys():
    """{app_id, app_key} from the environment, or None while either is missing: the scan then skips Adzuna."""
    keys = {k: os.environ.get(f"ADZUNA_{k.upper()}", "").strip() for k in ("app_id", "app_key")}
    return keys if all(keys.values()) else None


def adzuna_url(keys, country, page, ask, per_page, max_days):
    """One search. Every parameter is here, so one real call can confirm them: the docs only show some."""
    return f"https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?" + urlencode(
        dict(keys, results_per_page=per_page, max_days_old=max_days, sort_by="date", **{ask: 1}))


def adzuna_place(loc, country):
    """Its place with the country spelled out, as ", CA" in a US address is California. A US town named like a Canadian
    place (Ontario, California) would read as both countries, so then its state or province stands in."""
    place = join(loc.get("display_name"), country)
    return place if len(set(where(place)) - {"Remote"}) == 1 else join(*(loc.get("area") or [])[1:2], country)


def adzuna_job(j, country, cur, ask):
    """The ad's own contract_type and contract_time set its type, read as job_type() reads any field: a part-time contract
    is Contract, a permanent full-time ad Full-time whatever the search asked. The filter that found it fills only its own
    field, when the ad leaves that blank. Pay is read from numbers only, so one odd ad can't sink the source."""
    said = {ADZUNA_ASKS[ask]: ask} | {k: j[k] for k in ADZUNA_ASKS.values() if j.get(k)}
    pay = sorted(v for v in (j.get("salary_min"), j.get("salary_max")) if isinstance(v, (int, float)) and v > 0)
    stated = pay and str(j.get("salary_is_predicted")) == "0"  # Adzuna estimates pay for many ads; only stated pay is kept
    return dict(title=j["title"], company=(j.get("company") or {}).get("display_name") or "", url=j["redirect_url"],
                posted=j.get("created"), description=j.get("description", ""), dept=(j.get("category") or {}).get("label"),
                location=adzuna_place(j.get("location") or {}, country), type=" ".join(said.values()),
                salary=structured_pay(pay[0], pay[-1], cur, "hour" if pay[-1] <= 400 else "year") if stated else None)


def adzuna(pages, per_page, max_days):
    """Contract and part-time jobs in every field, US and Canada, newest first: up to pages × 4 calls. A short page is the
    last. The key goes only into the request URL, and a failed call reads as its HTTP code (fetch_jobs.describe)."""
    keys, jobs = adzuna_keys(), {}
    for country, (name, cur) in ADZUNA_COUNTRIES.items():
        for ask in ADZUNA_ASKS:
            for page in range(1, pages + 1):
                results = get_json(adzuna_url(keys, country, page, ask, per_page, max_days))["results"]
                for j in results:
                    jobs.setdefault(j["id"], adzuna_job(j, name, cur, ask))  # an ad both asks find: the first stays
                if len(results) < per_page:
                    break
    return list(jobs.values())


FEEDS = {"remotive": ("Remotive", remotive, "https://remotive.com"),
         "remoteok": ("RemoteOK", remoteok, "https://remoteok.com"),
         "jobicy": ("Jobicy", jobicy, "https://jobicy.com"),
         "himalayas": ("Himalayas", himalayas, "https://himalayas.app/jobs"),
         "weworkremotely": ("We Work Remotely", weworkremotely, "https://weworkremotely.com"),
         "workingnomads": ("Working Nomads", workingnomads, "https://www.workingnomads.com"),
         "themuse": ("The Muse", themuse, "https://www.themuse.com/search"),
         "hackernews": ("HN Who's Hiring", hackernews, "https://news.ycombinator.com/submitted?id=whoishiring"),
         "amazon": ("Amazon Jobs", amazon, "https://www.amazon.jobs"),
         "adzuna": ("Adzuna", adzuna, "https://www.adzuna.com")}
