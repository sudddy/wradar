"""Self-checks for the rules: keywords, locations, job types, level, family and evaluate(). Run: python3 -m unittest"""
import re
import unittest
from datetime import timedelta

import rules
import sources
from test_fetch_jobs import CUTOFF, DESC, NOW, R, job


class Keywords(unittest.TestCase):
    def test_boundaries_and_lookalikes(self):
        for text, name, found in (("JavaScript and TypeScript", "Java", False), ("PostgreSQL", "SQL", False),
                                  ("the rest of the team", "REST APIs", False), ("REST and gRPC", "REST APIs", True),
                                  ("Modern C++ experience", "C++", True), ("Java, Go, Rust", "Go", True),
                                  ("services written in Go.", "Go", True), ("Golang", "Go", True),
                                  ("Go-to-market team. Go beyond the basics.", "Go", False),
                                  ("event-driven payment rails", "Ruby on Rails", False),
                                  ("payment tracking via SWIFT GPI", "SWIFT", True),
                                  ("payment tracking via SWIFT GPI", "Swift", False)):
            self.assertEqual(name in rules.skills(R["kw"], text), found, (text, name))

    def test_the_prefilter_never_skips_a_match(self):
        letter = re.compile("[a-z]", re.I)  # every character re.I reads as an ASCII letter folds to that letter
        for c in (chr(n) for n in range(128, 0x110000) if letter.fullmatch(chr(n))):
            folded = c.translate(rules.FOLD).lower()
            self.assertTrue(len(folded) == 1 and folded.isascii() and re.fullmatch(folded, c, re.I), hex(ord(c)))
        odd = str.maketrans({"s": "ſ", "i": "ı", "k": "K", "I": "İ"})
        for name, aliases in R["keywords"].items():
            said = " and ".join(a.lstrip("=").removeprefix("re:") for a in aliases)
            for text in (said, said.upper(), said.swapcase(), said.translate(odd), f"x{said}x", f"ſ{said}ı", f"K{said}İ"):
                self.assertEqual(rules.skills(R["kw"], text, R["needles"]), rules.skills(R["kw"], text), (name, text))

    def test_words_a_re_alias_needs(self):
        need = lambda p: rules.required(rules.sre_parse.parse(p))  # noqa: E731
        self.assertEqual(need(r"\b[Gg]olang\b|(?:(?<=, )|(?<=\bin ))Go(?![\w-])|\bGo(?=\s*[,/)])"), {"olang", "go"})
        self.assertEqual(need(r"(?:[Ff]luent|[Nn]ative)\b[^.\n]{0,50}\bSpanish\b|\(Spanish\s*\)"), {"spanish"})
        self.assertEqual(need(r"\b[Dd]ata [Pp]rivacy\b(?! [Nn]otice)"), {"rivacy"})  # the longer of two words it needs
        for p in (r"R(?![\w&+'-])", r"(?:Kafka)?", r"[A-Z]{2,}", r"Go|\d+"):
            self.assertIsNone(need(p), p)
        aliases = {"Lever": ["re:(?:(?<=[,/(] )|(?<=\\bor ))(?:Lever)\\b(?![\\w-])"], "R": ["re:(?<=, )R(?![\\w&+'-])", "rstudio"],
                   "Spanish": ["re:[Ff]luent\\b[^.\\n]{0,50}\\bSpanish\\b|\\bSpanish[- ]speaking\\b"]}
        kw, nd = rules.compile_keywords(aliases), rules.needles(aliases)
        for text in ("ATS: Greenhouse, Lever", "Workday or Lever", "Lever ownership", "LEVER", "Python, R", "fluent in Spanish",
                     "Spanish-speaking", "SPANISH", "Greenhouse"):
            self.assertEqual(rules.skills(kw, text, nd), rules.skills(kw, text), text)


class Locations(unittest.TestCase):
    def test_where(self):
        cases = {"Vancouver, BC": ["Canada"], "Vancouver, WA": ["US"], "San Francisco, CA": ["US"],
                 "Toronto, ON, CA": ["Canada"], "Remote - US": ["US", "Remote"], "Remote Worldwide": ["Remote"],
                 "Remote - Europe": [], "London, UK": [], "Remote Colorado": ["US", "Remote"],
                 "Remote Europe, LATAM, APAC, the U.S., Canada": ["Canada", "US", "Remote"],
                 "USA - Georgia - Alpharetta - 30005": ["US"], "Flexible / Remote": ["Remote"]}
        for loc, want in cases.items():
            self.assertEqual(rules.where(loc), want, loc)


