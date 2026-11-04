"""Read the structure of a job posting: sections, required skills, years, pay, work mode, degree.

Rules only, no AI at runtime. Standard library only. rules.evaluate() calls these once per job.
"""
import html
import re

BLOCK = re.compile(r"</?(?:p|div|ul|ol|li|h[1-6]|tr|table|section|article|blockquote|hr)\b[^>]*>|<br\s*/?>", re.I)


def rich_text(s):
    """HTML or plain text -> text with one block per line. Same content as sources.text(), keeps structure."""
    s = BLOCK.sub("\n", html.unescape(s or ""))
    s = html.unescape(re.sub(r"<[^>]+>", " ", s)).replace("’", "'")
    s = re.sub(r"\s[•·▪●◦‣∙]\s", "\n", s)
    return "\n".join(t for t in (" ".join(l.split()) for l in s.split("\n")) if t)


def norm(line):
    return " ".join(re.sub(r"[^a-z0-9'+ ]+", " ", line.lower().replace("&", " and ")).split())


NICE_H = re.compile(
    r"(?:(?:what|things|skills|qualifications|experience|requirements|that|this|also|additional|other|some|the|an|a"
    r"|but|and)\s+)*"
    r"(?:nice[- ]?to[- ]?haves?|nice to have skills|nice if|preferred|desired|desirable|bonus (?:points?|skills?|if|for)"
    r"|bonus qualifications|bonus(?:es)?$|optional|even better|extra credit|good to have|great to have|plus(?:es)?|big plus"
    r"|(?:it's|it is|it'd be|it would be|would be) (?:a )?(?:great|nice|plus|awesome|bonus)|ways to stand out"
    r"|what (?:will|would|could|can|might) (?:make|set|help) you|what sets you apart|stand out|strong candidates may"
    r"|an? ideal candidate also|ideally|we'd (?:love|like) (?:to see|it if)|you (?:might|may) also have"
    r"|qualifications we want)\b.{0,60}")
MUST_H = re.compile(
    r"(?:(?:minimum|basic|required|essential|key|core|technical|general|additional|must[- ]have|job|role|position|your"
    r"|our|the|skills?|and|preferred and)\s+)*(?:qualifications?|requirements?)\b.{0,50}"
    r"|required(?: skills| experience| qualifications)?\b.{0,40}|must[- ]haves?\b.{0,40}|essentials?|skills?"
    r"|(?:skills|experience|background|expertise|education)(?: and (?:skills|experience|qualifications|education"
    r"|knowledge|requirements|training|core capabilities))?(?: required| we're seeking)?"
    r"|(?:here's )?what (?:we're|we are|we|you'll|you will|you|you should|you must|do you|makes you|it takes)"
    r"(?: to)?(?: be)? (?:look\w*|need\w*|bring\w*|have|require\w*|expect\w*|a great fit|successful|should have)\b.{0,45}"
    r"|what qualifications.{0,30}|some of the things we look for|you'll (?:enjoy|be successful)\b.{0,40}"
    r"|we'd love to chat if.{0,20}|candidate profile"
    r"|who (?:you are|we're looking for|we are looking for|you might be|you'll be)\b.{0,40}|about you"
    r"|you(?: are| have| bring| should have| must have| might| may| will need| need| possess|'ll need|'ll bring"
    r"|'ll thrive| should apply|'re a good fit|'re excited| will thrive)\b.{0,50}"
    r"|your (?:expertise|background|experience|toolkit|skills|profile|qualifications)\b.{0,40}"
    r"|we're excited about you\b.{0,30}|we're looking for|we are looking for|we'd love to hear from you if.{0,30}"
    r"|to (?:thrive|succeed|be successful)\b.{0,40}|how to be successful.{0,30}|(?:the |our )?ideal candidate\b.{0,30}"
    r"|an ideal candidate.{0,20}|skills we're looking for")
OTHER_H = re.compile(
    r"(?:about|why|our|benefits?|perks?|compensation|pay|salary|equal|locations?|where|how|the (?:role|team|opportunity"
    r"|impact|work|position|job|difference)|in this role|responsibilit\w+|key responsibilit\w+|what (?:you'll|you will)"
    r" (?:do|be doing|be working|work|own|achieve|accomplish|learn|make|be responsible)|what we (?:do|offer|provide)"
    r"|what's next|you will|you'll|your (?:impact|role|day|responsibilit\w+|mission|work|location)|a typical day"
    r"|disclosures?|privacy|accommodations?|compliance|come |join |apply|next steps|interview\w*|working at|life at"
    r"|culture|overview|summary|mission|we offer|we provide|tech stack|technologies|stack|notes?|important|additional"
    r" (?:information|details|job details)|travel|time off|hiring|fraud|eeo|in office|relocation|flexible|"
    r"what you will (?:do|be)|what you'll|role (?:overview|summary|description)|job (?:summary|description)"
    r"|position summary|team|mission|values|who we are|what makes)\b.{0,60}")
