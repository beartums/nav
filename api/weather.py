"""Open-Meteo replies -> the weather widget's payload.

Pure, standard library only -- the HTTP calls live in providers.py -- so the
edge cases (a place that does not geocode, missing hours, the day boundary)
are tested in CI without the network.

Why Open-Meteo: free, no API key (so no secret to seal and rotate), current +
hourly + daily in one call, and its own geocoder, so the designer takes a
place name rather than coordinates.
"""
from __future__ import annotations

import re
from typing import Any

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
HOURS = 24
DAYS = 7

# WMO weather interpretation codes (Open-Meteo's `weather_code`) -> a word and
# the page's icon key. Grouped coarsely on purpose: the icon set is small.
WMO = {
    0: ("Clear", "clear"), 1: ("Mainly clear", "clear"), 2: ("Partly cloudy", "partly"),
    3: ("Overcast", "cloud"), 45: ("Fog", "fog"), 48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"), 53: ("Drizzle", "drizzle"), 55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "drizzle"), 57: ("Freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"), 63: ("Rain", "rain"), 65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"), 67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"), 73: ("Snow", "snow"), 75: ("Heavy snow", "snow"),
    77: ("Snow grains", "snow"), 80: ("Showers", "rain"), 81: ("Showers", "rain"),
    82: ("Heavy showers", "rain"), 85: ("Snow showers", "snow"), 86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "storm"), 96: ("Thunderstorm, hail", "storm"),
    99: ("Thunderstorm, hail", "storm"),
}

UNITS = {"metric": {"temperature_unit": "celsius", "wind_speed_unit": "kmh"},
         "imperial": {"temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                      "precipitation_unit": "inch"}}
UNIT_LABELS = {"metric": {"temp": "°C", "wind": "km/h"},
               "imperial": {"temp": "°F", "wind": "mph"}}

COORDS = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def describe(code: Any) -> dict[str, str]:
    word, icon = WMO.get(code if isinstance(code, int) else -1, ("Unknown", "cloud"))
    return {"text": word, "icon": icon}


def coords(location: str) -> tuple[float, float] | None:
    """`47.6,-122.3` -> (lat, lon), checked for range; anything else None."""
    m = COORDS.match(location or "")
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("latitude must be -90..90 and longitude -180..180")
    return lat, lon


def place(reply: dict[str, Any], asked: str) -> dict[str, Any]:
    """The geocoder's first hit, or an error that names what was searched."""
    hits = reply.get("results") or []
    if not hits:
        raise ValueError(f"no place called {asked!r} -- try a city name, "
                         f"or coordinates like 47.6,-122.3")
    h = hits[0]
    name = ", ".join(x for x in (h.get("name"), h.get("admin1") or h.get("country")) if x)
    return {"lat": h["latitude"], "lon": h["longitude"], "name": name}


def forecast_params(lat: float, lon: float, units: str) -> dict[str, Any]:
    return {
        "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": DAYS,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                   "weather_code,wind_speed_10m,is_day",
        "hourly": "temperature_2m,precipitation_probability,weather_code,is_day",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,"
                 "precipitation_probability_max,sunrise,sunset",
        **UNITS[units],
    }


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def payload(reply: dict[str, Any], name: str, units: str) -> dict[str, Any]:
    """Times stay LOCAL to the place (`timezone=auto`), as ISO strings without
    an offset: the widget shows the place's hours, not the viewer's."""
    cur = reply.get("current") or {}
    if "temperature_2m" not in cur:
        raise ValueError("Open-Meteo returned no current conditions")
    now = cur.get("time") or ""
    hourly = reply.get("hourly") or {}
    times = hourly.get("time") or []
    # The hours FROM the current one: the reply starts at local midnight.
    start = next((i for i, t in enumerate(times) if t[:13] >= now[:13]), len(times))

    def col(block: dict[str, Any], key: str, i: int) -> Any:
        vals = block.get(key) or []
        return vals[i] if i < len(vals) else None

    hours = [{"t": times[i], "temp": _num(col(hourly, "temperature_2m", i)),
              "pop": _num(col(hourly, "precipitation_probability", i)),
              "is_day": bool(col(hourly, "is_day", i)),
              **describe(col(hourly, "weather_code", i))}
             for i in range(start, min(start + HOURS, len(times)))]
    daily = reply.get("daily") or {}
    days = [{"date": d, "hi": _num(col(daily, "temperature_2m_max", i)),
             "lo": _num(col(daily, "temperature_2m_min", i)),
             "pop": _num(col(daily, "precipitation_probability_max", i)),
             "sunrise": col(daily, "sunrise", i), "sunset": col(daily, "sunset", i),
             **describe(col(daily, "weather_code", i))}
            for i, d in enumerate((daily.get("time") or [])[:DAYS])]
    return {
        "place": name,
        "units": UNIT_LABELS[units],
        "current": {"time": now, "temp": _num(cur.get("temperature_2m")),
                    "feels": _num(cur.get("apparent_temperature")),
                    "humidity": _num(cur.get("relative_humidity_2m")),
                    "wind": _num(cur.get("wind_speed_10m")),
                    "is_day": bool(cur.get("is_day")),
                    **describe(cur.get("weather_code"))},
        "hourly": hours,
        "daily": days,
    }
