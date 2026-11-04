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
# Job type: an explicit field or the title is trusted; the body only counts when it says so plainly. Per diem and PRN
# shifts are part-time; a Contracts Manager is a role, not a contract job.
TYPE_FIELD = [("Internship", r"\b(?:intern(?:ship)?s?|co-?op)\b"),
              ("Contract", r"(?<![a-z])contract(?:or)?(?![a-z])(?! (?:manager|management|specialist|administrator|analyst"
                           r"|counsel|coordinator))|freelance|temporary|\btemp\b|fixed[-_ ]?term|short[-_ ]?term|seasonal"),
              ("Part-time", r"part[-_ ]?time|per[-_ ]?diem|\bprn\b"),
              ("Full-time", r"full[-_ ]?time|permanent|regular")]
TYPE_BODY = [("Contract", r"\b(contract|contractor|freelance) (role|position|opportunity|basis|engagement|assignment)\b"
                          r"|\bcontract[- ]to[- ]hire\b|\b(1099|c2c|corp[- ]to[- ]corp)\b|\b\d+[- ]month contract\b"),
             ("Part-time", r"\bpart[- ]time (role|position|basis|opportunity|job)\b|\bthis is a part[- ]time\b"),
             ("Full-time", r"\bfull[- ]time\b")]
# Seniority and role family come from the title; a title like "Software Engineer" falls back to its skills. Every pattern
# below is exported to the browser, so it must compile the same in JavaScript (flag i): no inline flags, and each
# lookbehind of fixed width.
# Seniority is one ladder with two tracks. LEVELS is in precedence order (first match wins), LADDER in rank order.
# "Manager" after one of these nouns is an individual contributor: Product Manager, Customer Success Manager.
IC_MANAGER = ("product", "program", "programs", "project", "account", "accounts", "success", "marketing", "partner",
              "partnerships", "community", "territory", "relationship", "portfolio", "case", "channel", "alliance",
              "alliances", "category", "content", "media", "campaign", "release", "brand", "lifecycle", "growth",
              "solutions", "implementation", "engagement", "onboarding", "escalation", "enablement", "communications",
              "events", "merchant", "client", "launch", "integration", "vendor", "contract", "contracts", "office",
              "development", "experience", "delivery", "retention", "pricing", "deal", "proposal", "demand", "affiliate",
              "influencer", "creator", "acquisition", "ecosystem", "advocacy", "loyalty", "insights", "studio", "safety",
              "escalations", "incident", "outcomes", "policy", "privacy", "campaigns", "projects")
