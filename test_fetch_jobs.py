"""Self-checks for the rules and source parsers. Run: python3 -m unittest"""
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import extract as x
import fetch_jobs as f
import scan_state as s

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
    def test_boundaries_and_lookalikes(self):
        for text, name, found in (("JavaScript and TypeScript", "Java", False), ("PostgreSQL", "SQL", False),
                                  ("the rest of the team", "REST APIs", False), ("REST and gRPC", "REST APIs", True),
                                  ("Modern C++ experience", "C++", True), ("Java, Go, Rust", "Go", True),
                                  ("services written in Go.", "Go", True), ("Golang", "Go", True),
                                  ("Go-to-market team. Go beyond the basics.", "Go", False),
                                  ("event-driven payment rails", "Ruby on Rails", False),
                                  ("payment tracking via SWIFT GPI", "SWIFT", True),
                                  ("payment tracking via SWIFT GPI", "Swift", False)):
            self.assertEqual(name in f.skills(R["kw"], text), found, (text, name))


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
        for args, want in {("FullTime", "", ""): "Full-time", ("full_time", "", ""): "Full-time",
                           ("Short Term", "", ""): "Contract", ("PartTime", "", ""): "Part-time",
                           (None, "Backend Engineer (Contract)", ""): "Contract", (None, "SWE", "Great team."): "Not specified",
                           (None, "Engineer", "We write smart contracts. This is a full-time role."): "Full-time",
                           (None, "Engineer", "This is a 6-month contract."): "Contract"}.items():
            self.assertEqual(f.job_type(*args), want, args)

    def test_dates(self):
        self.assertEqual((f.when("October 30, 2026").day, f.when("Mon, 02 Nov 2026 17:00:19 +0000").month,
                          f.when(1793636892).year, f.days_ago("Posted 30+ Days Ago"), f.days_ago("Posted Yesterday")),
                         (30, 11, 2026, 31, 1))


class Classify(unittest.TestCase):
    def test_level(self):
        for title, want in {"Senior Backend Engineer": "Senior", "Staff Software Engineer": "Staff+",
                            "Software Engineer II": "Mid", "Software Engineer I": "Junior",
                            "Tech Lead, Payments": "Senior", "AI Engineer": "Mid", "Staff Engineer": "Staff+",
                            "Member of Technical Staff": "Mid", "Senior Member of Technical Staff": "Senior",
                            "Principal Member of Technical Staff": "Staff+"}.items():
            self.assertEqual(f.level(title), want, title)

    def test_family(self):  # security is checked before AI and cloud
        for title, found, want in (("Senior Backend Engineer, Data Platform", set(), "Backend"),
                                   ("Software Engineer, Payments", set(), "Backend"),
                                   ("Senior Frontend Engineer", set(), "Frontend"),
                                   ("Software Engineer", {"Java", "Kafka", "React"}, "Backend"),
                                   ("Software Engineer", {"Java", "Kafka", "React", "Redux"}, "Full stack"),
                                   ("Software Engineer", set(), "General"), ("AI Security Engineer", set(), "Security"),
                                   ("Cloud Security Engineer", set(), "Security"),
                                   ("Backend Engineer, Security", set(), "Backend")):
            self.assertEqual(f.family(title, found), want, title)


class RichText(unittest.TestCase):
    def test_rich_text(self):
        escaped = "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Java &amp;amp; Go&lt;/li&gt;&lt;/ul&gt;"
        for html, want in {escaped: "Requirements\nJava & Go", "<p>Use <b>Java</b><br/>daily</p>": "Use Java\ndaily",
                           "Stack • Java • Go": "Stack\nJava\nGo", None: "",
                           "Master’s or Bachelor&rsquo;s": "Master's or Bachelor's"}.items():
            self.assertEqual(x.rich_text(html), want, html)


