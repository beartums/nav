import unittest

import week


class Week(unittest.TestCase):
    def test_weather_by_day(self):
        p = {"data": {"daily": [{"date": "2026-10-18", "hi": 64, "lo": 51, "icon": "clear", "text": "Clear",
                                 "pop": 0, "sunrise": "x"}]}}
        self.assertEqual(week.weather_days(p), {"2026-10-18": {"icon": "clear", "hi": 64, "lo": 51, "text": "Clear",
                                                               "pop": 0}})
        self.assertEqual(week.weather_days(None), {})

    def test_events_say_which_widget_they_came_from(self):
        p = {"data": {"events": [{"date": "2026-10-19", "title": "Dog", "key": "k1", "can": ["done"]}, "junk"]}}
        self.assertEqual(week.events_of(p, 7), [{"date": "2026-10-19", "title": "Dog", "key": "k1", "can": ["done"],
                                                 "def": 7}])

    def test_span_is_what_every_source_covers(self):
        a = {"data": {"range": ["2026-09-10", "2026-12-20"]}}
        b = {"data": {"range": ["2026-10-01", "2026-12-30"]}}
        self.assertEqual(week.span([a, b, None, {"data": {}}]), ["2026-10-01", "2026-12-20"])
        self.assertIsNone(week.span([]))

    def test_problems_name_the_source(self):
        self.assertIn("no widget", week.problem("Chores", None))
        self.assertEqual(week.problem("X", {"error": "HTTP 500"}), "X: HTTP 500")
        self.assertIsNone(week.problem("X", {"data": {}}))


class DayUrl(unittest.TestCase):
    def test_from_the_inbox_link(self):
        self.assertEqual(week.day_url("https://cb.example/inbox?act_as=2"), "https://cb.example/calendar?date=")
        self.assertIsNone(week.day_url(""))


if __name__ == "__main__":
    unittest.main()