NOT_IC = "".join(f"(?<!{w} )" for w in IC_MANAGER)
C_GUARD = r"^(?!.*\b(?:chief of staff|to the|office of|business partner|assistant|deputy|field|advisory)\b)"
LEVELS = [
    ("C-level", C_GUARD + r".*?(?:\bchief\b.*\bofficer\b|\b(?:ceo|cto|cfo|coo|cmo|cio|ciso)\b"
                          r"|(?<!vice )(?<!vice-)\bpresident\b|\bco-?founder\b)"),
    ("VP", r"(?<!assistant )(?<!associate )\bvice[- ]president\b|\b[se]?vp\b|\bmanaging director\b"
           r"|(?<!assistant )(?<!associate )(?<!deputy )\bgeneral counsel\b"),
    ("Senior Director", r"\b(?:senior|sr\.?|executive|group)\s+director\b"),
    ("Director", r"\bdirector\b|\bhead\s+of\b|\bgeneral counsel\b|\bchief of staff\b|\bassociate vice[- ]president\b"),
    ("Senior Manager", r"\b(?:senior|sr\.?)\s+(?:[\w&]+\s+){0,2}" + NOT_IC + r"manager\b|" + NOT_IC + r"\bmanager\s+(?:ii|iii|2|3)\b"
                       r"|^manager\s+(?:ii|iii|2|3)\b|\bassistant vice[- ]president\b|\bavp\b"),
    ("Manager", NOT_IC + r"\bmanager\b|^manager\b|\bsupervisor\b"),
    ("Staff+", r"(?<!technical )\bstaff\b(?!\s+(?:accountant|auditor|attorney|nurse|writer|pharmacist|physician|to\b))"
               r"|\b(?:principal|distinguished|fellow)\b|\bgroup (?:product|program) manager\b"
               r"|\b(?:software|enterprise|chief|data|cloud|security|systems|platform|technical)\s+architect\b"),
    ("Senior", r"\b(?:senior|sr\.?|lead|iii|iv)\b"),
    ("Intern", r"\b(?:interns?|internships?|co-?op|summer student)\b"),
    ("Junior", r"\b(?:junior|jr\.?|entry|associate|i|new grad|university grad|graduate|early career|emerging talent"
               r"|apprentice|apprenticeship|trainee)\b"),
]
LADDER = ["Intern", "Junior", "Mid", "Senior", "Staff+", "Manager", "Senior Manager", "Director", "Senior Director", "VP",
          "C-level"]
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
# Role family: ROLES is read on each segment of the title (split at commas, dashes and brackets), then on the board's
# department. The first segment that names a role decides. The technical roles outside software engineering come
# first, so they win over "engineer" in the title; "Engineering" hands the whole title to FAMILIES and the skills.
ROLES = [
    ("Solutions & presales", r"\b(?:sales|solutions?|pre-?sales|customer|value|partner|field)\s+(?:engineer\w*"
                             r"|architect|consultant)|\bpre-?sales\b|\bsolutions?\s+(?:specialist|lead|director|manager|analyst)\b"
                             r"|\bprofessional services\b|\bimplementation\b|\bfield cto\b|\bai architect\b", "Sales"),
    ("Sales", r"\b(?:account|sales) exec\w*|\bsales (?:representative|director|manager|lead|specialist|development)"
              r"|\b(?:sdr|bdr|ae)\b|\b(?:business|account) development representative\b", "Sales"),
    ("IT", r"\bit\b|\binformation technology\b|\bhelp ?desk\b|\bservice desk\b|\bdesktop support\b|\bsysadmin\b"
           r"|\bsystems? administrator\b|\bnetwork administrator\b|\bend[- ]user\b|\bdata center technician\b", "IT & security"),
    ("Support", r"\bsupport\b|\bcustomer (?:service|care|operations)\b|\bmember (?:services|support)\b|\bescalations?\b",
     "Customer"),
    ("Developer relations", r"\bdeveloper (?:relations|advocate|advocacy|evangelist)|\bdevrel\b|\btechnical marketing engineer",
     "Marketing"),
    ("Hardware", r"\b(?:hardware|electrical|mechanical|asic|fpga|silicon|pcb|rf|analog|mixed[- ]signal|optical|photonics"
                 r"|thermal|power|manufacturing|controls?|process|chemical|civil|structural|facilities|commissioning)\s+"
                 r"engineer|\bdesign verification\b|\bphysical design\b|\btechnician\b", "Engineering"),
    ("Engineering", r"engineer\w*|developer|programmer|\bswe\b|\bsde\b|\bsre\b|devops|architect|technical staff|\bmts\b"
                    r"|\bcto\b", "Engineering"),
    ("Data science", r"\bdata scien\w*|\bquantitative\b|\bstatistic\w*|\beconomist\b|\bdecision scien\w*", "Data & research"),
    ("Research", r"\bresearch scientist|\bapplied scientist\b|\bresearcher\b|\bscientist\b|\bpostdoc", "Data & research"),
    ("Analytics", r"\b(?:data|business|product|marketing|sales|people|operations|revenue|bi|insights?|reporting|growth)\s+"
                  r"(?:analyst|analytics|intelligence)\b|\banalytics\b|\bbusiness intelligence\b|\bbi\b", "Data & research"),
    ("Cybersecurity", r"security|\bgrc\b|\bsoc\b|cyber|infosec|\bthreat|vulnerab|penetration|\bred team|\bdetection",
     "IT & security"),
    ("Clinical", r"\b(?:physician|nurse|nursing|rn|np|pa-c|lcsw|lpc|md|do|psychiatr\w*|psycholog\w*|therapist|therapy"
                 r"|clinician|clinical|counselor|phlebotomist|pharmac\w*|dentist|dental|medical|dietitian|midwife|doula"
                 r"|care (?:coordinator|navigator|manager|partner)|health coach|behavioral health|mental health"
                 r"|psychotherapist|optometrist|radiolog\w*|sonographer|paramedic|emt)\b", "Healthcare"),
    ("Product management", r"\bproduct (?:manager|management|owner|lead|leader|director)\b|\b(?:head|director|vp|vice president)"
                           r",? (?:of )?product\b|\bapm\b|\bgpm\b|^product$", "Product"),
    ("Program management", r"\b(?:program|project|programme|delivery|release)\s+(?:manager|management|lead|director|coordinator)\b"
                           r"|\btpm\b|\bpmo\b|\bscrum master\b|\bproject\b", "Product"),
    ("Design", r"\bdesign(?:er|ers)?\b|\bux\b|\bui\b|user experience|user research"
               r"|\billustrat|\bcreative\b|\bartist\b|\banimat|\bart director\b|\bvfx\b|\bmotion\b|\bart\b", "Design"),
    ("Sales", r"\baccount (?:director|manager)\b|\bsales\b|\bbusiness development\b|\bterritory\b|\bclient partner\b"
              r"|\baccount partner\b|\bcommercial (?:lead|director)\b|\bpartner (?:manager|development|account)"
              r"|\bpartnerships?\b|\balliances?\b|\bchannel\b|\bagent\b|\bseller\b|\bgtm\b", "Sales"),
    ("Customer success", r"\b(?:customer|client) success\b|\bcsm\b|\btechnical account manager\b|\btam\b|\baccount management\b"
                         r"|\bcustomer (?:engagement|onboarding|advocate|experience)\b|\bonboarding\b|\brenewals?\b|\bcx\b"
                         r"|\bclient services\b", "Customer"),
    ("Marketing", r"marketing|\bgrowth\b|\bbrand\b|\bdemand gen|\bseo\b|\bsem\b|\bsocial media\b|\bevents?\b|\bcommunity\b"
                  r"|\badvocate\b|\bcampaigns?\b|\blifecycle\b|\bcopywrit|\binfluencer\b|\bpaid (?:social|search|media)\b"
                  r"|\banalyst relations\b", "Marketing"),
    ("Communications", r"communications?\b|\bpublic relations\b|\bpr\b|\bcontent\b|\bwriter\b|\beditor\b|\beditorial\b"
                       r"|\bjournalist\b|\bspeechwriter\b|\blocali[sz]ation\b|\btranslator\b|\bvideo\b|\bproducer\b"
                       r"|\bmoderator\b|\bgovernment affairs\b|\bpublic policy\b", "Marketing"),
    ("Recruiting", r"recruit\w*|\btalent acquisition\b|\bsourcer\b|\bsourcing (?:lead|partner|specialist)\b|\bta partner\b",
     "People"),
    ("People & HR", r"\bpeople\b|\bhuman resources\b|\bhr\b|\bhrbp\b|\bcompensation\b|\bbenefits\b|\btotal rewards\b"
                    r"|\blearning (?:and|&) development\b|\bl&d\b|\btalent (?:management|development)\b|\bemployee\b"
                    r"|\bpayroll\b|\bdei\b|\bdiversity\b|\bworkforce\b|\borganizational\b", "People"),
    ("Accounting", r"accountant|accounting|\bcontroller\b|\bcomptroller\b|\btax\b|\baccounts (?:payable|receivable)\b"
                   r"|\bbookkeep|\baudit\w*|\bsox\b|\brevenue (?:recognition|accountant)\b|\bbilling\b|\bcollections?\b",
     "Finance"),
    ("Finance", r"financ\w*|\bfp&a\b|\btreasury\b|\binvestor relations\b|\bcorporate development\b|\bcorp dev\b|\bm&a\b"
                r"|\bactuar\w*|\bunderwrit\w*|\bcredit\b|\binvestment\w*|\bcapital markets\b|\bprocurement\b"
                r"|\bpricing\b|\bbanker\b|\btrader\b|\btrading\b|\bportfolio\b", "Finance"),
    ("Legal", r"\blegal\b|\bcounsel\b|\battorney\b|\blawyer\b|\bparalegal\b|\bcontracts? (?:manager|specialist|administrator)"
              r"|\bprivacy\b|\bintellectual property\b|\bpatent\b|\blitigation\b", "Legal & compliance"),
    ("Risk & compliance", r"\bcompliance\b|\brisk\b|\baml\b|\bkyc\b|\bbsa\b|\bfraud\b|\bregulatory\b|\bfinancial crimes\b"
                          r"|\bsanctions\b|\bgovernance\b|\bpolicy\b|\bcustoms\b|\btrade (?:compliance|advisory)\b",
     "Legal & compliance"),
    ("Trust & safety", r"\btrust (?:and|&) safety\b|\bcontent moderat\w*|\bintegrity\b|\bsafety\b|\bannotat\w*", "Operations"),
    ("Revenue operations", r"\b(?:revenue|sales|gtm|go-to-market|marketing|commercial)\s+(?:operations|ops|strategy|systems)\b"
                           r"|\brevops\b|\bdeal desk\b|\benablement\b|\bsales strategy\b|\bproposal\b|\bbid\b", "Operations"),
    ("Supply chain", r"supply chain|\blogistics\b|\bsourcing\b|\bpurchasing\b|\bbuyer\b|\bmerchandis\w*|\bfulfillment\b"
                     r"|\bwarehouse\b|\binventory\b|\bdemand planning\b|\bplanner\b|\bvendor\b|\bfleet\b|\bdriver\b"
                     r"|\breceiving\b|\bshipping\b|\bcapacity\b", "Operations"),
    ("Administrative", r"\b(?:executive|administrative|admin|office|personal)\s+(?:assistant|coordinator|manager|business partner)\b"
                       r"|\breceptionist\b|\bexecutive business partner\b|\badministrat\w*|\bconcierge\b", "Operations"),
    ("Facilities & workplace", r"\bfacilit\w*|\bworkplace\b|\breal estate\b|\bconstruction\b|\bsite (?:manager|lead|operations)\b"
                               r"|\bhvac\b|\bmaintenance\b|\bsecurity officer\b|\bcritical (?:facility|environment)"
                               r"|\bforeman\b|\bpipefitter\b|\belectrician\b|\bdata center\b|\benergy\b", "Operations"),
    ("Education", r"\bteacher\b|\btutor\b|\binstructor\b|\bcurriculum\b|\binstructional\b|\beducat\w*|\btrainer\b|\bcoach\b"
                  r"|\bfaculty\b|\blearning (?:designer|experience)\b", "Education"),
    ("Business operations", r"\boperations?\b|\bops\b|\bstrategy\b|\bstrategist\b|\bstrategic\b|\bbusiness (?:analyst|partner)\b"
                            r"|\bchief of staff\b|\bconsultant\b|\btransformation\b|\bplanning\b|\bgeneral manager\b"
                            r"|\bprograms?\b|\bengagement\b|\bexpert\b", "Operations"),
]
SEGMENT = r"\s*(?:,|\(|\)|\[|\]|\||:|;|\s[-–—]\s|–|—)\s*"
FIELDS = ({name: "Engineering" for name, _ in FAMILIES} | {"General": "Engineering"}
          | {name: field for name, _, field in ROLES} | {"Other": "Other"})
