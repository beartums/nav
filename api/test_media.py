"""media.py and mealie.py: the *arr, Seerr and Mealie payloads. Standard library only."""
import datetime as dt
import unittest

import mealie
import media

NOW = dt.datetime(2026, 10, 11, 12, 0, tzinfo=dt.timezone.utc)


class Calendar(unittest.TestCase):
    def test_window_covers_both_views(self):
        self.assertEqual(media.window(dt.date(2026, 10, 11)), ("2026-08-02", "2026-12-20"))

    def test_a_season_drop_is_one_event(self):
        eps = [{"series": {"title": "Show"}, "airDateUtc": "2026-10-12T02:00:00Z",
                "airDate": "2026-10-11", "seasonNumber": 2, "episodeNumber": n, "hasFile": False}
               for n in (3, 1, 2)]
        eps.append({"series": {"title": "Other"}, "airDateUtc": "2026-10-12T02:00:00Z",
                    "seasonNumber": 1, "episodeNumber": 5, "title": "Pilot", "hasFile": True})
        got = {e["title"]: e for e in media.sonarr_events(eps)}
        self.assertEqual(got["Show"]["sub"], "S02E01–E03 · 3 episodes")
        self.assertEqual(got["Show"]["date"], "2026-10-11", "the network's own air date")
        self.assertEqual(got["Show"]["at"], "2026-10-12T02:00:00Z")
        self.assertEqual(got["Other"]["sub"], "S01E05 · Pilot")
        self.assertTrue(got["Other"]["done"])

    def test_radarr_dates_in_range_are_each_an_event(self):
        movies = [{"title": "Film", "year": 2026, "inCinemas": "2026-08-01T00:00:00Z",
                   "digitalRelease": "2026-10-14T00:00:00Z",
                   "physicalRelease": "2026-11-20T00:00:00Z", "hasFile": False}]
        got = media.radarr_events(movies, "2026-09-03", "2026-11-25")
        self.assertEqual([(e["date"], e["sub"]) for e in got],
                         [("2026-10-14", "Digital"), ("2026-11-20", "Physical")])
        self.assertEqual(got[0]["title"], "Film (2026)")

    def test_lidarr_and_ordering(self):
        albums = [{"title": "LP", "releaseDate": "2026-10-13T00:00:00Z",
                   "artist": {"artistName": "Band"}, "statistics": {"trackFileCount": 0}}]
        music = media.lidarr_events(albums)
        self.assertEqual(music[0]["sub"], "Band")
        self.assertFalse(music[0]["done"])
        tv = [{"kind": "tv", "at": "2026-10-12T02:00:00Z", "date": "2026-10-11", "title": "B"}]
        out = media.calendar([music, tv], "Coming up", "week", ["Radarr: down"])
        self.assertEqual([e["title"] for e in out["events"]], ["B", "LP"])
        self.assertEqual(out["warnings"], ["Radarr: down"])
        self.assertNotIn("range", out)
        ranged = media.calendar([], "x", "week", [], ("2026-08-02", "2026-12-20"))
        self.assertEqual(ranged["range"], ["2026-08-03", "2026-12-19"])

    def test_window_reaches_a_month_either_way(self):
        # The worst cases: the 31st (prev month's grid starts furthest back)
        # and the 1st (next month's grid ends furthest on), any week start.
        for today in (dt.date(2026, 10, 31), dt.date(2026, 12, 1), dt.date(2026, 3, 31)):
            lo, hi = media.window(today)
            prev_first = (today.replace(day=1) - dt.timedelta(days=1)).replace(day=1)
            nxt = (today.replace(day=28) + dt.timedelta(days=10)).replace(day=1)
            nxt_last = (nxt.replace(day=28) + dt.timedelta(days=10)).replace(day=1) - dt.timedelta(days=1)
            self.assertLessEqual(lo, (prev_first - dt.timedelta(days=6)).isoformat())
            self.assertGreaterEqual(hi, (nxt_last + dt.timedelta(days=6)).isoformat())


class Seerr(unittest.TestCase):
    def test_an_available_title_says_so(self):
        req = {"status": 2, "type": "movie", "createdAt": "2026-10-09T12:00:00Z",
               "media": {"tmdbId": 7, "status": 5}, "requestedBy": {"displayName": "Mom"}}
        it = media.seerr_item(req, {"title": "Film", "releaseDate": "2025-05-01"},
                              "https://seerr.x", NOW)
        self.assertEqual(it["label"], "Film (2025)")
        self.assertEqual(it["badge"], {"text": "Available", "level": "good"})
        self.assertEqual(it["sub"], "Film · Mom · 2d ago")
        self.assertEqual(it["url"], "https://seerr.x/movie/7")

    def test_pending_wins_and_tv_lists_seasons(self):
        req = {"status": 1, "type": "tv", "media": {"tmdbId": 9, "status": 2},
               "seasons": [{"seasonNumber": 2}, {"seasonNumber": 1}]}
        it = media.seerr_item(req, None, "https://seerr.x", NOW)
        self.assertEqual(it["badge"]["text"], "Pending")
        self.assertTrue(it["sub"].startswith("TV · S1, S2"))
        self.assertEqual(it["label"], "TMDB 9")
        self.assertEqual(media.seerr_note({"pending": 3}), "3 pending")


class Mealie(unittest.TestCase):
    TODAY = dt.date(2026, 10, 11)

    def test_plan_is_grouped_by_day_in_meal_order(self):
        entries = [
            {"date": "2026-10-12", "entryType": "dinner", "recipe": {"name": "Soup", "slug": "soup"}},
            {"date": "2026-10-11", "entryType": "dinner", "title": "Takeout", "text": "Fri!"},
            {"date": "2026-10-11", "entryType": "breakfast", "recipe": {"name": "Eggs", "slug": "eggs"}},
        ]
        dinner = mealie.plan_items(entries, "dinner", self.TODAY, "https://m", "home")
        self.assertEqual([(i["section"], i["label"]) for i in dinner],
                         [("Today", "Takeout"), ("Tomorrow", "Soup")])
        self.assertEqual(dinner[0]["sub"], "Fri!")
        self.assertEqual(dinner[1]["url"], "https://m/g/home/r/soup")
        self.assertNotIn("value", dinner[0], "the meal is implied when only dinners show")
        every = mealie.plan_items(entries, "all", self.TODAY, "https://m", None)
        self.assertEqual([i["label"] for i in every], ["Eggs", "Takeout", "Soup"])
        self.assertNotIn("url", every[0], "no group slug, no link")

    def test_comments_name_the_recipe(self):
        c = [{"recipeId": "r1", "text": " Great ", "createdAt": "2026-10-11T09:00:00Z",
              "user": {"fullName": "Evan", "username": "evan"}}]
        got = mealie.comment_items(c, {"r1": {"name": "Soup", "slug": "soup"}}, NOW, "https://m", "home")
        self.assertEqual(got[0], {"label": "Soup", "sub": "Great", "value": "Evan · 3h ago",
                                  "url": "https://m/g/home/r/soup"})


if __name__ == "__main__":
    unittest.main()