class Types(unittest.TestCase):
    def test_job_type(self):
        for args, want in {("FullTime", "", ""): "Full-time", ("full_time", "", ""): "Full-time",
                           ("Short Term", "", ""): "Contract", ("PartTime", "", ""): "Part-time",
                           (None, "Backend Engineer (Contract)", ""): "Contract", (None, "SWE", "Great team."): "Not specified",
                           (None, "Engineer", "We write smart contracts. This is a full-time role."): "Full-time",
                           (None, "Engineer", "This is a 6-month contract."): "Contract"}.items():
            self.assertEqual(rules.job_type(*args), want, args)

    def test_internships_per_diem_and_contracts_roles(self):
        for args, want in {("Intern", "", ""): "Internship", ("Intern (Full-Time)", "", ""): "Internship",
                           (None, "Software Engineer Intern", ""): "Internship", (None, "Co-op Student, Data", ""): "Internship",
                           ("Per Diem", "", ""): "Part-time", (None, "Registered Nurse - PRN", ""): "Part-time",
                           ("contract_to_hire", "", ""): "Contract", (None, "Recruiter (Contract)", ""): "Contract",
                           (None, "Senior Contracts Manager", ""): "Not specified",
                           (None, "Legal Contract Manager", ""): "Not specified",
                           (None, "Nurse", "Per diem travel allowance."): "Not specified"}.items():
            self.assertEqual(rules.job_type(*args), want, args)

    def test_dates(self):
        self.assertEqual((rules.when("October 30, 2026").day, rules.when("Mon, 02 Nov 2026 17:00:19 +0000").month,
                          rules.when(1793636892).year, sources.days_ago("Posted 30+ Days Ago"),
                          sources.days_ago("Posted Yesterday")), (30, 11, 2026, 31, 1))


class Classify(unittest.TestCase):
    def test_level(self):
        for title, want in {"Senior Backend Engineer": "Senior", "Staff Software Engineer": "Staff+",
                            "Software Engineer II": "Mid", "Software Engineer I": "Junior",
                            "Tech Lead, Payments": "Senior", "AI Engineer": "Mid", "Staff Engineer": "Staff+",
                            "Member of Technical Staff": "Mid", "Senior Member of Technical Staff": "Senior",
                            "Principal Member of Technical Staff": "Staff+"}.items():
            self.assertEqual(rules.level(title), want, title)

    def test_level_on_both_tracks(self):  # a "Manager" after an IC noun is an individual contributor
        for title, want in {"Chief Executive Officer": "C-level", "Co-Founder & CTO": "C-level",
                            "Executive Assistant to the CEO": "Mid", "Field CTO": "Mid", "Vice President, Sales": "VP",
                            "SVP, Marketing": "VP", "Assistant Vice President, Compliance": "Senior Manager",
                            "Associate Vice President": "Director", "Senior Director, Engineering": "Senior Director",
                            "Head of Design": "Director", "Associate Director, Clinical Operations": "Director",
                            "Director, Product Marketing": "Director", "Senior Manager, Accounting": "Senior Manager",
                            "Engineering Manager, Payments": "Manager", "Supervisor, Warehouse": "Manager",
                            "Product Manager": "Mid", "Customer Success Manager": "Mid", "Senior Product Manager": "Senior",
                            "Group Product Manager": "Staff+", "Enterprise Architect": "Staff+", "Solutions Architect": "Mid",
                            "Staff Accountant": "Mid", "Software Engineering Intern": "Intern",
                            "New Grad Software Engineer": "Junior"}.items():
            self.assertEqual(rules.level(title), want, title)
        self.assertEqual(set(rules.LADDER), {name for name, _ in rules.LEVELS} | {"Mid"})

    def test_family(self):  # security is checked before AI and cloud
        for title, found, want in (("Senior Backend Engineer, Data Platform", set(), "Backend"),
                                   ("Software Engineer, Payments", set(), "Backend"),
                                   ("Senior Frontend Engineer", set(), "Frontend"),
                                   ("Software Engineer", {"Java", "Kafka", "React"}, "Backend"),
                                   ("Software Engineer", {"Java", "Kafka", "React", "Redux"}, "Full stack"),
                                   ("Software Engineer", set(), "General"), ("AI Security Engineer", set(), "Security"),
                                   ("Cloud Security Engineer", set(), "Security"),
                                   ("Backend Engineer, Security", set(), "Backend")):
            self.assertEqual(rules.family(title, found), want, title)

    def test_family_in_every_field(self):  # technical roles outside software win over "engineer"; the first segment decides
        for title, want in {"Sales Engineer": "Solutions & presales", "Account Executive": "Sales",
                            "AI Security Sales Executive": "Sales", "Product Manager, Payments": "Product management",
                            "Software Engineer, Sales Platform": "DevOps / SRE", "Engineering Manager, Payments": "Backend",
                            "Mechanical Engineer": "Hardware", "Developer Advocate": "Developer relations",
                            "IT Support Specialist": "IT", "Security Analyst": "Cybersecurity", "Data Scientist": "Data science",
                            "Data Analyst": "Analytics", "Registered Nurse": "Clinical", "Product Designer": "Design",
                            "Customer Success Manager": "Customer success", "Recruiter": "Recruiting",
                            "Staff Accountant": "Accounting", "Financial Analyst": "Finance", "Corporate Counsel": "Legal",
                            "Executive Assistant": "Administrative", "Teacher": "Education"}.items():
            self.assertEqual(rules.family(title, set()), want, title)

    def test_department_fallback_and_fields(self):
        self.assertEqual([rules.family("Associate", set(), d) for d in ("Sales & Partnerships", "")], ["Sales", "Other"])
        self.assertEqual(rules.family("Senior Backend Engineer", set(), "Sales"), "Backend")  # the title wins
        self.assertEqual([rules.FIELDS[n] for n in ("Backend", "General", "Security", "Cybersecurity", "Hardware", "Other")],
                         ["Engineering", "Engineering", "Engineering", "IT & security", "Engineering", "Other"])
        self.assertEqual(len(set(rules.FIELDS.values())), 15)
        self.assertTrue({n for n, _, _ in rules.ROLES} <= set(rules.FIELDS))


