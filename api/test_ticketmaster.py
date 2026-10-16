import datetime as dt
import unittest

import ticketmaster as tm


def ev(name, date, time="19:30:00", status="onsale", segment="Sports", genre="Basketball", **start):
    return {"name": name, "dates": {"start": {"localDate": date, "localTime": time, **start},
                                    "status": {"code": status}},
            "classifications": [{"segment": {"name": segment}, "genre": {"name": genre}}]}


class Ticketmaster(unittest.TestCase):
    def test_venue_prefers_an_exact_name(self):
        reply = {"_embedded": {"venues": [{"id": "a", "name": "Barclays Center Parking"},
                                          {"id": "b", "name": "Barclays Center"}]}}
        self.assertEqual(tm.venue_id(reply, "barclays center"), "b")
        self.assertEqual(tm.venue_id(reply, "Barclays"), "a")
        self.assertIsNone(tm.venue_id({}, "x"))

    def test_events_put_the_time_first_and_dedupe_packages(self):
        reply = {"_embedded": {"events": [
            ev("Brooklyn Nets vs. Knicks", "2026-10-21"),
            ev("Brooklyn Nets vs. Knicks", "2026-10-21"),                       # a VIP package
            ev("Big Show", "2026-10-23", time="20:00:00", segment="Music", genre="Rock"),
            ev("Gone", "2026-10-24", status="cancelled"),
            ev("Some day", "2026-10-25", timeTBA=True),
            {"name": "no date", "dates": {"start": {}}}]}}
        out = tm.events(reply)
        self.assertEqual([e["title"] for e in out],
                         ["7:30 PM Brooklyn Nets vs. Knicks", "8 PM Big Show", "7:30 PM Gone", "Some day"])
        self.assertEqual(out[0]["sub"], "Sports · Basketball")
        self.assertTrue(out[2]["struck"] and out[2]["sub"].endswith("cancelled"))
        self.assertEqual(out[1]["date"], "2026-10-23")

    def test_time_filters(self):
        reply = {"_embedded": {"events": [ev("Matinee", "2026-10-21", time="14:00:00"),
                                          ev("Evening", "2026-10-21", time="19:30:00"),
                                          ev("Late", "2026-10-21", time="23:00:00"),
                                          ev("Some day", "2026-10-22", timeTBA=True)]}}
        names = lambda *f: [e["title"].split(" ", 2)[-1] if e["title"][0].isdigit() else e["title"]
                            for e in tm.events(reply, *f)]
        self.assertEqual(names("exclude after", "20:00"), ["Matinee", "Evening", "Some day"])
        self.assertEqual(names("exclude before", "18:00"), ["Evening", "Late", "Some day"])
        self.assertEqual(names("exclude between", "12:00", "17:00"), ["Evening", "Late", "Some day"])
        self.assertEqual(names("exclude between", "22:00", "15:00"), ["Evening", "Some day"], "wraps midnight")
        self.assertEqual(tm.hhmm("6 PM", "x"), "18:00")
        self.assertEqual(tm.hhmm("7:30 pm", "x"), "19:30")
        with self.assertRaises(ValueError):
            tm.hhmm("dinner", "Time")

    def test_window_starts_at_the_week_start_with_slack(self):
        thu = dt.date(2026, 10, 15)
        self.assertEqual(tm.window(thu, 0), ("2026-10-10T00:00:00Z", "2026-12-07T00:00:00Z"))   # Sun Oct 11 - 1
        self.assertEqual(tm.window(dt.date(2026, 10, 11), 0)[0], "2026-10-10T00:00:00Z")      # a Sunday itself


if __name__ == "__main__":
    unittest.main()