class Sections(unittest.TestCase):
    def test_split(self):
        sec = x.split_sections("About the role\nBuild payment rails.\nRequirements\n5+ years of Java.\n"
                               "Kafka is a plus.\nNice to have\nGo\nBenefits\nHealth insurance")
        self.assertEqual(sec, dict(must=["Requirements", "5+ years of Java."], soft=["Kafka is a plus."],
                                   nice=["Nice to have", "Go"],
                                   other=["About the role", "Build payment rails.", "Benefits", "Health insurance"]))

    def test_inline_nice_note_continues_and_boilerplate_ends_a_section(self):
        sec = x.split_sections("Requirements\nJava\nNice to have: Kubernetes\nAWS\nWe are an equal opportunity employer\nKafka")
        self.assertEqual((sec["nice"], "AWS" in sec["must"], "Kafka" in sec["must"]), (["Kubernetes"], True, False))

    def test_ampersand_and_bare_bonus_headings(self):
        heads = ("Skills & Experience", "Education & Experience", "Bonus", "Bonuses", "Bonus eligibility")
        self.assertEqual([x.heading(h)[0] for h in heads], ["must", "must", "nice", "nice", None])
        self.assertEqual(x.split_sections("Requirements\nJava\nBonus\nKafka")["nice"], ["Bonus", "Kafka"])

    def test_desirable_skills_as_the_only_list_is_required(self):
        sec = x.split_sections("Desirable skills\nGo\nRust")
        self.assertEqual(("Go" in sec["must"], sec["nice"]), (True, []))

    def test_tier_skills(self):
        sec = x.split_sections("About the team\nWe use Redis\nRequirements\nJava and Kafka\nNice to have\nGo and Kafka")
        names = ["Java", "Go", "React", "Kafka", "Redis"]
        must, nice = x.tier_skills(names, "React Engineer", sec, R["kw"])
        self.assertEqual((must, nice), (["Java", "React", "Kafka"], ["Go"]))


class Years(unittest.TestCase):
    def test_years_min(self):
        for body, want in {"Requirements\n7+ years building distributed systems": 7,
                           "Requirements\n3+ years of Java\n5+ years of Go": 5,
                           "Requirements\n5+ years with a Bachelor's or 3+ years with a Master's": 3,  # lowest bar
                           "Requirements\nJava\nNice to have\n10+ years of Go": None,
                           "Requirements\nOur company has shipped for over 12 years": None,
                           "Great team.\nWe want 5+ years of backend experience.": 5,  # no sections: plain statements
                           "Great team.\nWe have 5+ years of history.": None,
                           "Requirements\nA BS plus five (5) years of experience": 5, "Requirements\n10+ YoE in product": 10,
                           "Requirements\nFive or more years of Go": 5, "Requirements\nOne year of Java": 1,
                           "Requirements\nUp to two years of Go": None, "Requirements\nA two year degree": None}.items():
            self.assertEqual(x.years_min(x.split_sections(body)), want, body)