END = re.compile(r"equal (?:opportunity|employment)|e-verify|reasonable accommodation|benefits include|we offer"
                 r"|(?:don't|do not) meet every|even if you don't|have access to"
                 r"|salary range|base salary|pay range|compensation range|base pay|protected veteran", re.I)
SOFT = re.compile(r"\b(nice[- ]to[- ]have|bonus|an? (?:big |huge |major |strong |added )?plus|pluses|preferred|preferably"
                  r"|ideally|(?:a )?great advantage"
                  r"|desirable|desired|would be (?:great|nice|helpful|ideal|an advantage)|not required|not a must|optional"
                  r"|helpful|advantageous|an advantage|is great|is nice)\b", re.I)
CLAUSE = re.compile(r"(?<=[.;])\s+(?=[A-Z])|,\s+(?=(?:and\s+)?(?:ideally|preferably|preferred|bonus|nice to have)\b)", re.I)


def heading(line):
    """-> (kind, rest): kind is must / nice / other / None; rest is any content after 'Heading: '."""
    head, rest = line, ""
    m = re.match(r"(.{3,60}?)\s*[:–—]\s+(.+)", line)
    if m and len(m.group(1).split()) <= 7:
        head, rest = m.groups()
    if len(head) > 90 or (head.endswith(".") and len(head.split()) > 4):
        return None, ""
    n = norm(head)
    if not n or len(n.split()) > 13:
        return None, ""
    if n == "what we need" or n.startswith("you're excited about this opportunity"):  # Tenstorrent, DoorDash: duties
        return "other", rest
    if head.endswith(":") and len(n.split()) <= 12 and SOFT.search(head):  # "Not a must but a great advantage:"
        return "nice", rest
    for kind, rx in (("nice", NICE_H), ("must", MUST_H), ("other", OTHER_H)):
        if rx.fullmatch(n):
            return kind, rest
    labelled = len(n.split()) <= 5 or head.rstrip().endswith((":", "?"))
    if labelled and not re.match(r"\w+ing\b", n):
        tail = n + head[-1:]
        if re.search(r"\b(preferred|nice to have|bonus points?)$|\b(preferred|nice to have|bonus points?)\b.*[:?]$", tail):
            return "nice", rest
        if re.search(r"\b(requirements?|qualifications?|must haves?)$"
                     r"|\b(requirements?|qualifications?|must haves?)\b.*[:?]$", tail):
            return "must", rest
    return None, ""


def split_sections(body):
    """rich_text() output -> {"must": [...], "soft": [...], "nice": [...], "other": [...]} of clauses or lines."""
    out, cur, only_desirable = {"must": [], "soft": [], "nice": [], "other": []}, "other", False
    for line in body.split("\n"):
        kind, rest = heading(line)
        if kind == "nice" and rest:  # "Nice to have: Kubernetes" is one note, not a new section
            out["nice"].append(rest)
            continue
        only_desirable |= kind == "nice" and norm(line).startswith("desirable skills")
        if kind and (not rest or (cur == "other" and kind == "must")):
            cur = kind
        line = rest or line
        if cur != "other" and END.search(line):
            cur = "other"
        if cur == "must":
            for clause in CLAUSE.split(line):
                out["soft" if SOFT.search(clause) else "must"].append(clause)
        else:
            out[cur].append(line)
    if only_desirable and not out["must"]:  # Cloudflare's only requirements list is called "Desirable skills"
        out["must"], out["nice"] = out["nice"], []
    return out


def tier_skills(names, title, sec, kw):
    """Each skill -> must (named in title or must section), nice, or left as plain mention."""
    must_t, nice_t = "\n".join(sec["must"]), "\n".join(sec["nice"] + sec["soft"])
    must = [k for k in names if kw[k].search(title) or kw[k].search(must_t)]
    nice = [k for k in names if k not in must and kw[k].search(nice_t)]
    return must, nice


