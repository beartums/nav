import datetime as dt
import unittest

import chores

# 2026-10-12 15:00 in New York (EDT, UTC-4).
NOW = dt.datetime(2026, 10, 12, 19, 0, tzinfo=dt.timezone.utc)
NY = "America/New_York"
MEMBERS = [{"userId": 1, "username": "evan", "displayName": "Evan"},
           {"userId": 2, "username": "sam", "displayName": ""}]


def chore(i, name, due, **kw):
    return {"id": i, "name": name, "nextDueDate": due, "isActive": True, **kw}


class Chores(unittest.TestCase):
    def items(self, cs, horizon="week", person="", public="https://dt.x"):
        return chores.chore_items(cs, MEMBERS, NOW, NY, horizon, person, public)

    def test_days_are_the_households_not_utcs(self):
        # 8pm tonight in New York is 00:00 tomorrow in UTC: still "Today".
        items, _ = self.items([chore(1, "Bins", "2026-10-13T00:00:00Z", assignedTo=1)])
        self.assertEqual(items[0]["section"], "Today")
        self.assertEqual(items[0]["sub"], "Evan · 8 PM")
        self.assertEqual(items[0]["url"], "https://dt.x/chores/1")

    def test_sections_order_and_overdue(self):
        cs = [chore(1, "Later", "2026-10-30T16:00:00Z"),
              chore(2, "Week", "2026-10-15T16:00:00Z"),
              chore(3, "Late", "2026-10-10T16:00:00Z", assignedTo=2),
              chore(4, "Undated", None)]
        items, overdue = self.items(cs, horizon="all")
        self.assertEqual([i["label"] for i in items], ["Late", "Week", "Later", "Undated"])
        self.assertEqual([i["section"] for i in items], ["Overdue", "This week", "Later", "Any time"])
        self.assertEqual(overdue, 1)
        self.assertEqual(items[0]["badge"], {"text": "Overdue", "level": "crit"})
        self.assertTrue(items[0]["sub"].startswith("sam · Oct 10"), items[0]["sub"])
        self.assertEqual(chores.note(overdue, len(items)), "1 overdue")

    def test_horizons(self):
        cs = [chore(1, "Late", "2026-10-11T16:00:00Z"), chore(2, "Now", "2026-10-12T20:00:00Z"),
              chore(3, "Fri", "2026-10-16T16:00:00Z"), chore(4, "Next month", "2026-11-20T16:00:00Z")]
        self.assertEqual([i["label"] for i in self.items(cs, "today")[0]], ["Late", "Now"])
        self.assertEqual([i["label"] for i in self.items(cs, "week")[0]], ["Late", "Now", "Fri"])

    def test_person_status_points_and_inactive(self):
        cs = [chore(1, "Mine", "2026-10-12T20:00:00Z", assignedTo=1, points=3, status=1),
              chore(2, "Sams", "2026-10-12T20:00:00Z", assignees=[{"userId": 2}]),
              chore(3, "Gone", "2026-10-12T20:00:00Z", assignedTo=1, isActive=False)]
        items, _ = self.items(cs, person="EVAN")
        self.assertEqual([i["label"] for i in items], ["Mine"])
        self.assertEqual(items[0]["badge"], {"text": "In progress", "level": "good"})
        self.assertIn("3 pts", items[0]["sub"])
        self.assertEqual([i["label"] for i in self.items(cs, person="sam")[0]], ["Sams"],
                         "a lone assignee counts, and a username matches")

    def test_unassigned_without_members_and_no_public_link(self):
        items, _ = chores.chore_items([chore(1, "X", "2026-10-12T20:00:00Z", assignedTo=1)],
                                      None, NOW, NY, "week", "", "")
        self.assertTrue(items[0]["sub"].startswith("Unassigned"))
        self.assertNotIn("url", items[0])

    def test_bad_zone_is_a_clear_error(self):
        with self.assertRaisesRegex(ValueError, "unknown time zone"):
            chores.zone("Mars/Olympus")


if __name__ == "__main__":
    unittest.main()
