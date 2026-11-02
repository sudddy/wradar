"""Self-checks for the rules. Run: python3 -m unittest"""
import unittest
from datetime import datetime, timedelta, timezone

import fetch_jobs as f

R = f.load_rules()
NOW = datetime.now(timezone.utc)


def job(**kw):
    base = dict(title="Senior Backend Engineer", company="Acme", location="Vancouver, BC", url="https://x.test/1",
                posted=NOW.isoformat(), source="Greenhouse",
                description="&lt;p&gt;5+ years of backend experience with Java, Kafka, AWS, Kubernetes, PostgreSQL "
                            "and Go, gRPC. Payments domain.&lt;/p&gt;")
    return dict(base, **kw)


class Keywords(unittest.TestCase):
    def has(self, s):
        return f.skills(R["kw"], s)

    def test_boundaries(self):
        self.assertNotIn("Java", self.has("JavaScript and TypeScript"))
        self.assertNotIn("SQL", self.has("PostgreSQL"))
        self.assertNotIn("REST APIs", self.has("the rest of the team"))
        self.assertIn("REST APIs", self.has("REST and gRPC"))
        self.assertIn("C++", self.has("Modern C++ experience"))

    def test_go(self):
        self.assertIn("Go", self.has("Java, Go, Rust"))
        self.assertIn("Go", self.has("services written in Go."))
        self.assertIn("Go", self.has("Golang"))
        self.assertNotIn("Go", self.has("Go-to-market team. Go beyond the basics."))

    def test_resume_core_skills(self):
        for k in ("Java", "Python", "Kafka", "AWS", "Kubernetes", "PostgreSQL", "Payments", "CQRS", "SWIFT"):
            self.assertIn(k, R["resume"])
        self.assertNotIn("Go", R["resume"])
        self.assertNotIn("Ruby on Rails", R["resume"])  # "payment rails" is not Rails


class Locations(unittest.TestCase):
    def test_where(self):
        self.assertEqual(f.where("Vancouver, BC"), ["Canada"])
        self.assertEqual(f.where("Vancouver, WA"), ["US"])
        self.assertEqual(f.where("San Francisco, CA"), ["US"])
        self.assertEqual(f.where("Toronto, ON, CA"), ["Canada"])
        self.assertEqual(f.where("Remote - US"), ["US", "Remote"])
        self.assertEqual(f.where("Remote Worldwide"), ["Remote"])
        self.assertEqual(f.where("Remote - Europe"), [])
        self.assertEqual(f.where("London, UK"), [])


class Evaluate(unittest.TestCase):
    cutoff = NOW - timedelta(days=30)

    def test_keeps_and_scores(self):
        row = f.evaluate(job(), R, self.cutoff)
        self.assertEqual(row["where"], ["Canada"])
        self.assertIn("Kafka", row["matched"])
        self.assertEqual(set(row["missing"]), {"Go", "gRPC"})
        self.assertEqual(row["years_required"], 5)
        self.assertIsNone(row["applicants"])
        self.assertEqual(row["score"], round(100 * len(row["matched"]) / (len(row["matched"]) + 2)))

    def test_rules_reject(self):
        self.assertIsNone(f.evaluate(job(title="Engineering Manager, Payments"), R, self.cutoff))
        self.assertIsNone(f.evaluate(job(title="Account Executive"), R, self.cutoff))
        self.assertIsNone(f.evaluate(job(location="Berlin, Germany"), R, self.cutoff))
        self.assertIsNone(f.evaluate(job(posted=(NOW - timedelta(days=60)).isoformat()), R, self.cutoff))
        self.assertIsNone(f.evaluate(job(description="Ruby and Rails"), R, self.cutoff))
        self.assertIsNone(f.evaluate(job(url="javascript:alert(1)"), R, self.cutoff))


if __name__ == "__main__":
    unittest.main()