WORDS = {w: n for n, w in enumerate("one two three four five six seven eight nine ten eleven twelve".split(), 1)}
NUMBER = rf"\d{{1,2}}|\b(?:{'|'.join(WORDS)})\b"
SUFFIX = r"\s*(?:\(\d{1,2}\+?\)\s*)?\+?\s*"  # "five (5)", "5+"
AGE = r"\s+old|\s+of age\b|\s+or (?:older|over)\b"  # "at least 18 years of age" is an age, not experience
YEARS = re.compile(rf"(?<![\d.$,])({NUMBER}){SUFFIX}(?:(?:-|–|—|to)\s*(?:{NUMBER}){SUFFIX})?(?:(?:plus|or more)\s+)?"
                   rf"(?:years?|yrs?|yoe)\b(?!{AGE}|\s+ago|\s+degree)", re.I)
EXPERIENCE = re.compile(
    rf"(\d{{1,2}})\s*\+?\s*(?:(?:-|–|to)\s*\d{{1,2}}\s*\+?\s*)?years?(?!{AGE})(?:\s+of)?(?:\s+[\w/&-]+){{0,5}}?\s+experience", re.I)
NOT_YEARS = re.compile(r"\b(company|founded|for over|over the (?:last|past)|in the (?:last|past)|within|history|since"
                       r"|ago|last \d|no more than|up to|less than|fewer than)\b", re.I)


def number(s):
    return WORDS.get(s.lower()) or int(s)


def clause_years(c):
    """Years one clause asks for. Alternatives joined by "or" -> the lowest bar."""
    ms = [m for m in YEARS.finditer(c) if 0 < number(m.group(1)) <= 20
          and not NOT_YEARS.search(c[max(0, m.start() - 25):m.start()])]
    hits = [number(m.group(1)) for m in ms]
    gap = c[ms[0].end():ms[-1].start()] if ms else ""
    return min(hits) if re.search(r"\bor\b", gap.rsplit(",", 1)[-1], re.I) else max(hits, default=None)


def years_min(sec):
    """Largest bar across must clauses, then soft ones; with no must section, plain experience statements."""
    for bucket in ("must", "soft"):
        found = [y for y in map(clause_years, sec[bucket]) if y]
        if found:
            return max(found)
    if sec["must"] or sec["soft"]:
        return None
    return max((int(m.group(1)) for c in sec["other"] for m in EXPERIENCE.finditer(c) if 0 < int(m.group(1)) <= 20),
               default=None)


NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{1,2})?\s?[kK]\b|\d{2,7}(?:\.\d{1,2})?"
CUR = r"US\$|USD\s?\$?|CA\$|C\$|CAD\s?\$?|\$"
BIG = r"\s?(?:[mMbB]\b|mm\b|bn\b|million|billion|trillion)"
RANGE = re.compile(
    rf"(?P<c1>{CUR})\s?(?P<lo>{NUM})(?P<b1>{BIG})?(?:\s*(?:USD|CAD))?(?:/(?:year|yr|hour|hr))?\s*"
    rf"(?:-|–|—|[Tt][Oo]|and|through|up to)\s*(?P<c2>{CUR})?\s?(?P<hi>{NUM})(?P<b2>{BIG})?"
    rf"(?:\s*(?P<c3>USD|CAD|US|CA|Canadian)\b)?"
    rf"(?P<per>\s*(?:per|/|an?|each)\s*(?:hour|hr|year|yr|annum|annually|month|mo|session|visit|encounter|appointment)\b)?")
RANGE2 = re.compile(r"(?<![\d$,.])(?P<lo>\d{2,3},\d{3}(?:\.\d\d)?)\s*(?:-|–|—|to)\s*(?P<hi>\d{2,3},\d{3}(?:\.\d\d)?)\s*"
                    r"(?P<c3>USD|CAD)\b")
RANGE3 = re.compile(r"(?<![\d$,.])(?P<lo>\d{2,3},\d{3})\s*(?P<c1>USD|CAD)\s*(?:-|–|—|to)\s*(?P<hi>\d{2,3},\d{3})\s*"
                    r"(?P<c3>USD|CAD)\b")
SPREAD = re.compile(rf"\$(?P<lo>{NUM})(?:/year)?\s+in our lowest geographic market up to \$(?P<hi>{NUM})")
SINGLE = re.compile(rf"\b(?:salary|compensation|pay|wage|rate)\b[^.\n$]{{0,45}}?(?P<c1>{CUR})\s?(?P<lo>{NUM})(?!{BIG})"
                    rf"(?:\s*(?P<c3>USD|CAD)\b)?(?P<per>\s*(?:per|/|an?)\s*(?:hour|hr|year|yr|annum)\b)?"
                    rf"(?!\s*(?:-|–|—|to\b)\s*(?:{CUR}|\d))", re.I)