class Evaluate(unittest.TestCase):
    def test_keeps_and_tags(self):
        row = rules.evaluate(job(), R, CUTOFF)
        self.assertEqual(row["skills"], ["Java", "Go", "gRPC", "Kafka", "AWS", "Kubernetes", "PostgreSQL", "Payments"])
        self.assertEqual([row[k] for k in ("where", "years_required", "applicants", "type", "level", "role")],
                         [["Canada"], 5, None, "Not specified", "Senior", "Backend"])

    def test_extracted_fields_and_must_and_nice_are_subsets_of_skills(self):
        body = ("<p>We use AWS.</p><p>Requirements</p><ul><li>5+ years of Java</li><li>Bachelor's degree in CS</li></ul>"
                "<p>Nice to have</p><ul><li>Kafka</li></ul>"
                "<p>Salary range: $150,000 - $200,000 USD per year. This is a hybrid role.</p>")
        row = rules.evaluate(job(title="Backend Engineer", description=body), R, CUTOFF)
        self.assertEqual([row[k] for k in ("must", "nice", "years_required", "salary", "mode", "degree", "posted_approx")],
                         [["Java"], ["Kafka"], 5, dict(min=150000, max=200000, cur="USD", per="year"), "Hybrid",
                          dict(level="bachelor", req="required"), False])
        self.assertEqual(set(row["skills"]) - set(row["must"]) - set(row["nice"]), {"AWS"})

    def test_adapter_fields_win_over_the_body(self):
        pay = dict(min=100000, max=110000, cur="USD", per="year")
        row = rules.evaluate(job(mode="Remote", salary=pay, posted_approx=True,
                             description="Salary range: $150,000 - $200,000. This is a hybrid role."), R, CUTOFF)
        self.assertEqual((row["mode"], row["salary"], row["posted_approx"]), ("Remote", pay, True))

    def test_rules_reject(self):
        for kw in (dict(title="General Application - Engineering"), dict(title="Join our Talent Community"),
                   dict(location="Berlin, Germany"), dict(posted=(NOW - timedelta(days=60)).isoformat()),
                   dict(url="javascript:alert(1)")):
            self.assertIsNone(rules.evaluate(job(**kw), R, CUTOFF), kw)
        self.assertIsNotNone(rules.evaluate(job(description="Ruby and Rails"), R, CUTOFF))  # every technology is kept

    def test_every_field_and_level_is_kept(self):
        for title, level, role, kind in (("Engineering Manager, Payments", "Manager", "Backend", "Not specified"),
                                         ("Account Executive", "Mid", "Sales", "Not specified"),
                                         ("Software Engineer Internships - Summer 2027", "Intern", "General", "Internship"),
                                         ("VP, People", "VP", "People & HR", "Not specified"),
                                         ("Registered Nurse (Per Diem)", "Mid", "Clinical", "Part-time")):
            row = rules.evaluate(job(title=title, description="Great team."), R, CUTOFF)
            self.assertEqual((row["level"], row["role"], row["type"]), (level, role, kind), title)

    def test_the_company_is_not_one_of_its_skills(self):
        row = rules.evaluate(job(company="Datadog", description="<p>We use Redis.</p><p>Requirements</p><ul><li>Java and "
                                                                "Datadog</li></ul>"), R, CUTOFF)
        self.assertEqual((row["skills"], row["must"]), (["Java", "Redis"], ["Java"]))

    def test_lazy_fields_only_fetched_when_needed(self):
        calls = []
        lazy = lambda v: lambda: calls.append(v) or v  # noqa: E731
        rules.evaluate(job(title="General Application", description=lazy(DESC)), R, CUTOFF)
        self.assertEqual(calls, [])
        row = rules.evaluate(job(location=lazy("Toronto, ON"), description=lazy(DESC), type=lazy("Full time")), R, CUTOFF)
        self.assertEqual((row["where"], row["type"]), (["Canada"], "Full-time"))


if __name__ == "__main__":
    unittest.main()
