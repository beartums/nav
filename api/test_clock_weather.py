"""clock.py and weather.py: config parsing and the Open-Meteo reply, offline."""
import unittest

from clock import parse_zones, zone_from_geocode
from weather import coords, describe, payload, place


class Zones(unittest.TestCase):
    def test_forms(self):
        self.assertEqual(parse_zones("Home, London=Europe/London, Asia/Tokyo"), [
            {"label": "Home", "tz": None, "place": None},
            {"label": "London", "tz": "Europe/London", "place": None},
            {"label": "Tokyo", "tz": "Asia/Tokyo", "place": None}])

    def test_empty_is_one_local_clock(self):
        self.assertEqual(parse_zones(""), [{"label": "", "tz": None, "place": None}])

    def test_places_are_not_local(self):
        """The bug: bare names were LABELS on the viewer's own time."""
        z = parse_zones("Brooklyn, Houston, Colorado, Tokyo, Mom=Denver, Me=home")
        self.assertEqual([(x["label"], x["tz"], x["place"]) for x in z], [
            ("Brooklyn", None, "Brooklyn"), ("Houston", None, "Houston"),
            ("Colorado", "America/Denver", None), ("Tokyo", "Asia/Tokyo", None),
            ("Mom", "America/Denver", None), ("Me", None, None)])

    def test_geocode_prefers_the_big_exact_match(self):
        reply = {"results": [
            {"name": "Houston", "timezone": "America/Anchorage", "population": 2206},
            {"name": "Houston", "timezone": "America/Chicago", "population": 2314157},
            {"name": "Houstonia", "timezone": "America/Chicago", "population": 9}]}
        self.assertEqual(zone_from_geocode(reply, "houston"), "America/Chicago")
        with self.assertRaisesRegex(ValueError, "Atlantis"):
            zone_from_geocode({}, "Atlantis")

    def test_bad_zone_is_named(self):
        with self.assertRaisesRegex(ValueError, "Europe/Lodnon"):
            parse_zones("London=Europe/Lodnon")

    def test_underscores_and_utc(self):
        self.assertEqual(parse_zones("America/New_York, UTC")[0]["label"], "New York")
        self.assertEqual(parse_zones("UTC")[0]["tz"], "UTC")

    def test_cap(self):
        with self.assertRaises(ValueError):
            parse_zones(",".join(["UTC"] * 13))


REPLY = {
    "current": {"time": "2026-10-11T14:00", "temperature_2m": 12.5, "apparent_temperature": 10,
                "relative_humidity_2m": 80, "weather_code": 61, "wind_speed_10m": 14, "is_day": 1},
    "hourly": {"time": [f"2026-10-11T{h:02d}:00" for h in range(24)] +
                       [f"2026-10-12T{h:02d}:00" for h in range(24)],
               "temperature_2m": list(range(48)), "precipitation_probability": [50] * 48,
               "weather_code": [3] * 48, "is_day": [1] * 48},
    "daily": {"time": ["2026-10-11", "2026-10-12"], "temperature_2m_max": [14, 15],
              "temperature_2m_min": [8, None], "precipitation_probability_max": [70, 10],
              "weather_code": [61, 0], "sunrise": ["2026-10-11T07:20"] * 2,
              "sunset": ["2026-10-11T18:30"] * 2},
}


class Weather(unittest.TestCase):
    def test_payload(self):
        p = payload(REPLY, "Seattle, Washington", "metric")
        self.assertEqual(p["current"]["text"], "Light rain")
        self.assertEqual(p["units"]["temp"], "°C")
        # Hours start at the CURRENT hour, not local midnight, and run 24.
        self.assertEqual(p["hourly"][0]["t"], "2026-10-11T14:00")
        self.assertEqual(len(p["hourly"]), 24)
        self.assertEqual(p["daily"][1]["lo"], None, "a gap stays a gap")
        self.assertEqual(p["daily"][1]["icon"], "clear")

    def test_no_current_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "no current"):
            payload({}, "x", "metric")

    def test_coords_and_places(self):
        self.assertEqual(coords("47.6, -122.3"), (47.6, -122.3))
        self.assertIsNone(coords("Seattle"))
        with self.assertRaises(ValueError):
            coords("95,0")
        self.assertEqual(place({"results": [{"latitude": 1, "longitude": 2, "name": "Paris",
                                             "admin1": "Île-de-France"}]}, "Paris")["name"],
                         "Paris, Île-de-France")
        with self.assertRaisesRegex(ValueError, "Atlantis"):
            place({}, "Atlantis")

    def test_unknown_code(self):
        self.assertEqual(describe(None)["text"], "Unknown")


if __name__ == "__main__":
    unittest.main()
