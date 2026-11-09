"""Self-checks for reading a posting (extract.py) and for one whole scan (fetch_jobs.main). Run: python3 -m unittest

The rules are in test_rules.py, the source parsers in test_sources.py; both share the helpers here."""
import json
import os
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

import extract as x
import fetch_jobs as f
import rules
import scan_state as s
import sources

R = rules.load_rules()
NOW = sources.NOW
CUTOFF = NOW - timedelta(days=30)
DESC = ("&lt;p&gt;5+ years of backend experience with Java, Kafka, AWS, Kubernetes, PostgreSQL "
        "and Go, gRPC. Payments domain.&lt;/p&gt;")


def job(**kw):
    base = dict(title="Senior Backend Engineer", company="Acme", location="Vancouver, BC", url="https://x.test/1",
                posted=NOW.isoformat(), source="Greenhouse", description=DESC)
    return dict(base, **kw)


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

    def test_what_will_help_you_stand_out_is_nice_to_have(self):  # Toast's heading, in each order it comes in
        for head in ("What will help you stand out (Nonessential Skills/Nice to Haves)",
                     "What will help you standout (Nice to Haves/Non-Essential Skills)", "What will help you stand out:"):
            self.assertEqual(x.split_sections(f"Requirements\nJava\n{head}\nKafka")["nice"][1:], ["Kafka"], head)

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
                           "Requirements\nUp to two years of Go": None, "Requirements\nA two year degree": None,
                           "Requirements\n18+ years leading sales teams": 18, "Requirements\n25+ years in banking": None,
                           "Requirements\n2+ years in retail\nYou are at least 18 years of age.": 2,  # an age, not experience
                           "Requirements\nMust be 18 years or older": None, "Requirements\n16 years or over": None,
                           "Great team.\nYou must be 18 years of age or older with retail experience.": None,
                           "Requirements\n5 years of agency experience": 5}.items():
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
                     "Equity grant of $100,000 - $200,000 in stock", "$2,000 - $3,000 per month", "Salary: $0k - $10k",
                     "Pay: $80 - $120 per session", "Pay range: $150 - $200 per visit"):  # clinical pay per patient seen
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

    def test_associate_and_professional_degrees(self):
        for body, level in (("Requirements\nAssociate degree or higher", "associate"),
                            ("Requirements\nAssociate's or Bachelor's degree", "associate"),
                            ("Requirements\nJD from an accredited law school", "professional"),
                            ("Requirements\nJuris Doctorate required", "professional"),  # also reads as a doctorate
                            ("Requirements\nMD/DO, board certified", "professional"),
                            ("Requirements\nDoctor of Nursing Practice (DNP)", "professional"),
                            ("Requirements\nPharmD or PhD", "professional"), ("Requirements\nMaster's or JD", "master")):
            self.assertEqual(x.degree(x.split_sections(body))["level"], level, body)
        for body in ("Requirements\nWork with our associates daily", "Requirements\nJD Edwards ERP", "Requirements\nJava\n#LI-DNP",
                     "Requirements\nYou've debugged DDS/middleware issues"):
            self.assertIsNone(x.degree(x.split_sections(body)), body)


def row(**kw):
    base = dict(title="SWE", company="Acme", where=["US"], url="https://x.test/1", posted=NOW.isoformat(),
                source="Greenhouse", posted_approx=False)
    return dict(base, **kw)


def days(n):
    return (NOW - timedelta(days=n)).isoformat()


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
            self.fresh, self.older = s.read_js(out, s.PREFIX), s.read_js(Path(d) / "older.js", s.OLDER)
            return s.load_previous(out), json.loads((Path(d) / "scan.json").read_text()), tasks

    def test_open_slot_runs_everything_and_writes_the_contract(self):
        data, scan, tasks = self.scan({})
        self.assertEqual(data["slow_fetched_at"], NOW.isoformat())
        self.assertTrue(any(s.is_slow(t) for t in tasks))
        self.assertEqual(scan, {"generated_at": data["generated_at"], "jobs": len(data["jobs"])})
        exported, cfg = data["rules"], rules.load_rules()["cfg"]  # config.json, so setting scan_url keeps scans running
        self.assertEqual((exported["max_age_days"], exported["scan_url"], exported["levels"][0][0], exported["families"][0][0]),
                         (cfg["max_age_days"], cfg["scan_url"], "C-level", "Full stack"))
        self.assertEqual((exported["backend"], exported["frontend"]), (sorted(rules.BACKEND), sorted(rules.FRONTEND)))
        self.assertEqual((exported["ladder"][0], exported["ladder"][-1], exported["roles"][0], exported["segment"]),
                         ("Intern", "C-level", list(rules.ROLES[0]), rules.SEGMENT))
        self.assertEqual((exported["fields"]["Cybersecurity"], exported["fields"]["Other"]), ("IT & security", "Other"))

    def test_rows_older_than_30_days_go_to_older_js_and_come_back_next_scan(self):
        prev = dict(slow_fetched_at=days(0), sources=[],
                    jobs=[row(source="Workday", title=t, posted=days(n), first_seen=days(n)) for t, n in (("Old", 40), ("New", 29))])
        data, scan, _ = self.scan(prev)
        fresh, older = ({j["title"] for j in d["jobs"]} for d in (self.fresh, self.older))
        self.assertEqual((older, "New" in fresh, "Old" in fresh), ({"Old"}, True, False))
        self.assertEqual((self.older["generated_at"], scan["jobs"]), (self.fresh["generated_at"], len(fresh) + 1))
        self.assertIn("Old", {j["title"] for j in data["jobs"]})  # load_previous() reads both files

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

    def test_a_failed_detail_call_finds_last_scans_row_under_another_spelling(self):
        down = mock.Mock(side_effect=OSError("detail call failed"))
        old = row(title="Full-stack Engineer", first_seen=days(3))  # the spelling the last scan kept
        with mock.patch.dict(f.FEEDS, fake=("Fake", lambda: [job(title="Full Stack Engineer", description=down)], "https://x.test")):
            src, rows = f.run_source(("feed", "fake"), R, CUTOFF, {s.same_job(old): old})
        self.assertEqual(rows, [old])

    def test_adzuna_waits_for_both_keys(self):  # before the secrets exist: no calls, and nothing on How it works
        with mock.patch.dict(os.environ, ADZUNA_APP_ID="test-app-id", ADZUNA_APP_KEY=""):
            data, _, tasks = self.scan({})
        self.assertEqual((("feed", "adzuna") in tasks, "adzuna" in {x["name"] for x in data["sources"]}), (False, False))
        with mock.patch.dict(os.environ, ADZUNA_APP_ID="test-app-id", ADZUNA_APP_KEY="test-app-key"):  # placeholders
            data, _, tasks = self.scan({})
        self.assertEqual((("feed", "adzuna") in tasks, "adzuna" in {x["name"] for x in data["sources"]}), (True, True))

    def test_a_lone_surrogate_does_not_stop_the_scan(self):
        data, _, _ = self.scan({}, company="Acme \ud83d")
        self.assertEqual(data["jobs"][0]["company"], "Acme ?")


if __name__ == "__main__":
    unittest.main()