LV, RL, FM = ([(n, re.compile(rx, re.I)) for n, rx, *_ in table] for table in (LEVELS, ROLES, FAMILIES))
SPLIT = re.compile(SEGMENT)
ROLE = re.compile("|".join(f"(?:{rx})" for _, rx, _ in ROLES), re.I)  # a part of a title that names any role
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


def segments(title):
    return [s for s in SPLIT.split(title) if s]


def first(table, text):
    return next((name for name, rx in table if rx.search(text)), None)


def level(title):
    """The first segment decides ("Director, Product Marketing"), else the whole title."""
    return first(LV, (segments(title) or [title])[0]) or first(LV, title) or "Mid"


def family(title, found, dept=""):
    """The first title segment that names a role decides, else the board's department, else "Other"."""
    for text in segments(title) + ([dept] if dept else []):
        name = first(RL, text)
        if name == "Engineering":
            return first(FM, title) or engineering_by_skills(found)
        if name:
            return name
    return "Other"


def engineering_by_skills(found):
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
    body, company = rich_text(val("description")), job["company"].strip()
    sec, found = split_sections(body), skills(r["kw"], f"{title}\n{body}", r["needles"])
    found = {k for k in found if not r["kw"][k].search(company)}  # Datadog's postings name Datadog; it isn't a skill asked for
    names = [k for k in r["kw"] if k in found]
    must, nice = tier_skills(names, title, sec, r["kw"])
    return dict(title=title, company=company, where=tags, location=location[:120],
                url=job["url"], posted=posted.isoformat() if posted else None, source=job["source"],
                type=job_type(val("type"), title, body), level=level(title), role=family(title, found, job.get("dept") or ""),
                applicants=job.get("applicants"),  # no public board API exposes this; dashboard shows "Not available"
                skills=names, must=must, nice=nice, years_required=years_min(sec),
                salary=job.get("salary") or salary(body, tags), mode=work_mode(job.get("mode"), title, location, body),
                degree=degree(sec), posted_approx=bool(job.get("posted_approx")))
