"""Self-checks for the rules and source parsers. Run: python3 -m unittest"""
import json
import unittest
from datetime import timedelta
from unittest import mock

import fetch_jobs as f

R = f.load_rules()
NOW = f.NOW
CUTOFF = NOW - timedelta(days=30)
DESC = ("&lt;p&gt;5+ years of backend experience with Java, Kafka, AWS, Kubernetes, PostgreSQL "
        "and Go, gRPC. Payments domain.&lt;/p&gt;")


def job(**kw):
    base = dict(title="Senior Backend Engineer", company="Acme", location="Vancouver, BC", url="https://x.test/1",
                posted=NOW.isoformat(), source="Greenhouse", description=DESC)
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
        cases = {"Vancouver, BC": ["Canada"], "Vancouver, WA": ["US"], "San Francisco, CA": ["US"],
                 "Toronto, ON, CA": ["Canada"], "Remote - US": ["US", "Remote"], "Remote Worldwide": ["Remote"],
                 "Remote - Europe": [], "London, UK": [], "Remote Colorado": ["US", "Remote"],
                 "Remote Europe, LATAM, APAC, the U.S., Canada": ["Canada", "US", "Remote"],
                 "USA - Georgia - Alpharetta - 30005": ["US"], "Flexible / Remote": ["Remote"]}
        for loc, want in cases.items():
            self.assertEqual(f.where(loc), want, loc)


class Types(unittest.TestCase):
    def test_job_type(self):
        self.assertEqual(f.job_type("FullTime", "", ""), "Full-time")
        self.assertEqual(f.job_type("full_time", "", ""), "Full-time")
        self.assertEqual(f.job_type("Short Term", "", ""), "Contract")
        self.assertEqual(f.job_type("PartTime", "", ""), "Part-time")
        self.assertEqual(f.job_type(None, "Backend Engineer (Contract)", ""), "Contract")
        self.assertEqual(f.job_type(None, "Engineer", "We write smart contracts. This is a full-time role."), "Full-time")
        self.assertEqual(f.job_type(None, "Engineer", "This is a 6-month contract."), "Contract")
        self.assertEqual(f.job_type(None, "Engineer", "Great team."), "Not specified")

    def test_dates(self):
        self.assertEqual(f.when("October 30, 2026").day, 30)
        self.assertEqual(f.when("Mon, 02 Nov 2026 17:00:19 +0000").month, 11)
        self.assertEqual(f.when(1793636892).year, 2026)
        self.assertEqual(f.days_ago("Posted 30+ Days Ago"), 31)
        self.assertEqual(f.days_ago("Posted Yesterday"), 1)


class Evaluate(unittest.TestCase):
    def test_keeps_and_scores(self):
        row = f.evaluate(job(), R, CUTOFF)
        self.assertEqual(row["where"], ["Canada"])
        self.assertIn("Kafka", row["matched"])
        self.assertEqual(set(row["missing"]), {"Go", "gRPC"})
        self.assertEqual(row["years_required"], 5)
        self.assertIsNone(row["applicants"])
        self.assertEqual(row["type"], "Not specified")
        self.assertEqual(row["score"], round(100 * len(row["matched"]) / (len(row["matched"]) + 2)))

    def test_rules_reject(self):
        self.assertIsNone(f.evaluate(job(title="Engineering Manager, Payments"), R, CUTOFF))
        self.assertIsNone(f.evaluate(job(title="Account Executive"), R, CUTOFF))
        self.assertIsNone(f.evaluate(job(location="Berlin, Germany"), R, CUTOFF))
        self.assertIsNone(f.evaluate(job(posted=(NOW - timedelta(days=60)).isoformat()), R, CUTOFF))
        self.assertIsNone(f.evaluate(job(description="Ruby and Rails"), R, CUTOFF))
        self.assertIsNone(f.evaluate(job(url="javascript:alert(1)"), R, CUTOFF))

    def test_lazy_fields_only_fetched_when_needed(self):
        calls = []
        lazy = lambda v: lambda: calls.append(v) or v  # noqa: E731
        f.evaluate(job(title="Account Executive", description=lazy(DESC)), R, CUTOFF)
        self.assertEqual(calls, [])
        row = f.evaluate(job(location=lazy("Toronto, ON"), description=lazy(DESC), type=lazy("Full time")), R, CUTOFF)
        self.assertEqual((row["where"], row["type"]), (["Canada"], "Full-time"))


