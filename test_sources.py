"""Self-checks for the source adapters. Run: python3 -m unittest"""
import json
import unittest
from unittest import mock

import extract as x
import rules
import sources


class Sources(unittest.TestCase):
    """Parsers against payload shapes captured from the live APIs."""

    def run_with(self, fn, *args, payloads):
        responses = iter(payloads)
        fake = lambda url, body=None: (r if isinstance(r := next(responses), bytes) else json.dumps(r).encode())  # noqa
        with mock.patch.object(sources, "fetch", side_effect=fake):
            return [{k: (v() if callable(v) else v) for k, v in j.items()} for j in fn(*args)]

    def test_lever(self):
        [j] = self.run_with(sources.lever, "x", "X", payloads=[[{
            "text": "Backend Engineer", "hostedUrl": "https://jobs.lever.co/x/1", "createdAt": 1793636892000,
            "categories": {"commitment": "Permanent", "location": "Toronto", "allLocations": ["Toronto"]},
            "workplaceType": "hybrid", "country": "CA", "description": "<div>Java</div>",
            "lists": [{"text": "Requirements", "content": "<li>Kafka</li>"}], "additional": "<div>Pay</div>",
            "salaryRange": {"min": 75600, "max": 103950, "currency": "USD", "interval": "per-year-salary"}}]])
        self.assertEqual((j["type"], rules.where(j["location"])), ("Permanent", ["Canada"]))
        self.assertEqual(j["mode"], "hybrid")
        self.assertEqual(j["salary"], dict(min=75600, max=103950, cur="USD", per="year"))
        self.assertEqual(x.rich_text(j["description"]), "Java\nRequirements\nKafka\nPay")

    def test_ashby_hybrid_is_not_remote_and_pays_in_its_home_currency(self):
        pay = lambda cur, lo, hi: {"components": [  # noqa: E731
            {"compensationType": "EquityPercentage", "interval": "NONE", "currencyCode": None, "minValue": None},
            {"compensationType": "Salary", "interval": "1 YEAR", "currencyCode": cur, "minValue": lo, "maxValue": hi}]}
        [j] = self.run_with(sources.ashby, "x", "X", payloads=[{"jobs": [{
            "title": "SWE", "jobUrl": "https://jobs.ashbyhq.com/x/1", "publishedAt": "2026-10-30T00:00:00Z",
            "employmentType": "FullTime", "location": "San Francisco", "secondaryLocations": [], "isRemote": True,
            "workplaceType": "Hybrid", "address": {"postalAddress": {"addressCountry": "United States"}},
            "descriptionHtml": "<p>Java</p>", "descriptionPlain": "Java", "compensation": {"compensationTiers": [
                pay("CAD", 295000, 535000), pay("USD", 205000, 380000), pay("USD", 175000, 325000)]}}]}])
        self.assertEqual((rules.where(j["location"]), j["mode"], j["description"]), (["US"], "Hybrid", "<p>Java</p>"))
        self.assertEqual(j["salary"], dict(min=175000, max=380000, cur="USD", per="year"))  # USD tiers, not the first

    def test_ashby_asks_for_compensation(self):
        with mock.patch.object(sources, "fetch", return_value=b'{"jobs": []}') as fetch:
            sources.ashby("x", "X")
        self.assertIn("includeCompensation=true", fetch.call_args.args[0])

    def test_smartrecruiters_fetches_description_lazily(self):
        [j] = self.run_with(sources.smartrecruiters, "Acme", "Acme", payloads=[
            {"totalFound": 1, "content": [{"id": "7", "name": "Software Engineer", "releasedDate": "2026-10-30T00:00:00Z",
                                           "typeOfEmployment": {"label": "Full-time"},
                                           "location": {"fullLocation": "Austin, Texas, United States", "country": "us",
                                                        "remote": True, "hybrid": False}}]},
            {"jobAd": {"sections": {"jobDescription": {"title": "Job Description", "text": "Kafka"},
                                    "qualifications": {"title": "Qualifications", "text": "Java"}}}}])
        self.assertEqual((j["url"], rules.where(j["location"]), j["mode"]), ("https://jobs.smartrecruiters.com/Acme/7",
                                                                         ["US", "Remote"], "Remote"))
        self.assertEqual(x.rich_text(j["description"]), "Job Description\nKafka\nQualifications\nJava")

    def test_smartrecruiters_hybrid(self):
        posting = {"id": "7", "name": "SWE", "location": {"fullLocation": "Austin", "remote": True, "hybrid": True}}
        [j] = self.run_with(sources.smartrecruiters, "Acme", "Acme", payloads=[
            {"totalFound": 1, "content": [posting]}, {"jobAd": {"sections": {}}}])
        self.assertEqual(j["mode"], "Hybrid")

    def test_amazon_keeps_basic_and_preferred_apart(self):
        jobs = self.run_with(sources.amazon, payloads=[{"jobs": [{
            "title": "SDE", "job_path": "/jobs/1", "posted_date": "October 30, 2026", "description": "Build things",
            "basic_qualifications": "- 5+ years of Java<br/>- Linux", "preferred_qualifications": "- Kafka",
            "normalized_location": "Seattle, WA", "country_code": "USA"}]}, {"jobs": []}, {"jobs": []}])
        sec = x.split_sections(x.rich_text(jobs[0]["description"]))
        self.assertEqual(("- 5+ years of Java" in sec["must"], "- Kafka" in sec["nice"], "- Kafka" in sec["must"]),
                         (True, True, False))

    def test_workday_multi_location(self):
        [j] = self.run_with(sources.workday, "acme.wd5/Ext", "Acme", payloads=[
            {"total": 1, "jobPostings": [{"title": "SWE", "externalPath": "/job/x/SWE_1", "locationsText": "2 Locations",
                                          "postedOn": "Posted 3 Days Ago"}]},
            {"jobPostingInfo": {"location": "Toronto, ON", "additionalLocations": ["Seattle, WA"],
                                "country": {"descriptor": "Canada"}, "timeType": "Full time", "jobDescription": "<p>Java</p>"}}])
        self.assertEqual(j["url"], "https://acme.wd5.myworkdayjobs.com/Ext/job/x/SWE_1")
        self.assertEqual((rules.where(j["location"]), j["type"], j["posted_approx"]), (["Canada", "US"], "Full time", False))

    def test_workday_flags_30_plus_days_and_skips_an_untitled_posting(self):
        [j] = self.run_with(sources.workday, "acme.wd5/Ext", "Acme", payloads=[
            {"total": 2, "jobPostings": [{"externalPath": "/job/x/JR_0"}, {"title": "SWE", "externalPath": "/job/x/SWE_1",
                                          "locationsText": "Seattle, WA", "postedOn": "Posted 30+ Days Ago"}]}, {"jobPostingInfo": {}}])
        self.assertIs(j["posted_approx"], True)

    def test_hackernews(self):
        [j] = self.run_with(sources.hackernews, payloads=[
            {"hits": [{"title": "Ask HN: Who is hiring? (November 2026)", "objectID": "9"}]},
            {"children": [{"id": 11, "created_at": "2026-11-02T16:00:00Z",
                           "text": "Acme | Senior Backend Engineer, Designer | REMOTE (US) | Full-time<p>We use Java"},
                          {"id": 12, "text": "Not a job post"}]}])
        self.assertEqual((j["company"], j["title"], rules.where(j["location"]), rules.job_type(j["type"], "", "")),
                         ("Acme", "Senior Backend Engineer", ["US", "Remote"], "Full-time"))

    def test_weworkremotely(self):
        rss = (b"<rss><channel><item><title>Acme: Backend Engineer</title><region>USA Only</region>"
               b"<type>Contract</type><pubDate>Mon, 02 Nov 2026 07:31:15 +0000</pubDate>"
               b"<link>https://weworkremotely.com/x</link><description>Java</description></item></channel></rss>")
        jobs = self.run_with(sources.weworkremotely, payloads=[rss, rss, rss])
        self.assertEqual((jobs[0]["company"], jobs[0]["title"], jobs[0]["type"]), ("Acme", "Backend Engineer", "Contract"))
        self.assertEqual(rules.where(jobs[0]["location"]), ["US", "Remote"])



if __name__ == "__main__":
    unittest.main()
