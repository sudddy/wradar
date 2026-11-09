"""Self-checks for the source adapters. Run: python3 -m unittest"""
import io
import json
import os
import traceback
import unittest
from datetime import timedelta
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import extract as x
import fetch_jobs as f
import rules
import scan_state as s
import sources
from test_fetch_jobs import CUTOFF, NOW, R, row

KEYS = {"ADZUNA_APP_ID": "test-app-id", "ADZUNA_APP_KEY": "test-app-key"}  # placeholders: no real key is used in tests


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
            "normalized_location": "Seattle, WA", "country_code": "USA"}]}] + [{"jobs": []}] * 9)
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
        jobs = self.run_with(sources.weworkremotely, payloads=[rss] * 9)
        self.assertEqual((jobs[0]["company"], jobs[0]["title"], jobs[0]["type"]), ("Acme", "Backend Engineer", "Contract"))
        self.assertEqual(rules.where(jobs[0]["location"]), ["US", "Remote"])

    def test_department_where_the_payload_has_one(self):  # read at scan time only, to place a title that names no role
        job = dict(title="Associate", url="https://x.test/1")
        cases = [(sources.greenhouse, ("x", "X"), [{"jobs": [dict(job, absolute_url=job["url"],
                                                                 departments=[{"name": "Sales"}, {"name": "EMEA"}])]}],
                  "Sales / EMEA"),
                 (sources.lever, ("x", "X"), [[dict(text="Associate", hostedUrl=job["url"],
                                                   categories={"department": "Sales", "team": "Enterprise"})]],
                  "Sales / Enterprise"),
                 (sources.ashby, ("x", "X"), [{"jobs": [dict(job, jobUrl=job["url"], department="People", team="Recruiting")]}],
                  "People / Recruiting"),
                 (sources.smartrecruiters, ("x", "X"), [{"totalFound": 1, "content": [
                     {"id": "7", "name": "Associate", "function": {"id": "finance", "label": "Finance"}, "department": {}}]},
                     {"jobAd": {"sections": {}}}], "Finance"),
                 (sources.workable, ("x", "X"), [{"jobs": [dict(job, department="Legal")]}], "Legal"),
                 (sources.remotive, (), [{"jobs": [dict(job, company_name="C", category="Sales / Business")]}],
                  "Sales / Business"),
                 (sources.jobicy, (), [{"jobs": [dict(jobTitle="Associate", companyName="C", url=job["url"],
                                                      jobIndustry=["QA & Testing"])]}, {"jobs": []}], "QA & Testing"),
                 (sources.workingnomads, (), [[dict(job, company_name="C", category_name="Marketing")]], "Marketing"),
                 (sources.themuse, (), [{"page_count": 1, "results": [dict(name="Associate", company={"name": "C"},
                                                                           refs={"landing_page": job["url"]},
                                                                           categories=[{"name": "Sales"}])]}], "Sales"),
                 (sources.amazon, (), [{"jobs": [dict(job, job_path="/1", job_category="Human Resources")]}]
                  + [{"jobs": []}] * 9, "Human Resources"),
                 (sources.weworkremotely, (), [b"<rss><channel><item><title>C: Associate</title>"
                                               b"<category>Customer Support</category></item></channel></rss>"] * 9,
                  "Customer Support")]
        for fn, args, payloads, want in cases:
            self.assertEqual(self.run_with(fn, *args, payloads=payloads)[0]["dept"], want, fn.__name__)

    def requests(self, fn, *args, answer):
        """-> [(url, body)] fn asked for, every call answered with answer (bytes as they are, anything else as JSON)."""
        reply = answer if isinstance(answer, bytes) else json.dumps(answer).encode()
        with mock.patch.object(sources, "fetch", return_value=reply) as fetch:
            fn(*args)
        return [(c.args[0], c.args[1] if len(c.args) > 1 else None) for c in fetch.call_args_list]

    def test_sources_ask_for_every_field(self):  # no search words, no category: the rules decide what is kept
        [(url, body)] = self.requests(sources.workday, "acme.wd5/Ext", "Acme", answer={"total": 0, "jobPostings": []})
        self.assertEqual((url, body["searchText"], body["limit"]),
                         ("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Ext/jobs", "", 20))
        [(url, _)] = self.requests(sources.remotive, answer={"jobs": []})
        self.assertEqual(url, "https://remotive.com/api/remote-jobs")
        urls = [u for u, _ in self.requests(sources.himalayas, answer={"jobs": []})]
        self.assertEqual((len(urls), any("q=" in u for u in urls), urls[0]),
                         (20, False, "https://himalayas.app/jobs/api/search?country=United%20States&page=1"))
        urls = [u for u, _ in self.requests(sources.themuse, answer={"page_count": 320, "results": []})]
        self.assertEqual((len(urls), any("category=" in u or "level=" in u for u in urls), urls[-1][-8:]),
                         (99, False, "&page=98"))
        urls = [u for u, _ in self.requests(sources.amazon, answer={"jobs": []})]
        self.assertEqual((len(urls), "base_query=&" in urls[0], urls[-1][-10:]), (10, True, "offset=900"))
        urls = [u for u, _ in self.requests(sources.weworkremotely, answer=b"<rss><channel></channel></rss>")]
        self.assertEqual((len(set(urls)), urls[4]),
                         (9, "https://weworkremotely.com/categories/remote-customer-support-jobs.rss"))
        [(url, _)] = self.requests(sources.workingnomads, answer=[])
        self.assertEqual(url, "https://www.workingnomads.com/api/exposed_jobs/")

    def test_working_nomads_keeps_every_category(self):
        jobs = self.run_with(sources.workingnomads, payloads=[[
            dict(title=t, company_name="C", url="https://x.test/1", category_name=c)
            for t, c in (("Backend Engineer", "Development"), ("Recruiter", "Administration"))]])
        self.assertEqual([j["title"] for j in jobs], ["Backend Engineer", "Recruiter"])