STRONG = re.compile(r"\b(?:pay|salary|compensation|hiring|wage|base|earnings) (?:range|band|grade|scale)\b[^.\n]{0,45}$"
                    r"|\bbase (?:salary|pay)\b[^.\n]{0,45}$|\bsalary\b[^.\n]{0,20}$", re.I)
BAD_CTX = re.compile(r"\b(equity|stock|rsus?|refresh|fund\w*|raised?|valuation|revenue|series [a-f]|arr|investors?|backed"
                     r"|customers?|merchants?|transactions?|process\w*|volume|gmv|assets|aum|market cap|bonus|sign[- ]on"
                     r"|signing|commission|tuition|stipends?|allowance|reimburs\w*|401|wellness|referral|deductible"
                     r"|budget|credits?|relocation|gift|lunch|meal|per month|/month|monthly|contract value|deal"
                     r"|target variable|variable compensation)\b", re.I)
AFTER_BAD = re.compile(r"\s*(?:\w+\s+)?(?:bonus|stipend|allowance|commission|in funding|in revenue|in arr|funding"
                       r"|per month)\b", re.I)
GOOD_CTX = re.compile(r"\b(salary|compensation|pay|base|ote|wage|annual\w*|range|hourly|per year|per hour|/yr|/hr)\b", re.I)
OTE = re.compile(r"\b(ote|on[- ]target|total (?:target )?(?:cash|compensation)|target earnings)\b", re.I)


def amount(s):
    s = s.replace(",", "").replace(" ", "").lower()
    return float(s[:-1]) * 1000 if s.endswith("k") else float(s)


def plausible(lo, hi, per):
    """Pay a job could really offer, in a range narrow enough to mean something."""
    return 15 <= lo <= hi <= 400 if per == "hour" else 30_000 <= lo <= hi <= 1_500_000 and hi / lo <= 4


def range_values(m):
    """Normalise one match -> (lo, hi, per) or None. '$150-200k' borrows the k."""
    lo_s, hi_s = m["lo"], m["hi"]
    lo, hi = amount(lo_s), amount(hi_s)
    if lo and hi_s.lower().endswith("k") and hi / lo > 500:
        lo *= 1000
    if lo_s.lower().endswith("k") and hi < 1000:
        hi *= 1000
    per = (m.groupdict().get("per") or "").lower()
    if "month" in per or per.endswith("mo") or re.search(r"session|visit|encounter|appointment", per):  # not a wage
        return None
    if ("hour" in per or "hr" in per) or (hi <= 500 and not per):
        return (lo, hi, "hour") if plausible(lo, hi, "hour") else None
    return (lo, hi, "year") if plausible(lo, hi, "year") else None


def home_currency(where):
    return "CAD" if "Canada" in where and "US" not in where else "USD"


def currency(m, ctx, where):
    tags = " ".join(filter(None, (m.groupdict().get(k) for k in ("c1", "c2", "c3"))))
    if re.search(r"CA\$|C\$|CAD|\bCA\b|Canadian", tags):
        return "CAD"
    if re.search(r"US\$|USD|\bUS\b", tags):
        return "USD"
    return "CAD" if re.search(r"canad|\bCAD\b", ctx, re.I) else home_currency(where)


def salary(body, where):
    """Body text -> {"min", "max", "cur", "per"} or None. Ranges for several regions or levels are merged."""
    hits = []
    for rx in (RANGE, RANGE2, RANGE3, SPREAD, SINGLE):
        if rx is SINGLE and hits:
            break
        for m in rx.finditer(body):
            if m.groupdict().get("b1") or m.groupdict().get("b2"):
                continue
            start = body.rfind("\n", 0, m.start()) + 1
            if not body[start:m.start()].strip():  # a label on the line above: "Target Variable\n$46,000 — $72,800"
                start = body.rfind("\n", 0, max(start - 1, 0)) + 1
            before = re.split(r"[.!?]\s", body[max(start, m.start() - 90):m.start()])[-1]
            after = body[m.end():m.end() + 60].split("\n")[0]
            bad = BAD_CTX.search(re.sub(r"\([^()]*\)", "", before))  # "(this does not include bonus)" is not a label
            if not STRONG.search(before) and (bad or AFTER_BAD.match(after)):
                continue
            if rx is SINGLE:
                lo = amount(m["lo"])
                per = (m["per"] or "").lower()
                v = (lo, lo, "hour") if ("hour" in per or "hr" in per) and plausible(lo, lo, "hour") else \
                    (lo, lo, "year") if plausible(lo, lo, "year") else None
            else:
                v = range_values(m)
                if v and v[2] == "hour" and not (m.groupdict().get("per") or GOOD_CTX.search(before + after)):
                    v = None
            if v:
                hits.append((*v, currency(m, before + after, where), bool(OTE.search(before + after))))
    base = [h for h in hits if not h[4]] or hits
    return pick_pay([dict(min=round(lo), max=round(hi), cur=cur, per=per) for lo, hi, per, cur, _ in base], where)