class Salary(unittest.TestCase):
    def test_ranges(self):
        cases = {"The salary range is $150,000 - $200,000 USD per year.": (150000, 200000, "USD", "year"),
                 "Base salary: $150-200k": (150000, 200000, "USD", "year"),
                 "Pay range: US$120,000 to US$140,000": (120000, 140000, "USD", "year"),
                 "Compensation: CA$120,000 - CA$150,000": (120000, 150000, "CAD", "year"),
                 "Hourly pay: $50 - $70 per hour": (50, 70, "USD", "hour"),
                 "$129,300/year in our lowest geographic market up to $223,600/year": (129300, 223600, "USD", "year"),
                 "The base salary is $180,000 per year.": (180000, 180000, "USD", "year")}
        for body, (lo, hi, cur, per) in cases.items():
            self.assertEqual(x.salary(body, ["US"]), dict(min=lo, max=hi, cur=cur, per=per), body)
        body = "Salary range: $150,000 - $180,000 in Austin\nSalary range: $170,000 - $200,000 in New York"  # regions merge
        self.assertEqual(x.salary(body, ["US"]), dict(min=150000, max=200000, cur="USD", per="year"))
        self.assertEqual(x.salary(body, ["Canada"])["cur"], "CAD")  # Canada only defaults to CAD

    def test_money_that_is_not_pay(self):
        for body in ("We raised $50M - $100M from investors.", "Great team.", "$5,000 - $10,000 signing bonus",
                     "Equity grant of $100,000 - $200,000 in stock", "$2,000 - $3,000 per month", "Salary: $0k - $10k"):
            self.assertIsNone(x.salary(body, ["US"]), body)

    def test_labels_on_the_line_above_count_and_asides_do_not(self):
        body = ("The typical starting salary range is:\n$138,200 — $218,600 USD\nThe typical starting Target Variable range"
                " is:\n$46,000 — $72,800 USD\nThe typical starting On-Target Earnings (OTE) range is:\n$184,200 — $291,400")
        self.assertEqual(x.salary(body, ["US"]), dict(min=138200, max=218600, cur="USD", per="year"))  # Elastic
        body = "The US base salary range for this position (this does not include bonus or equity): $147,000 — $183,000"
        self.assertEqual(x.salary(body, ["US"]), dict(min=147000, max=183000, cur="USD", per="year"))  # Flexport

    def test_structured_pay(self):
        self.assertEqual(x.structured_pay(9e4, 1e5, "USD", "1 YEAR"), dict(min=90000, max=100000, cur="USD", per="year"))
        self.assertEqual(x.structured_pay(75600, 103950, "USD", "per-year-salary")["per"], "year")
        self.assertEqual(x.structured_pay(50, 70, "CAD", "1 HOUR")["per"], "hour")
        self.assertIsNone(x.structured_pay(2000, 3000, "USD", "1 WEEK"))
        self.assertIsNone(x.structured_pay(None, None, None, None))
        for lo, hi in ((258, 386), (195, 415000), (230000000, 315000000)):  # keyed in thousands, or not USD-sized
            self.assertIsNone(x.structured_pay(lo, hi, "USD", "1 YEAR"), (lo, hi))


class WorkMode(unittest.TestCase):
    def test_structured_field_then_title_and_location(self):
        for args, want in {("OnSite", "SWE", "Remote"): "On-site", ("hybrid", "SWE", "NYC"): "Hybrid",
                           ("unspecified", "SWE", "Remote - US"): "Remote", (None, "SWE (Remote)", "NYC"): "Remote",
                           (None, "SWE", "Hybrid - Toronto"): "Hybrid", (None, "SWE", "NYC"): None}.items():
            self.assertEqual(x.work_mode(*args, "Great team."), want, args)
        self.assertEqual(x.work_mode(None, "SWE", "Flexible / Remote", "Great team."), "Remote")  # The Muse's label
        self.assertEqual(x.work_mode(None, "SWE", "Flexible / Remote", "In the office 3 days a week."), "Hybrid")  # is weak

    def test_body(self):
        for body, want in {"#LI-Hybrid": "Hybrid", "You will be in the office 3 days a week.": "Hybrid",
                           "This role is based on-site.": "On-site", "We are a remote-first company.": "Remote",
                           "Experience with hybrid cloud.": None, "It requires in-person 5 days a week.": "On-site",
                           "You will work from the office 5 days a week.": "On-site",
                           "In-office, typically three to five days per week.": "Hybrid"}.items():
            self.assertEqual(x.work_mode(None, "SWE", "NYC", body), want, body)


class Degree(unittest.TestCase):
    def test_degree(self):
        for body, level, req in (("Requirements<br>Bachelor's degree in CS", "bachelor", "required"),
                                 ("Requirements<br>BS or MS in CS", "bachelor", "required"),  # lowest named is the bar
                                 ("Requirements<br>Bachelor's degree or equivalent experience", "bachelor", "preferred"),
                                 ("Requirements<br>Java<br>Nice to have<br>Master's degree in CS", "master", "preferred"),
                                 ("Requirements<br>Master’s degree in CS", "master", "required"),
                                 ("Requirements<br>Master's or PhD in CS", "master", "required"),
                                 ("Requirements<br>Master's/ PhD degree", "master", "required")):
            self.assertEqual(x.degree(x.split_sections(x.rich_text(body))), dict(level=level, req=req), body)
        for body in ("Requirements\nJava", "Requirements\n10+ YoE (post-BS/MS) in a product role"):
            self.assertIsNone(x.degree(x.split_sections(body)), body)