def ad(id, **kw):
    """One Adzuna search result, in the shape its docs show."""
    return {**dict(id=str(id), title="Medical Assistant", description="Day shifts in a busy clinic…",
                   created=(NOW - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   redirect_url=f"https://www.adzuna.com/land/ad/{id}?se=x&utm_medium=api&utm_source=test-app-id",
                   company={"display_name": "Acme Health"}, category={"label": "Other/General Jobs", "tag": "other-general-jobs"},
                   location={"area": ["US", "California", "Los Angeles County", "Los Angeles"],
                             "display_name": "Los Angeles, California"},
                   salary_min=41600, salary_max=52000, salary_is_predicted="0"), **kw}


class Adzuna(unittest.TestCase):
    def serve(self, pages):
        """Patch fetch to answer each (country, filter) with its pages of results. -> the list of URLs asked for."""
        asked = []

        def answer(url, body=None):
            asked.append(url)
            path, query = urlsplit(url).path.split("/"), parse_qs(urlsplit(url).query)
            got = pages.get((path[4], "contract" if "contract" in query else "part_time"), [])
            page = int(path[6]) - 1
            return json.dumps({"count": 999, "results": got[page] if page < len(got) else []}).encode()

        for patch in (mock.patch.dict(os.environ, KEYS), mock.patch.object(sources, "fetch", side_effect=answer)):
            patch.start()
            self.addCleanup(patch.stop)
        return asked

    def test_without_both_keys_it_is_off(self):  # fetch_jobs then leaves it out: test_fetch_jobs.Main
        for gone in KEYS:
            with mock.patch.dict(os.environ, KEYS):
                del os.environ[gone]
                self.assertIsNone(sources.adzuna_keys())
        with mock.patch.dict(os.environ, KEYS, ADZUNA_APP_KEY=""):  # a secret that isn't set reads as "" in the workflow
            self.assertIsNone(sources.adzuna_keys())
        with mock.patch.dict(os.environ, KEYS):
            self.assertEqual(sources.adzuna_keys(), {"app_id": "test-app-id", "app_key": "test-app-key"})

    def test_asks_each_country_for_contract_then_part_time_newest_first_and_stops_at_a_short_page(self):
        full = lambda tag: [ad(f"{tag}{i}") for i in range(2)]  # noqa: E731
        asked = self.serve({("us", "contract"): [full("a"), [ad("b")]], ("us", "part_time"): [],
                            ("ca", "contract"): [full("c"), full("d"), full("e")], ("ca", "part_time"): [[ad("f")]]})
        sources.adzuna(pages=3, per_page=2, max_days=90)
        calls = [(urlsplit(u).path, parse_qs(urlsplit(u).query)) for u in asked]
        self.assertEqual([p for p, _ in calls], ["/v1/api/jobs/us/search/1", "/v1/api/jobs/us/search/2",  # page 2 is short
                                                 "/v1/api/jobs/us/search/1",  # empty
                                                 "/v1/api/jobs/ca/search/1", "/v1/api/jobs/ca/search/2",
                                                 "/v1/api/jobs/ca/search/3",  # the pages limit
                                                 "/v1/api/jobs/ca/search/1"])
        self.assertEqual({urlsplit(u).netloc for u in asked}, {"api.adzuna.com"})
        for (_, query), ask in zip(calls, ["contract"] * 2 + ["part_time"] + ["contract"] * 3 + ["part_time"]):
            self.assertEqual(query, {"app_id": ["test-app-id"], "app_key": ["test-app-key"], "results_per_page": ["2"],
                                     "max_days_old": ["90"], "sort_by": ["date"], ask: ["1"]})

    def test_rows_pass_the_rules_with_place_type_pay_and_department(self):
        toronto = {"area": ["Canada", "Ontario", "Toronto"], "display_name": "Toronto, Ontario"}
        self.serve({("us", "contract"): [[
            ad(1, title="Registered Nurse", salary_min=25, salary_max=30, contract_type="contract", contract_time="part_time"),
            ad(2, title="Associate", category={"label": "Logistics & Warehouse Jobs"}, contract_type="contract",
               location={"area": ["US", "California", "San Bernardino County", "Ontario"], "display_name": "Ontario, California"}),
            ad(9)]],
            ("us", "part_time"): [[ad(3, title="Cashier", salary_is_predicted="1", contract_time="part_time"), ad(9)]],
            ("ca", "contract"): [[ad(4, title="Bookkeeper", location=toronto, salary_min=60000, salary_max=70000)]],
            ("ca", "part_time"): [[ad(5, title="Tutor", location=toronto, salary_is_predicted=1)]]})
        src, rows = f.run_source(("feed", "adzuna"), R, CUTOFF, {})  # config.json's pages and per_page: one call each here
        self.assertEqual((src["name"], src["kind"], src["ok"], src["seen"], src["kept"]), ("Adzuna", "Job boards", True, 6, 6))
        got = {j["title"]: j for j in rows}
        pay = lambda lo, hi, cur, per: dict(min=lo, max=hi, cur=cur, per=per)  # noqa: E731
        want = {"Registered Nurse": (["US"], "Contract", pay(25, 30, "USD", "hour"), "Clinical"),  # contract beats part-time
                "Associate": (["US"], "Contract", pay(41600, 52000, "USD", "year"), "Supply chain"),  # from the category
                "Medical Assistant": (["US"], "Contract", pay(41600, 52000, "USD", "year"), "Clinical"),  # first query kept
                "Cashier": (["US"], "Part-time", None, "Other"),  # predicted pay is left out
                "Bookkeeper": (["Canada"], "Contract", pay(60000, 70000, "CAD", "year"), "Accounting"),  # from the query
                "Tutor": (["Canada"], "Part-time", None, "Education")}
        self.assertEqual({t: (j["where"], j["type"], j["salary"], j["role"]) for t, j in got.items()}, want)
        self.assertEqual((got["Associate"]["location"], got["Bookkeeper"]["location"], got["Registered Nurse"]["source"]),
                         ("California / United States", "Toronto, Ontario / Canada", "Adzuna"))  # Ontario, California is US
        self.assertEqual((got["Tutor"]["url"], got["Tutor"]["company"]),
                         ("https://www.adzuna.com/land/ad/5?se=x&utm_medium=api&utm_source=test-app-id", "Acme Health"))

    def test_the_ads_own_fields_beat_the_filter_that_found_it(self):  # as when Adzuna ignores contract=1 or part_time=1
        self.serve({("us", "contract"): [[ad(1, title="Clerk A", contract_type="permanent", contract_time="full_time"),
                                          ad(2, title="Clerk B", contract_type="permanent"),
                                          ad(3, title="Clerk C", contract_time="full_time")]],  # a full-time contract
                    ("us", "part_time"): [[ad(4, title="Clerk D", contract_time="full_time"),
                                           ad(5, title="Clerk E", contract_type="permanent")]]})  # a permanent part-time job
        _, rows = f.run_source(("feed", "adzuna"), R, CUTOFF, {})
        self.assertEqual({j["title"]: j["type"] for j in rows}, {"Clerk A": "Full-time", "Clerk B": "Full-time",
                                                                 "Clerk C": "Contract", "Clerk D": "Full-time",
                                                                 "Clerk E": "Part-time"})

    def test_pay_takes_numbers_only_and_an_odd_one_does_not_sink_the_source(self):
        bounds = {"Hourly top": (15, 400), "Past hourly": (401, 401), "Max only": (None, 25), "Zero min": (0, 52000),
                  "Negative min": (-5, 30), "Swapped": (60000, 50000), "Strings": ("41600", "52000")}
        self.serve({("us", "contract"): [[ad(i, title=t, salary_min=lo, salary_max=hi)
                                          for i, (t, (lo, hi)) in enumerate(bounds.items())]]})
        src, rows = f.run_source(("feed", "adzuna"), R, CUTOFF, {})
        pay = lambda lo, hi, per: dict(min=lo, max=hi, cur="USD", per=per)  # noqa: E731
        self.assertEqual((src["ok"], {j["title"]: j["salary"] for j in rows}),
                         (True, {"Hourly top": pay(15, 400, "hour"), "Past hourly": None, "Max only": pay(25, 25, "hour"),
                                 "Zero min": pay(52000, 52000, "year"), "Negative min": pay(30, 30, "hour"),
                                 "Swapped": pay(50000, 60000, "year"), "Strings": None}))

    def test_a_refused_call_is_the_sources_error_and_never_shows_the_key(self):
        for code, reply in ((429, b""), (400, b'{"exception": "BAD_REQUEST", "display": "Bad parameter"}')):
            def refuse(url, body=None, code=code, reply=reply):
                raise HTTPError(url, code, "Refused", {}, io.BytesIO(reply))  # as urlopen raises it: the URL, key and all

            with mock.patch.dict(os.environ, KEYS), mock.patch.object(sources, "fetch", side_effect=refuse):
                with self.assertRaises(HTTPError) as caught:
                    sources.adzuna(5, 50, 90)
                src, rows = f.run_source(("feed", "adzuna"), R, CUTOFF, {})
            e = caught.exception
            self.assertIn("test-app-key", e.url)  # the key is in the request, so the checks below mean something
            self.assertEqual((src["ok"], src["error"], rows), (False, f"HTTP {code}", []))
            crash_log = "".join(traceback.format_exception(type(e), e, e.__traceback__))
            for said in (json.dumps(src), f.describe(e), str(e), repr(e), crash_log):
                self.assertNotIn("test-app-key", said)

    def test_a_reply_in_another_shape_is_the_sources_error_not_an_empty_list(self):
        for reply, error in ((b'callback({"results": []})', "JSONDecodeError"), (b'{"count": 0}', "KeyError")):
            with mock.patch.dict(os.environ, KEYS), mock.patch.object(sources, "fetch", return_value=reply):
                src, _ = f.run_source(("feed", "adzuna"), R, CUTOFF, {})
            self.assertEqual((src["ok"], src["error"]), (False, error), reply)

    def test_read_once_per_slot_and_held_over_between(self):
        self.assertTrue(s.is_slow(("feed", "adzuna")))
        prev = dict(sources=[dict(name="Adzuna", kind="Job boards"), dict(name="Himalayas", kind="Job boards")],
                    jobs=[row(source="Adzuna"), row(source="Himalayas")])
        held, rows = s.held_over(prev)
        self.assertEqual(([h["name"] for h in held], [j["source"] for j in rows]), (["Adzuna"], ["Adzuna"]))

    def test_the_companys_own_board_wins_over_adzuna(self):
        listed = row(company="Acme Inc.", source="Adzuna", url="https://www.adzuna.com/land/ad/1")
        board = row(company="Acme", url="https://boards.greenhouse.io/acme/jobs/1")
        for rows in ([listed, board], [board, listed]):
            [j] = s.merge(rows, {}, NOW, CUTOFF, own={label for label, _, _ in sources.BOARDS.values()})
            self.assertEqual((j["source"], j["url"]), ("Greenhouse", board["url"]))


if __name__ == "__main__":
    unittest.main()
