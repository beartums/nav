import datetime as dt
import unittest

import chorecal

PEOPLE = [{"id": 1, "name": "Evan"}, {"id": 2, "name": "Toby"}, {"id": 3, "name": "Cara"}, {"id": 4, "name": "Chris"}]
CHORES = [{"id": 7, "title": "Walk the dog", "icon": "🐕"}]


def entry(date, person, **kw):
    return {"id": f"7:{date}:rule:{person}", "chore_id": 7, "date": date, "person_id": person, "available": None,
            "due": None, "skipped": False, "scheduled_person_id": None, "group_id": None, "outcome": None, **kw}


class ChoreCal(unittest.TestCase):
    def test_initials_disambiguate_shared_first_letters(self):
        self.assertEqual(chorecal.initials(PEOPLE), {1: "E", 2: "T", 3: "Ca", 4: "Ch"})

    def test_events_carry_person_colour_initial_and_plain_words(self):
        ev, legend = chorecal.events(
            [entry("2026-10-21", 2, available="16:00", due="18:00"),
             entry("2026-10-25", 1, scheduled_person_id=2, group_id="sw_x"),
             entry("2026-10-19", 2, outcome={"status": "failed"})], PEOPLE, CHORES)
        self.assertEqual([e["date"] for e in ev], ["2026-10-19", "2026-10-21", "2026-10-25"])
        mon, wed, sun = ev
        self.assertEqual((wed["title"], wed["sub"], wed["initial"]), ("🐕 Walk the dog", "Toby · 4–6 PM", "T"))
        self.assertEqual(sun["sub"], "Evan · instead of Toby · swapped")
        self.assertTrue(mon["struck"] and not mon["done"] and mon["sub"].endswith("missed"))
        self.assertEqual(wed["series"], 2, "stable by person id")
        self.assertEqual(legend, [{"label": "Evan", "series": 1, "id": 1}, {"label": "Toby", "series": 2, "id": 2}])
        self.assertEqual((wed["icon"], wed["who"], wed["name"], wed["detail"]), ("🐕", "Toby", "Walk the dog", "4–6 PM"))
        self.assertEqual(sun["detail"], "instead of Toby · swapped")

    def test_done_and_covered_are_done(self):
        ev, _ = chorecal.events([entry("2026-10-19", 2, outcome={"status": "done"}),
                                 entry("2026-10-20", 3, outcome={"status": "covered"})], PEOPLE, CHORES)
        self.assertTrue(all(e["done"] for e in ev))

    def test_mine_and_skipped(self):
        es = [entry("2026-10-19", 2), entry("2026-10-20", 3, skipped=True)]
        self.assertEqual([e["initial"] for e in chorecal.events(es, PEOPLE, CHORES, mine=2)[0]], ["T"])
        self.assertEqual(len(chorecal.events(es, PEOPLE, CHORES, include_skipped=False)[0]), 1)
        skipped = chorecal.events(es, PEOPLE, CHORES)[0][1]
        self.assertTrue(skipped["struck"] and skipped["sub"].endswith("skipped"))

    def test_window(self):
        self.assertEqual(chorecal.window(dt.date(2026, 10, 14)), ("2026-09-09", "2026-12-23"))


if __name__ == "__main__":
    unittest.main()


class Actions(unittest.TestCase):
    def test_events_carry_what_the_viewer_can_do(self):
        ev, _ = chorecal.events([entry("2026-10-21", 2, can=["done", "propose_swap"], cannot={"x": "y"},
                                       pending_swap={"id": 9, "side": "from", "from_person": 2, "to_person": 1,
                                                     "reason": "practice"}),
                                 entry("2026-10-22", 1, outcome={"status": "done", "id": 44})], PEOPLE, CHORES)
        wed, thu = ev
        self.assertEqual((wed["key"], wed["can"], wed["cannot"]), ("7:2026-10-21:rule:2", ["done", "propose_swap"], {"x": "y"}))
        self.assertEqual(wed["pending"], {"id": 9, "side": "from", "reason": "practice", "kind": "swap", "from": "Toby", "to": "Evan"})
        self.assertTrue(wed["sub"].endswith("swap pending"))
        self.assertEqual(thu["outcome_id"], 44)

    def test_swap_candidates_are_other_peoples_open_chores_from_today(self):
        es = [dict(entry("2026-10-21", 2), rule_id=1),
              dict(entry("2026-10-25", 1), rule_id=4),                                 # yes
              dict(entry("2026-10-26", 2), rule_id=1),                                 # Toby's own: no
              dict(entry("2026-10-27", 3), rule_id=2, outcome={"status": "done"}),     # recorded: no
              dict(entry("2026-10-28", 3), rule_id=2, pending_swap={"id": 1}),         # pending: no
              dict(entry("2026-10-29", 4), rule_id=None),                              # an extra: no
              dict(entry("2026-10-10", 1), rule_id=4)]                                 # past: no
        got = chorecal.candidates(es, "7:2026-10-21:rule:2", PEOPLE, CHORES, "2026-10-14")
        self.assertEqual([c["key"] for c in got], ["7:2026-10-25:rule:1"])
        self.assertEqual(got[0]["who"], "Evan")


class Covered(unittest.TestCase):
    def test_the_chip_shows_who_did_it_and_says_whose_it_was(self):
        ev, legend = chorecal.events([
            entry("2026-10-21", 2, outcome={"status": "covered", "done_by_id": 3, "id": 1}),
            entry("2026-10-22", 2, outcome={"status": "failed_covered", "done_by_id": 4, "id": 2}),
            entry("2026-10-23", 2, outcome={"status": "done", "done_by_id": 2, "id": 3})], PEOPLE, CHORES)
        cov, mc, done = ev
        self.assertEqual((cov["who"], cov["initial"], cov["series"]), ("Cara", "Ca", 3))
        self.assertEqual(cov["detail"], "covered for Toby")
        self.assertEqual(cov["covered"], {"for": "Toby", "missed": False})
        self.assertEqual((mc["who"], mc["detail"], mc["covered"]["missed"]), ("Chris", "Toby missed it; covered", True))
        self.assertFalse(mc.get("struck"), "it got done: not struck")
        self.assertEqual((done["who"], "covered" in done), ("Toby", False))
        self.assertEqual({l["label"] for l in legend}, {"Cara", "Chris", "Toby"})


class Undo(unittest.TestCase):
    def test_swap_group_and_pending_undo_pass_through(self):
        ev, _ = chorecal.events([entry("2026-10-21", 2, group_id="sw_abc",
                                       pending_swap={"id": 3, "kind": "undo", "side": "from", "from_person": 2, "to_person": 1})],
                                PEOPLE, CHORES)
        self.assertEqual((ev[0]["group"], ev[0]["pending"]["kind"]), ("sw_abc", "undo"))
        self.assertTrue(ev[0]["sub"].endswith("undo pending"))
