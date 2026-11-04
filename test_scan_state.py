import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import scan_state as s
from test_fetch_jobs import NOW, days, row


class CarryOver(unittest.TestCase):
    def merge(self, rows, *old):
        return s.merge(rows, {"jobs": list(old)}, NOW, NOW - timedelta(days=90))

    def test_first_seen_follows_company_and_title_not_url(self):
        [j] = self.merge([row(url="https://x.test/new")], row(company="ACME", title="swe", first_seen=days(9)))
        self.assertEqual(j["first_seen"], days(9))
        [j] = self.merge([row()], row(title="Other", first_seen=days(9)))
        self.assertEqual(j["first_seen"], NOW.isoformat())

    def test_one_row_per_company_and_title_in_todays_shape(self):  # row() lacks the fields older data lacks
        [j] = self.merge([row(where=["US"]), row(company="ACME", title="swe", where=["Canada"])])
        self.assertEqual((j["where"], j["must"], j["nice"], j["salary"], j["mode"]), (["Canada", "US"], [], [], None, None))

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

    def test_one_job_written_two_ways_is_one_row(self):
        [j] = self.merge([row(title="Full-stack Engineer (Payments)"), row(title="Full Stack Engineer, Payments", where=["Canada"])])
        self.assertEqual((j["title"], j["where"]), ("Full-stack Engineer (Payments)", ["Canada", "US"]))
        [j] = self.merge([row(company="Samsara Inc.", source="The Muse"), row(company="Samsara")])
        self.assertEqual(j["company"], "Samsara Inc.")  # with no board named as the company's own, the first row stays

    def test_the_company_board_and_then_last_scans_row_win(self):
        muse, board = row(company="Proxify AB", source="The Muse", url="https://muse.test/1"), row(company="Proxify", url="https://acme.test/1")
        [j] = s.merge([muse, board], {}, NOW, NOW - timedelta(days=90), own={"Greenhouse"})
        self.assertEqual(j["url"], "https://acme.test/1")
        [j] = s.merge([board, muse], {"jobs": [dict(muse, first_seen=days(9))]}, NOW, NOW - timedelta(days=90), own={"Greenhouse"})
        self.assertEqual((j["url"], j["first_seen"]), ("https://muse.test/1", days(9)))  # its key, and so any tracker mark, holds still

    def test_sr_and_fullstack_spellings_are_one_job(self):
        self.assertEqual(len(self.merge([row(title="Sr. Fullstack Engineer"), row(title="Senior Full-Stack Engineer")])), 1)

    def test_when_the_kept_copy_goes_its_sibling_keeps_first_seen_and_title(self):
        gone = row(title="Full-stack Engineer 4", first_seen=days(20))  # last scan's copy, no longer listed
        [j] = self.merge([row(title="Full Stack Engineer 4", url="https://x.test/2")], gone)
        self.assertEqual((j["first_seen"], j["title"], j["url"]), (days(20), "Full-stack Engineer 4", "https://x.test/2"))
        [j] = self.merge([row(company="Samsara Inc.", source="The Muse")], row(company="Samsara", first_seen=days(20)))
        self.assertEqual((j["first_seen"], j["company"]), (days(20), "Samsara Inc."))  # another source's name stays its own

    def test_a_copy_past_the_cutoff_lets_a_fresh_one_stand_in(self):
        old = row(source="Workday", posted=days(95), first_seen=days(95))
        [j] = self.merge([old, row(company="Acme Inc.", source="The Muse", posted=days(5))], old)
        self.assertEqual((j["source"], j["posted"]), ("The Muse", days(5)))

    def test_different_jobs_stay_apart(self):
        for a, b in [("Engineer I", "Engineer II"), ("C++ Engineer", "C# Engineer"), ("Senior Engineer", "Senior Engineer, Labs")]:
            self.assertEqual(len(self.merge([row(title=a), row(title=b)])), 2, (a, b))
        self.assertEqual(len(self.merge([row(company="Acme"), row(company="Acme Labs")])), 2)

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
            path.with_name("older.js").write_text(s.OLDER + '{"generated_at": "x", "jobs": [{"title": "Old"}]};\n')
            self.assertEqual(s.load_previous(path), {"jobs": [{"title": "Old"}]})  # older.js's rows come back
