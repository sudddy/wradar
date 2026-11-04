"""The rules one raw job goes through, cheapest first: title, age, location, then the description and its tags.

Rules only, no AI at runtime. Standard library only. The level and family rules are also exported to the browser.
"""
import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from extract import degree, rich_text, salary, split_sections, tier_skills, work_mode, years_min

ROOT = Path(__file__).parent

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
# The only letters re.I matches to an ASCII letter that lower() doesn't turn into it. With them folded, a plain alias the
# regex matches is always in the lowered text, at the same place: every character lowers to exactly one.
FOLD = str.maketrans({"İ": "i", "ı": "i", "ſ": "s"})
WORD, CASED_WORD = re.compile(r"[a-z0-9]+"), re.compile(r"[A-Za-z0-9]+")  # as the aliases' lookarounds split words


def pattern(alias):
    if alias.startswith("re:"):
        return alias[3:]
    p = r"(?<![A-Za-z0-9])" + re.escape(alias.lstrip("=")) + r"(?![A-Za-z0-9+#])"
    return p if alias.startswith("=") else f"(?i:{p})"


def compile_keywords(d):
    return {name: re.compile("|".join(map(pattern, aliases))) for name, aliases in d.items() if not name.startswith("_")}


def needles(d):
    """Skill -> (keys, [(key, plain alias lowercased)], regex of its other aliases or None), for skills(). A plain alias's
    key is its longest run of letters and digits, which is a whole word of any text the alias matches."""
    out = {}
    for name, aliases in d.items():
        if not name.startswith("_"):
            plain = [a for a in aliases if not a.startswith("re:") and a.isascii() and WORD.search(a.lower())]
            rest = [a for a in aliases if a not in plain]
            pairs = [(max(WORD.findall(a), key=len), a) for a in (p.lstrip("=").lower() for p in plain)]
            out[name] = frozenset(k for k, _ in pairs), pairs, re.compile("|".join(map(pattern, rest))) if rest else None
    return out


def matches_at(rx, s, low, plain):
    """True when rx matches s where one of the plain aliases appears in low: those are the only places one can match."""
    for a in plain:
        i = low.find(a)
        while i >= 0:
            if rx.match(s, i):  # lookbehinds still see the text before i
                return True
            i = low.find(a, i + 1)
    return False


def skills(kw, s, needles=None):
    """Skills named in s. With needles, a skill's regex runs only where a plain alias whose key is a word of s appears,
    and its re: aliases search the whole text: the same result as searching everything, many times faster."""
    if not needles:
        return {name for name, rx in kw.items() if rx.search(s)}
    low = s.translate(FOLD).lower()
    words = set(WORD.findall(low)) | {w.lower() for w in CASED_WORD.findall(s)}  # case-blind aliases, then =Cased ones
    found = set()
    for name, rx in kw.items():
        keys, pairs, rest = needles[name]
        if (rest and rest.search(s)) or (not keys.isdisjoint(words)
                                         and matches_at(rx, s, low, [a for k, a in pairs if k in words])):
            found.add(name)
    return found


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
    return dict(cfg=cfg, keywords=keywords, kw=compile_keywords(keywords), needles=needles(keywords),
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
    sec, found = split_sections(body), skills(r["kw"], f"{title}\n{body}", r["needles"])
    names = [k for k in r["kw"] if k in found]
    must, nice = tier_skills(names, title, sec, r["kw"])
    return dict(title=title, company=job["company"].strip(), where=tags, location=location[:120],
                url=job["url"], posted=posted.isoformat() if posted else None, source=job["source"],
                type=job_type(val("type"), title, body), level=level(title), role=family(title, found),
                applicants=job.get("applicants"),  # no public board API exposes this; dashboard shows "Not available"
                skills=names, must=must, nice=nice, years_required=years_min(sec),
                salary=job.get("salary") or salary(body, tags), mode=work_mode(job.get("mode"), title, location, body),
                degree=degree(sec), posted_approx=bool(job.get("posted_approx")))