def pick_pay(pays, where):
    """Ranges for several regions or levels -> one in the row's home currency, merged. None if there are none."""
    use = [p for p in pays if p["cur"] == home_currency(where)] or pays
    use = [p for p in use if (p["cur"], p["per"]) == (use[0]["cur"], use[0]["per"])]
    return dict(use[0], min=min(p["min"] for p in use), max=max(p["max"] for p in use)) if use else None


def structured_pay(lo, hi, cur, interval):
    """A board's own pay field -> the salary() shape, or None if unusable. Intervals: "1 YEAR", "per-year-salary"."""
    per = next((p for p in ("year", "hour") if p in str(interval).lower()), None)
    return dict(min=round(lo), max=round(hi), cur=cur, per=per) if per and lo and hi and plausible(lo, hi, per) else None


LI_TAG = re.compile(r"#?\bLI[- ](Remote|Hybrid|On-?site)\b", re.I)
HYBRID = re.compile(
    r"\bon-?site (?:monday|tuesday|wednesday|thursday)\b|\bin[- ]person time and remote\b"
    r"|\bhybrid (?:role|position|work\w*|schedule|policy|setup|arrangement|opportunity|job|culture"
    r"|model(?: of work| where| with|,|\.| and)|environment|team|office)\b"
    r"|\b(?:is|be|are|a|on a|in a|works?) hybrid\b"
    r"(?! (?:cloud|search|ai|data|infra\w*|architecture|approach|system|solution|retrieval))"
    r"|\b(?:[1-4]|two|three|four|one)(?:\s*(?:[-–]|to)\s*(?:\d|five))?\s*(?:\+\s*)?(?:days?|x)\b[^.\n]{0,40}"
    r"\b(?:office|on-?site|in[- ]person)\b"
    r"|\b(?:office|on-?site|in[- ]person)\b[^.\n]{0,40}\b(?:[1-4]|two|three|four)(?:\s*(?:[-–]|to)\s*(?:\d|five))?"
    r"\s*(?:\+\s*)?days?\b"
    r"(?! (?:a|per) (?:month|quarter|year))", re.I)
ONSITE = re.compile(
    r"\b(?:role|position|job|work) is (?:based )?(?:fully |primarily |100% )?(?:on-?site|in[- ]office|in[- ]person)\b"
    r"|\b(?:fully|100%|entirely)\b[^.\n]{0,20}\b(?:on-?site|in[- ]office|in[- ]person|in the office)\b"
    r"|\b(?:5|five)\s*(?:days?|x)\b[^.\n]{0,40}\b(?:office|on-?site|in[- ]person)\b"
    r"|\b(?:office|on-?site|in[- ]person)\b[^.\n]{0,40}\b(?:5|five)\s*days?\b(?! (?:a|per) (?:month|quarter|year))"
    r"|\b(?:on-?site|in[- ]office|in[- ]person) (?:role|position|job|work\b|presence)"
    r"|\b(?:must|required|need|expected|able) to (?:be |work |come )?(?:on-?site|in[- ]office|in[- ]person"
    r"|in (?:the|our) office)\b"
    r"|\b(?:not|isn't|non)[- ](?:a )?remote\b|\bno remote\b|\bwork(?:ing)? (?:on-?site|from (?:our|the) office"
    r"|in (?:our|the) office)\b", re.I)
REMOTE_B = re.compile(
    r"\b(?:fully|100%|completely|entirely|permanently) remote\b|\bremote[- ]first\b|\bremote[- ]only\b"
    r"|\b(?:role|position|job|work) (?:is|can be) (?:fully |100% )?remote\b|\bremote (?:role|position|opportunity|job|work"
    r"|employee)\b|\bwork(?:ing)? (?:from )?(?:anywhere|remotely)\b", re.I)
FIELD_MODE = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "On-site", "on-site": "On-site"}


