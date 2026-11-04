"""Self-checks for the rules: keywords, locations, job types, level, family and evaluate(). Run: python3 -m unittest"""
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
        for kw in (dict(title="Engineering Manager, Payments"), dict(title="Account Executive"),
                   dict(title="Software Engineer Internships - Summer 2027"), dict(location="Berlin, Germany"),
                   dict(posted=(NOW - timedelta(days=60)).isoformat()), dict(url="javascript:alert(1)")):
            self.assertIsNone(rules.evaluate(job(**kw), R, CUTOFF), kw)
        self.assertIsNotNone(rules.evaluate(job(description="Ruby and Rails"), R, CUTOFF))  # every technology is kept

    def test_lazy_fields_only_fetched_when_needed(self):
        calls = []
        lazy = lambda v: lambda: calls.append(v) or v  # noqa: E731
        rules.evaluate(job(title="Account Executive", description=lazy(DESC)), R, CUTOFF)
        self.assertEqual(calls, [])
        row = rules.evaluate(job(location=lazy("Toronto, ON"), description=lazy(DESC), type=lazy("Full time")), R, CUTOFF)
        self.assertEqual((row["where"], row["type"]), (["Canada"], "Full-time"))


if __name__ == "__main__":
    unittest.main()
