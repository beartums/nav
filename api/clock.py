"""The clock widget's config: which zones, each with a label.

Pure, standard library only (zoneinfo ships with Python; the slim base image
carries the tz database). The clock itself ticks in the browser -- the server
only resolves and checks the zones, so a typo is a designer error, not a clock
that silently shows the wrong city.

An entry names a ZONE (`Europe/London`), a CITY the tz database knows
(`Tokyo`, `New York`), a US state or Canadian province (`Colorado`), or any
other PLACE, which the provider geocodes (Open-Meteo returns the place's zone).
`home`, `local` and `here` mean the viewer's own time.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

MAX_ZONES = 12
LOCAL_WORDS = {"local", "home", "here"}

# The geocoder knows cities, not regions: "Colorado" comes back as Colorado
# City, Texas (Central time). Each region's MAIN zone; a state split across
# zones takes its most populous side -- name a city for the other.
REGIONS = {
    "alabama": "America/Chicago", "alaska": "America/Anchorage", "arizona": "America/Phoenix",
    "arkansas": "America/Chicago", "california": "America/Los_Angeles",
    "colorado": "America/Denver", "connecticut": "America/New_York",
    "delaware": "America/New_York", "district of columbia": "America/New_York",
    "florida": "America/New_York", "georgia": "America/New_York", "hawaii": "Pacific/Honolulu",
    "idaho": "America/Boise", "illinois": "America/Chicago",
    "indiana": "America/Indiana/Indianapolis", "iowa": "America/Chicago",
    "kansas": "America/Chicago", "kentucky": "America/New_York", "louisiana": "America/Chicago",
    "maine": "America/New_York", "maryland": "America/New_York",
    "massachusetts": "America/New_York", "michigan": "America/Detroit",
    "minnesota": "America/Chicago", "mississippi": "America/Chicago",
    "missouri": "America/Chicago", "montana": "America/Denver", "nebraska": "America/Chicago",
    "nevada": "America/Los_Angeles", "new hampshire": "America/New_York",
    "new jersey": "America/New_York", "new mexico": "America/Denver",
    "new york state": "America/New_York", "north carolina": "America/New_York",
    "north dakota": "America/Chicago", "ohio": "America/New_York",
    "oklahoma": "America/Chicago", "oregon": "America/Los_Angeles",
    "pennsylvania": "America/New_York", "rhode island": "America/New_York",
    "south carolina": "America/New_York", "south dakota": "America/Chicago",
    "tennessee": "America/Chicago", "texas": "America/Chicago", "utah": "America/Denver",
    "vermont": "America/New_York", "virginia": "America/New_York",
    "washington state": "America/Los_Angeles", "west virginia": "America/New_York",
    "wisconsin": "America/Chicago", "wyoming": "America/Denver",
    "alberta": "America/Edmonton", "british columbia": "America/Vancouver",
    "manitoba": "America/Winnipeg", "new brunswick": "America/Moncton",
    "newfoundland": "America/St_Johns", "nova scotia": "America/Halifax",
    "ontario": "America/Toronto", "quebec": "America/Toronto",
    "saskatchewan": "America/Regina", "yukon": "America/Whitehorse",
}


@lru_cache(maxsize=1)
def tz_cities() -> dict[str, str]:
    """'new york' -> America/New_York, from the zone names themselves."""
    out: dict[str, str] = {}
    for z in sorted(available_timezones()):
        if "/" in z and not z.startswith(("Etc/", "SystemV/", "US/")):
            out.setdefault(z.rsplit("/", 1)[-1].replace("_", " ").lower(), z)
    return out


def is_zone(name: str) -> bool:
    if "/" not in name and name.upper() not in ("UTC", "GMT"):
        return False
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def parse_zones(text: str) -> list[dict[str, Any]]:
    """`Home, London=Europe/London, Brooklyn` -> [{label, tz, place}].

    `label=what` or a bare `what`, where `what` is resolved as above. An entry
    left with `place` set needs geocoding (the provider does it, see
    zone_from_geocode); `tz` None with no `place` is the viewer's own time.
    Empty means one clock in the viewer's own time, unlabelled.
    """
    out: list[dict[str, Any]] = []
    for raw in (text or "").replace("\n", ",").split(","):
        part = raw.strip()
        if not part:
            continue
        if "=" in part:
            label, what = (s.strip() for s in part.split("=", 1))
            what = what or "local"
        else:
            label, what = part, part
        tz, place = None, None
        key = what.lower()
        if key in LOCAL_WORDS:
            pass
        elif is_zone(what):
            tz = what
            if label == what:
                label = what.rsplit("/", 1)[-1].replace("_", " ")
        elif "/" in what:
            raise ValueError(f"unknown time zone {what!r} -- use an Area/City name "
                             f"such as Europe/London or America/New_York")
        elif key in REGIONS:
            tz = REGIONS[key]
        elif key in tz_cities():
            tz = tz_cities()[key]
        else:
            place = what
        out.append({"label": label[:40], "tz": tz, "place": place})
    if len(out) > MAX_ZONES:
        raise ValueError(f"at most {MAX_ZONES} clocks in one widget")
    return out or [{"label": "", "tz": None, "place": None}]


def zone_from_geocode(reply: dict[str, Any], asked: str) -> str:
    """The zone of the best hit: the most populous place named exactly what
    was asked (Houston, Texas over Houston, Alaska), else the first hit."""
    hits = [h for h in (reply.get("results") or []) if h.get("timezone")]
    if not hits:
        raise ValueError(f"no place called {asked!r} -- try a city, or an Area/City zone "
                         f"such as America/Denver")
    exact = [h for h in hits if str(h.get("name", "")).lower() == asked.lower()]
    best = max(exact, key=lambda h: h.get("population") or 0) if exact else hits[0]
    return best["timezone"]
