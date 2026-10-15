import datetime as dt
import unittest

import openchore

TODAY = dt.date(2026, 10, 13)   # a Tuesday
TOBY = {"id": 2, "name": "Toby", "role": "child", "paused": False}
CASS = {"id": 3, "name": "Caroline", "role": "child", "paused": False}


def chore(title, **kw):
    return {"schedule_id": 1, "chore_id": 1, "title": title, "points_value": 5,
            "completed": False, "expired": False, "available": True, "date": "2026-10-13", **kw}


class OpenChore(unittest.TestCase):
    def test_today_heads_per_person_with_points_and_todo_first(self):
        by_user = [(TOBY, [chore("Dishes", completed=True, completion_status="approved"),
                             chore("Walk the dog", icon="🐕", due_by="18:00")], 42),
                   (CASS, [chore("Bins", expired=True)], None)]
        items, done, total = openchore.chore_items(by_user, "today", TODAY, "https://oc.x")
        self.assertEqual([i["label"] for i in items], ["🐕 Walk the dog", "Dishes", "Bins"])
        self.assertEqual(items[0]["section"], "Toby · 42 pts")
        self.assertEqual(items[0]["sub"], "by 6 PM · 5 pts")
        self.assertEqual(items[1]["badge"], {"text": "Done", "level": "good"})
        self.assertEqual(items[2]["section"], "Caroline", "no points: no ' · pts'")
        self.assertEqual(items[2]["badge"], {"text": "Missed", "level": "crit"})
        self.assertEqual(items[0]["url"], "https://oc.x/")
        self.assertEqual((done, total), (1, 3))
        self.assertEqual(openchore.note(done, total), "2 left of 3")

    def test_week_heads_per_day_with_the_person(self):
        by_user = [(TOBY, [chore("Walk the dog", date="2026-10-14"), chore("Past", date="2026-10-12"),
                             chore("Too far", date="2026-10-20")], 0),
                   (CASS, [chore("Walk the dog", date="2026-10-13", available=False, available_at="16:00")], 0)]
        items, _, _ = openchore.chore_items(by_user, "week", TODAY, "")
        self.assertEqual([i["section"] for i in items], ["Today", "Tomorrow"])
        self.assertEqual(items[0]["sub"], "Caroline · from 4 PM · 5 pts")
        self.assertNotIn("url", items[0])

    def test_states(self):
        self.assertEqual(openchore.state(chore("x", completion_status="pending"))[1]["text"], "Awaiting approval")
        self.assertEqual(openchore.state(chore("x", completion_status="excused"))[1]["text"], "Excused")
        _, badge, extra = openchore.state(chore("x", completed=True, completed_by_sibling=True,
                                                completed_by_name="Mom"))
        self.assertEqual((badge["text"], extra), ("Done", "by Mom"))

    def test_people_skips_paused_and_narrows(self):
        users = [TOBY, CASS, {"id": 4, "name": "Away", "paused": True}, {"name": "no id"}]
        self.assertEqual([u["name"] for u in openchore.people(users, "")], ["Toby", "Caroline"])
        self.assertEqual([u["name"] for u in openchore.people(users, "caroline")], ["Caroline"])

    def test_note(self):
        self.assertEqual(openchore.note(0, 0), "nothing scheduled")
        self.assertEqual(openchore.note(2, 2), "all done")


if __name__ == "__main__":
    unittest.main()