class Evaluate(unittest.TestCase):
    def test_keeps_and_tags(self):
        row = f.evaluate(job(), R, CUTOFF)
        self.assertEqual(row["skills"], ["Java", "Go", "gRPC", "Kafka", "AWS", "Kubernetes", "PostgreSQL", "Payments"])
        self.assertEqual([row[k] for k in ("where", "years_required", "applicants", "type", "level", "role")],
                         [["Canada"], 5, None, "Not specified", "Senior", "Backend"])

    def test_extracted_fields_and_must_and_nice_are_subsets_of_skills(self):
        body = ("<p>We use AWS.</p><p>Requirements</p><ul><li>5+ years of Java</li><li>Bachelor's degree in CS</li></ul>"
                "<p>Nice to have</p><ul><li>Kafka</li></ul>"
                "<p>Salary range: $150,000 - $200,000 USD per year. This is a hybrid role.</p>")
        row = f.evaluate(job(title="Backend Engineer", description=body), R, CUTOFF)
        self.assertEqual([row[k] for k in ("must", "nice", "years_required", "salary", "mode", "degree", "posted_approx")],
                         [["Java"], ["Kafka"], 5, dict(min=150000, max=200000, cur="USD", per="year"), "Hybrid",
                          dict(level="bachelor", req="required"), False])
        self.assertEqual(set(row["skills"]) - set(row["must"]) - set(row["nice"]), {"AWS"})

    def test_adapter_fields_win_over_the_body(self):
        pay = dict(min=100000, max=110000, cur="USD", per="year")
        row = f.evaluate(job(mode="Remote", salary=pay, posted_approx=True,
                             description="Salary range: $150,000 - $200,000. This is a hybrid role."), R, CUTOFF)
        self.assertEqual((row["mode"], row["salary"], row["posted_approx"]), ("Remote", pay, True))

    def test_rules_reject(self):
        for kw in (dict(title="Engineering Manager, Payments"), dict(title="Account Executive"),
                   dict(title="Software Engineer Internships - Summer 2027"), dict(location="Berlin, Germany"),
                   dict(posted=(NOW - timedelta(days=60)).isoformat()), dict(url="javascript:alert(1)")):
            self.assertIsNone(f.evaluate(job(**kw), R, CUTOFF), kw)
        self.assertIsNotNone(f.evaluate(job(description="Ruby and Rails"), R, CUTOFF))  # every technology is kept

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
            "workplaceType": "hybrid", "country": "CA", "description": "<div>Java</div>",
            "lists": [{"text": "Requirements", "content": "<li>Kafka</li>"}], "additional": "<div>Pay</div>",
            "salaryRange": {"min": 75600, "max": 103950, "currency": "USD", "interval": "per-year-salary"}}]])
        self.assertEqual((j["type"], f.where(j["location"])), ("Permanent", ["Canada"]))
        self.assertEqual(j["mode"], "hybrid")
        self.assertEqual(j["salary"], dict(min=75600, max=103950, cur="USD", per="year"))
        self.assertEqual(x.rich_text(j["description"]), "Java\nRequirements\nKafka\nPay")

    def test_ashby_hybrid_is_not_remote_and_pays_in_its_home_currency(self):
        pay = lambda cur, lo, hi: {"components": [  # noqa: E731
            {"compensationType": "EquityPercentage", "interval": "NONE", "currencyCode": None, "minValue": None},
            {"compensationType": "Salary", "interval": "1 YEAR", "currencyCode": cur, "minValue": lo, "maxValue": hi}]}
        [j] = self.run_with(f.ashby, "x", "X", payloads=[{"jobs": [{
            "title": "SWE", "jobUrl": "https://jobs.ashbyhq.com/x/1", "publishedAt": "2026-10-30T00:00:00Z",
            "employmentType": "FullTime", "location": "San Francisco", "secondaryLocations": [], "isRemote": True,
            "workplaceType": "Hybrid", "address": {"postalAddress": {"addressCountry": "United States"}},
            "descriptionHtml": "<p>Java</p>", "descriptionPlain": "Java", "compensation": {"compensationTiers": [
                pay("CAD", 295000, 535000), pay("USD", 205000, 380000), pay("USD", 175000, 325000)]}}]}])
        self.assertEqual((f.where(j["location"]), j["mode"], j["description"]), (["US"], "Hybrid", "<p>Java</p>"))
        self.assertEqual(j["salary"], dict(min=175000, max=380000, cur="USD", per="year"))  # USD tiers, not the first

    def test_ashby_asks_for_compensation(self):
        with mock.patch.object(f, "fetch", return_value=b'{"jobs": []}') as fetch:
            f.ashby("x", "X")
        self.assertIn("includeCompensation=true", fetch.call_args.args[0])

    def test_smartrecruiters_fetches_description_lazily(self):
        [j] = self.run_with(f.smartrecruiters, "Acme", "Acme", payloads=[
            {"totalFound": 1, "content": [{"id": "7", "name": "Software Engineer", "releasedDate": "2026-10-30T00:00:00Z",
                                           "typeOfEmployment": {"label": "Full-time"},
                                           "location": {"fullLocation": "Austin, Texas, United States", "country": "us",
                                                        "remote": True, "hybrid": False}}]},
            {"jobAd": {"sections": {"jobDescription": {"title": "Job Description", "text": "Kafka"},
                                    "qualifications": {"title": "Qualifications", "text": "Java"}}}}])
        self.assertEqual((j["url"], f.where(j["location"]), j["mode"]), ("https://jobs.smartrecruiters.com/Acme/7",
                                                                         ["US", "Remote"], "Remote"))
        self.assertEqual(x.rich_text(j["description"]), "Job Description\nKafka\nQualifications\nJava")

    def test_smartrecruiters_hybrid(self):
        posting = {"id": "7", "name": "SWE", "location": {"fullLocation": "Austin", "remote": True, "hybrid": True}}
        [j] = self.run_with(f.smartrecruiters, "Acme", "Acme", payloads=[
            {"totalFound": 1, "content": [posting]}, {"jobAd": {"sections": {}}}])
        self.assertEqual(j["mode"], "Hybrid")

    def test_amazon_keeps_basic_and_preferred_apart(self):
        jobs = self.run_with(f.amazon, payloads=[{"jobs": [{
            "title": "SDE", "job_path": "/jobs/1", "posted_date": "October 30, 2026", "description": "Build things",
            "basic_qualifications": "- 5+ years of Java<br/>- Linux", "preferred_qualifications": "- Kafka",
            "normalized_location": "Seattle, WA", "country_code": "USA"}]}, {"jobs": []}, {"jobs": []}])
        sec = x.split_sections(x.rich_text(jobs[0]["description"]))
        self.assertEqual(("- 5+ years of Java" in sec["must"], "- Kafka" in sec["nice"], "- Kafka" in sec["must"]),
                         (True, True, False))

    def test_workday_multi_location(self):
        [j] = self.run_with(f.workday, "acme.wd5/Ext", "Acme", payloads=[
            {"total": 1, "jobPostings": [{"title": "SWE", "externalPath": "/job/x/SWE_1", "locationsText": "2 Locations",
                                          "postedOn": "Posted 3 Days Ago"}]},
            {"jobPostingInfo": {"location": "Toronto, ON", "additionalLocations": ["Seattle, WA"],
                                "country": {"descriptor": "Canada"}, "timeType": "Full time", "jobDescription": "<p>Java</p>"}}])
        self.assertEqual(j["url"], "https://acme.wd5.myworkdayjobs.com/Ext/job/x/SWE_1")
        self.assertEqual((f.where(j["location"]), j["type"], j["posted_approx"]), (["Canada", "US"], "Full time", False))

    def test_workday_flags_30_plus_days_and_skips_an_untitled_posting(self):
        [j] = self.run_with(f.workday, "acme.wd5/Ext", "Acme", payloads=[
            {"total": 2, "jobPostings": [{"externalPath": "/job/x/JR_0"}, {"title": "SWE", "externalPath": "/job/x/SWE_1",
                                          "locationsText": "Seattle, WA", "postedOn": "Posted 30+ Days Ago"}]}, {"jobPostingInfo": {}}])
        self.assertIs(j["posted_approx"], True)

    def test_hackernews(self):
        [j] = self.run_with(f.hackernews, payloads=[
            {"hits": [{"title": "Ask HN: Who is hiring? (November 2026)", "objectID": "9"}]},
            {"children": [{"id": 11, "created_at": "2026-11-02T16:00:00Z",
                           "text": "Acme | Senior Backend Engineer, Designer | REMOTE (US) | Full-time<p>We use Java"},
                          {"id": 12, "text": "Not a job post"}]}])
        self.assertEqual((j["company"], j["title"], f.where(j["location"]), f.job_type(j["type"], "", "")),
                         ("Acme", "Senior Backend Engineer", ["US", "Remote"], "Full-time"))

    def test_weworkremotely(self):
        rss = (b"<rss><channel><item><title>Acme: Backend Engineer</title><region>USA Only</region>"
               b"<type>Contract</type><pubDate>Mon, 02 Nov 2026 07:31:15 +0000</pubDate>"
               b"<link>https://weworkremotely.com/x</link><description>Java</description></item></channel></rss>")
        jobs = self.run_with(f.weworkremotely, payloads=[rss, rss, rss])
        self.assertEqual((jobs[0]["company"], jobs[0]["title"], jobs[0]["type"]), ("Acme", "Backend Engineer", "Contract"))
        self.assertEqual(f.where(jobs[0]["location"]), ["US", "Remote"])