class Sources(unittest.TestCase):
    """Parsers against payload shapes captured from the live APIs."""

    def run_with(self, fn, *args, payloads):
        responses = iter(payloads)
        fake = lambda url, body=None: (r if isinstance(r := next(responses), bytes) else json.dumps(r).encode())  # noqa
        with mock.patch.object(f, "fetch", side_effect=fake):
            return [{k: (v() if callable(v) else v) for k, v in j.items()} for j in fn(*args)]

    def test_lever(self):
        [j] = self.run_with(f.lever, "x", "X", payloads=[[{
            "text": "Backend Engineer", "hostedUrl": "https://jobs.lever.co/x/1", "createdAt": 1793636892000,
            "categories": {"commitment": "Permanent", "location": "Toronto", "allLocations": ["Toronto"]},
            "workplaceType": "hybrid", "country": "CA", "descriptionPlain": "Java", "lists": [], "additionalPlain": ""}]])
        self.assertEqual((j["type"], f.where(j["location"])), ("Permanent", ["Canada"]))

    def test_ashby_hybrid_is_not_remote(self):
        [j] = self.run_with(f.ashby, "x", "X", payloads=[{"jobs": [{
            "title": "SWE", "jobUrl": "https://jobs.ashbyhq.com/x/1", "publishedAt": "2026-10-30T00:00:00Z",
            "employmentType": "FullTime", "location": "San Francisco", "secondaryLocations": [], "isRemote": True,
            "workplaceType": "Hybrid", "address": {"postalAddress": {"addressCountry": "United States"}},
            "descriptionPlain": "Java"}]}])
        self.assertEqual(f.where(j["location"]), ["US"])

    def test_smartrecruiters_fetches_description_lazily(self):
        [j] = self.run_with(f.smartrecruiters, "Acme", "Acme", payloads=[
            {"totalFound": 1, "content": [{"id": "7", "name": "Software Engineer", "releasedDate": "2026-10-30T00:00:00Z",
                                           "typeOfEmployment": {"label": "Full-time"},
                                           "location": {"fullLocation": "Austin, Texas, United States", "country": "us",
                                                        "remote": True, "hybrid": False}}]},
            {"jobAd": {"sections": {"jobDescription": {"text": "Kafka"}, "qualifications": {"text": "Java"}}}}])
        self.assertEqual(j["url"], "https://jobs.smartrecruiters.com/Acme/7")
        self.assertEqual(j["description"], "Kafka Java")
        self.assertEqual(f.where(j["location"]), ["US", "Remote"])

    def test_workday_multi_location(self):
        [j] = self.run_with(f.workday, "acme.wd5/Ext", "Acme", payloads=[
            {"total": 1, "jobPostings": [{"title": "SWE", "externalPath": "/job/x/SWE_1", "locationsText": "2 Locations",
                                          "postedOn": "Posted 3 Days Ago"}]},
            {"jobPostingInfo": {"location": "Toronto, ON", "additionalLocations": ["Seattle, WA"],
                                "country": {"descriptor": "Canada"}, "timeType": "Full time", "jobDescription": "<p>Java</p>"}}])
        self.assertEqual(j["url"], "https://acme.wd5.myworkdayjobs.com/Ext/job/x/SWE_1")
        self.assertEqual(f.where(j["location"]), ["Canada", "US"])
        self.assertEqual(j["type"], "Full time")

    def test_hackernews(self):
        [j] = self.run_with(f.hackernews, payloads=[
            {"hits": [{"title": "Ask HN: Who is hiring? (November 2026)", "objectID": "9"}]},
            {"children": [{"id": 11, "created_at": "2026-11-02T16:00:00Z",
                           "text": "Acme | Senior Backend Engineer, Designer | REMOTE (US) | Full-time<p>We use Java"},
                          {"id": 12, "text": "Not a job post"}]}])
        self.assertEqual((j["company"], j["title"]), ("Acme", "Senior Backend Engineer"))
        self.assertEqual(f.where(j["location"]), ["US", "Remote"])
        self.assertEqual(f.job_type(j["type"], "", ""), "Full-time")

    def test_weworkremotely(self):
        rss = (b"<rss><channel><item><title>Acme: Backend Engineer</title><region>USA Only</region>"
               b"<type>Contract</type><pubDate>Mon, 02 Nov 2026 07:31:15 +0000</pubDate>"
               b"<link>https://weworkremotely.com/x</link><description>Java</description></item></channel></rss>")
        jobs = self.run_with(f.weworkremotely, payloads=[rss, rss, rss])
        self.assertEqual((jobs[0]["company"], jobs[0]["title"], jobs[0]["type"]), ("Acme", "Backend Engineer", "Contract"))
        self.assertEqual(f.where(jobs[0]["location"]), ["US", "Remote"])


if __name__ == "__main__":
    unittest.main()