def work_mode(field, title, location, body):
    """Structured field, then title and location, then plain statements in the body. None means not stated."""
    v = FIELD_MODE.get(str(field or "").lower())
    if v:
        return v
    weak = "flexible / remote" in location.lower()  # The Muse's catch-all label, often on hybrid roles
    head = f"{title} | {location}".lower().replace("flexible / remote", "")
    if re.search(r"\bhybrid\b", head, re.I):
        return "Hybrid"
    if re.search(r"\bon-?site\b|\bin[- ]office\b", head, re.I):
        return "On-site"
    if re.search(r"\bremote\b", head, re.I):
        return "Remote"
    tag = LI_TAG.search(body)
    if tag:
        return FIELD_MODE[tag.group(1).lower()]
    if HYBRID.search(body):
        return "Hybrid"
    if ONSITE.search(body):
        return "On-site"
    if REMOTE_B.search(body) or weak:
        return "Remote"
    return None


DEGREE = [("associate", r"(?i:\bassociate'?s?'? (?:degree|of (?:arts|science|applied science))\b|\bassociate's\b)"
                        r"|\bA\.?A\.?S\b"),
          ("bachelor", r"(?i:\bbachelor'?s?\b|\bundergraduate degree\b|\b(?:4|four)[- ]year degree\b|\bcollege degree\b"
                       r"|\buniversity degree\b)"
                       r"|\bB\.?S\.?c?\b(?! ?in? ?(?:Office|SQL))|\bB\.A\b|\bBA\b|\bB\.?E\b(?=[ ,/.])"
                       r"|\bB\.?Tech\b"),
          ("master", r"(?i:\bmaster'?s?'? (?:degree|in|of)\b|\bmaster'?s'?\b|\bm\.?eng\b)"
                     r"|\bM\.?S\.?c?\b(?! ?(?:Office|SQL|Azure|Teams|Excel|Word|Project|Dynamics|Windows))"
                     r"|\bM\.S\b|\bMBA\b"),
          ("professional", r"\bM\.D\.|\bMD(?=\s*(?:,|/|or|and)\s*D\.?O\b)|\bJ\.D\.|\bJD\b(?=\s*(?:degree|from|required|or|,|/))"
                           r"|(?i:\bdoctor of (?:medicine|osteopath\w*|pharmacy|dental|nursing practice|psychology"
                           r"|physical therapy)\b|\bjuris doctor(?:ate)?\b)|\bPharm\.?D\b|\bPsy\.?D\b"
                           r"|(?<![-#])\bDNP\b|\bDDS\b(?=\s*(?:,|/|or)\s*DMD\b)|\bDMD\b"),  # not the #LI-DNP tag
          ("phd", r"(?i:\bph\.?\s?d\.?s?\b|\bdoctora(?:te|l)\b)")]
EQUIV = re.compile(r"\bor (?:an? )?(?:equivalent|comparable|similar|relevant|sufficient)\b"
                   r"(?! (?:fields?|disciplines?|majors?|degrees?|technical field))"
                   r"|\bequivalent (?:practical |work |professional )?experience\b", re.I)
HARD = re.compile(r"\b(required|must|minimum)\b", re.I)


def levels(clauses):
    clauses = [re.sub(r"(?i)\bpost-\S+", "", c) for c in clauses]  # "10+ YoE (post-BS/MS)" names no degree
    named = [name for name, rx in DEGREE if any(re.search(rx, c) for c in clauses)]
    return named or (["bachelor"] if any(re.search(r"(?i)\bdegree in\b", c) for c in clauses) else [])


def degree(sec):
    """-> {"level": associate/bachelor/master/professional/phd, "req": required/preferred} or None. Lowest level named is
    the bar; a professional doctorate (JD, MD, PharmD...) counts below a PhD, so "Juris Doctorate" reads as professional."""
    must = levels(sec["must"])
    if must:
        lines = [c for c in sec["must"] if levels([c])]
        return dict(level=must[0], req="preferred" if any(EQUIV.search(c) for c in lines) else "required")
    nice = levels(sec["nice"] + sec["soft"])
    if nice:
        return dict(level=nice[0], req="preferred")
    if not sec["must"]:
        hits = [c for c in sec["other"] if re.search(r"(?i)\bdegree\b|\bph\.?d\b", c) and levels([c])]
        if hits:
            return dict(level=levels(hits)[0],
                        req="required" if any(HARD.search(c) and not EQUIV.search(c) for c in hits) else "preferred")
    return None