def row(**kw):
    base = dict(title="SWE", company="Acme", where=["US"], url="https://x.test/1", posted=NOW.isoformat(),
                source="Greenhouse", posted_approx=False)
    return dict(base, **kw)


def days(n):
    return (NOW - timedelta(days=n)).isoformat()


class CarryOver(unittest.TestCase):
    def merge(self, rows, *old):
        return s.merge(rows, {"jobs": list(old)}, NOW, NOW - timedelta(days=90))

    def test_first_seen_follows_company_and_title_not_url(self):
        [j] = self.merge([row(url="https://x.test/new")], row(company="ACME", title="swe", first_seen=days(9)))
        self.assertEqual(j["first_seen"], days(9))
        [j] = self.merge([row()], row(title="Other", first_seen=days(9)))
        self.assertEqual(j["first_seen"], NOW.isoformat())

    def test_one_row_per_company_and_title(self):
        [j] = self.merge([row(where=["US"]), row(company="ACME", title="swe", where=["Canada"])])
        self.assertEqual(j["where"], ["Canada", "US"])

    def test_workday_date_is_min_of_previous_and_new(self):
        new = row(source="Workday", posted=days(31), posted_approx=True)
        [j] = self.merge([new], row(source="Workday", posted=days(50), posted_approx=True, first_seen=days(19)))
        self.assertEqual((j["posted"], j["posted_approx"]), (days(50), True))
        [j] = self.merge([row(source="Workday", posted=days(40))], row(source="Workday", posted=days(5), first_seen=days(5)))
        self.assertEqual(j["posted"], days(40))
        [j] = self.merge([row(posted=days(3))], row(posted=days(20), first_seen=days(20)))
        self.assertEqual(j["posted"], days(3))  # other sources keep their own date

    def test_workday_flag_follows_the_date_it_came_with(self):
        new = row(source="Workday", posted=days(31), posted_approx=True)
        [j] = self.merge([new], row(source="Workday", posted=days(33), posted_approx=False, first_seen=days(33)))
        self.assertEqual((j["posted"], j["posted_approx"]), (days(33), False))
        old = row(source="Workday", posted=days(32), first_seen=days(2))
        del old["posted_approx"]  # written before the flag existed
        self.assertIs(self.merge([new], old)[0]["posted_approx"], True)

    def test_nothing_older_than_the_cutoff_survives(self):
        new = row(source="Workday", posted=days(31), posted_approx=True)
        self.assertEqual(self.merge([new], row(source="Workday", posted=days(91), first_seen=days(60))), [])
        held = row(source="Remotive", posted=days(91), first_seen=days(91))
        self.assertEqual(self.merge([held], held), [])
        self.assertEqual(len(self.merge([row(posted=None)])), 1)


class SlowGate(unittest.TestCase):
    def test_opens_once_per_six_hour_utc_slot(self):
        prev, opened = {"slow_fetched_at": "2026-11-01T23:00:00+00:00"}, 0
        for hour in range(24):
            now = datetime(2026, 11, 2, hour, 17, tzinfo=timezone.utc)
            if s.slot_open(prev, now):
                opened += 1
                prev = {"slow_fetched_at": now.isoformat()}
        self.assertEqual(opened, 4)
        self.assertTrue(s.slot_open({}, NOW))  # open with no previous slow fetch, closed right after one
        self.assertFalse(s.slot_open({"slow_fetched_at": NOW.isoformat()}, NOW))

    def test_slow_tasks(self):
        tasks = [("workday", "x"), ("smartrecruiters", "x"), ("workable", "x"), ("feed", "remotive"), ("feed", "jobicy")]
        self.assertTrue(all(map(s.is_slow, tasks)))
        self.assertFalse(any(map(s.is_slow, [("greenhouse", "workable"), ("feed", "himalayas")])))

    def test_held_over_returns_only_slow_rows_and_sources(self):
        prev = dict(sources=[dict(name="Remotive", kind="Job boards"), dict(name="Himalayas", kind="Job boards"),
                             dict(name="NVIDIA", kind="Workday"), dict(name="Ramp", kind="Greenhouse")],
                    jobs=[row(source="Workday"), row(source="Remotive"), row(source="Greenhouse"), row(source="Himalayas")])
        sources, jobs = s.held_over(prev)
        self.assertEqual([x["name"] for x in sources], ["Remotive", "NVIDIA"])
        self.assertEqual([j["source"] for j in jobs], ["Workday", "Remotive"])

    def test_load_previous(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "jobs.js"
            self.assertEqual(s.load_previous(path), {})
            path.write_text(s.PREFIX + '{"jobs": []};\n')
            self.assertEqual(s.load_previous(path), {"jobs": []})


class Main(unittest.TestCase):
    def scan(self, prev, fail=lambda task: False, company="Acme"):
        """One main() over a temp jobs.js, every source answering at once. -> (written data, scan.json, tasks run)."""
        tasks = []

        def source(task, r, cutoff, before):
            tasks.append(task)
            ok, kind = not fail(task), "Job boards" if task[0] == "feed" else "Greenhouse"
            return (dict(name=task[1], kind=kind, url=task[1], ok=ok, error="HTTP 429", seen=1, kept=1),
                    [row(title=f"SWE {task[1]}", company=company)] * ok)

        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "jobs.js"
            out.write_text(s.PREFIX + json.dumps(prev) + ";\n")
            with mock.patch.object(f, "OUT", out), mock.patch.object(f, "run_source", source), mock.patch("builtins.print"):
                f.main()
            return s.load_previous(out), json.loads((Path(d) / "scan.json").read_text()), tasks

    def test_open_slot_runs_everything_and_writes_the_contract(self):
        data, scan, tasks = self.scan({})
        self.assertEqual(data["slow_fetched_at"], NOW.isoformat())
        self.assertTrue(any(s.is_slow(t) for t in tasks))
        self.assertEqual(scan, {"generated_at": data["generated_at"], "jobs": len(data["jobs"])})
        rules, cfg = data["rules"], f.load_rules()["cfg"]  # config.json, so setting scan_url keeps scans running
        self.assertEqual((rules["max_age_days"], rules["scan_url"], rules["levels"][0][0], rules["families"][0][0]),
                         (cfg["max_age_days"], cfg["scan_url"], "Staff+", "Full stack"))
        self.assertEqual((rules["backend"], rules["frontend"]), (sorted(f.BACKEND), sorted(f.FRONTEND)))

    def test_closed_slot_skips_slow_sources_and_keeps_their_rows(self):
        prev = dict(slow_fetched_at=days(0), sources=[dict(name="NVIDIA", kind="Workday", url="", ok=True, seen=9, kept=1)],
                    jobs=[row(title="Gone", first_seen=days(3))] + [row(source="Workday", title=t, first_seen=days(3))
                                                                    for t in ("Held", "SWE himalayas")])
        data, _, tasks = self.scan(prev)
        rows = {j["title"]: j["source"] for j in data["jobs"]}
        self.assertFalse(any(s.is_slow(t) for t in tasks))
        self.assertEqual(data["slow_fetched_at"], prev["slow_fetched_at"])
        self.assertEqual((rows["Held"], rows["SWE himalayas"], "Gone" in rows), ("Workday", "Workday", False))
        self.assertIn("NVIDIA", {x["name"] for x in data["sources"]})

    def test_outage_exits_even_when_rows_are_held_over(self):
        prev = dict(slow_fetched_at=days(0), jobs=[row(source="Workday", first_seen=days(3))], sources=[])
        with self.assertRaises(SystemExit):
            self.scan(prev, fail=lambda task: True)

    def test_a_failed_source_keeps_its_name_and_rows_until_they_expire(self):
        prev = dict(slow_fetched_at=days(1), sources=[dict(name="Ramp ", kind="Greenhouse", url="ramp", ok=True),
                                                     dict(name="Remotive", kind="Job boards", url="remotive", ok=True)],
                    jobs=[row(company="Ramp", title="Kept", first_seen=days(3)), row(company="Other", title="Gone"),
                          row(company="Ramp", title="Expired", posted=days(91), first_seen=days(91)),
                          row(company="Ramp", title="Undated", posted=None, first_seen=days(91)),
                          row(source="Remotive", company="Any", title="Feed", first_seen=days(3))])
        data, _, _ = self.scan(prev, fail=lambda task: task[1] in ("ramp", "remotive"))
        rows, ran = {j["title"]: j for j in data["jobs"]}, {x["url"]: x for x in data["sources"]}
        self.assertEqual((rows["Kept"]["first_seen"], rows["Feed"]["first_seen"]), (days(3), days(3)))
        self.assertFalse({"Gone", "Expired", "Undated"} & set(rows))
        self.assertEqual((ran["ramp"]["name"], ran["ramp"]["ok"], ran["remotive"]["ok"]), ("Ramp ", False, False))
        self.assertEqual(data["slow_fetched_at"], NOW.isoformat())  # Remotive stays at 4 calls a day

    def test_a_failed_detail_call_keeps_last_scans_row(self):
        down = mock.Mock(side_effect=OSError("detail call failed"))
        old = row(title="Senior Backend Engineer", first_seen=days(3))
        raw = [job(title="Senior Backend Engineer ", description=down), job(title="Backend Engineer", description=down)]
        with mock.patch.dict(f.FEEDS, fake=("Fake", lambda: raw, "https://x.test")):
            src, rows = f.run_source(("feed", "fake"), R, CUTOFF, {s.job_key(old): old})
        self.assertEqual((rows, src["skipped"]), ([old], 2))

    def test_a_lone_surrogate_does_not_stop_the_scan(self):
        data, _, _ = self.scan({}, company="Acme \ud83d")
        self.assertEqual(data["jobs"][0]["company"], "Acme ?")


if __name__ == "__main__":
    unittest.main()
