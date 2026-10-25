"""Ticketmaster's Discovery API as a `calendar` strip: what's on at a venue.

STANDARD LIBRARY ONLY (CI runs these tests without pip): the HTTP is in
providers.py. Shapes are the Discovery API v2's
(developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/):
  GET /discovery/v2/venues.json?keyword=…  {_embedded: {venues: [{id, name, city: {name}}]}}
  GET /discovery/v2/events.json?venueId=…  {_embedded: {events: [{name, url, dates: {start:
      {localDate, localTime, dateTBA, timeTBA, noSpecificTime}, status: {code}}, classifications: [...]}]}}

Days are the VENUE's local dates, never shifted: a 7:30 PM game in Brooklyn is
on that day for anyone looking.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

DAYS = 56          # fetched ahead: this week and the next seven
DEAD = {"cancelled", "canceled", "postponed", "rescheduled"}

# What kind of event, for the day's colour: [label, series 1-8]. Fixed, so a
# kind keeps its colour from week to week. Basketball is split out of Sports
# because a venue's home team (Nets, Liberty) is most of its calendar.
KINDS = {"basketball": ["Basketball", 1], "sports": ["Sports", 2], "music": ["Concert", 3],
         "arts & theatre": ["Arts & theatre", 5], "film": ["Film", 7], "other": ["Other", 6]}
ORDER = ["basketball", "sports", "music", "arts & theatre", "film", "other"]


def kind_of(segment: str | None, genre: str | None) -> str:
    """A KINDS key from Ticketmaster's segment/genre."""
    seg, gen = (segment or "").strip().lower(), (genre or "").strip().lower()
    if seg == "sports":
        return "basketball" if gen == "basketball" else "sports"
    return seg if seg in KINDS else "other"


def legend(evs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The kinds present among live (not cancelled) events, in KINDS order."""
    present = {e["kind_key"] for e in evs if not e.get("struck")}
    return [{"label": KINDS[k][0], "series": KINDS[k][1]} for k in ORDER if k in present]


def venue_id(venues_reply: dict[str, Any], keyword: str) -> str | None:
    """The venue a keyword names: an exact name match first, else the first."""
    venues = ((venues_reply or {}).get("_embedded") or {}).get("venues") or []
    for v in venues:
        if (v.get("name") or "").strip().lower() == keyword.strip().lower():
            return v.get("id")
    return venues[0].get("id") if venues else None


def _clock(hhmmss: str | None) -> str:
    if not hhmmss:
        return ""
    try:
        t = dt.datetime.strptime(hhmmss[:5], "%H:%M")
    except ValueError:
        return ""
    return t.strftime("%-I:%M %p") if t.minute else t.strftime("%-I %p")


FILTERS = ("none", "exclude between", "exclude after", "exclude before")


def hhmm(s: str, field: str) -> str:
    """'19:30' or '7:30 PM' -> '19:30'; anything else is a config error."""
    s = (s or "").strip().upper()
    for fmt in ("%H:%M", "%I:%M %p", "%I %p", "%I:%M%p", "%I%p"):
        try:
            return dt.datetime.strptime(s, fmt).strftime("%H:%M")
        except ValueError:
            pass
    raise ValueError(f"{field} must be a time like 18:00 or 6 PM, not {s!r}")


def excluded(local_time: str | None, mode: str, a: str, b: str) -> bool:
    """Whether a start time is filtered out. `a`/`b` are HH:MM; an event with
    no time (TBA, all day) is always kept -- it can't be judged. Between is
    inclusive and may wrap midnight (22:00 to 06:00)."""
    if mode == "none" or not local_time:
        return False
    t = local_time[:5]
    if mode == "exclude after":
        return t > a
    if mode == "exclude before":
        return t < a
    return a <= t <= b if a <= b else (t >= a or t <= b)


def events(events_reply: dict[str, Any], mode: str = "none", a: str = "", b: str = "") -> list[dict[str, Any]]:
    """Calendar events: the time first in the title ("7:30 PM Nets vs Knicks")
    so a day's popover reads as a schedule; what kind of event in `sub`.
    `mode`/`a`/`b`: the time filter (see excluded)."""
    out = []
    for e in ((events_reply or {}).get("_embedded") or {}).get("events") or []:
        start = (e.get("dates") or {}).get("start") or {}
        day = start.get("localDate")
        if not day:
            continue
        timed = not (start.get("timeTBA") or start.get("noSpecificTime"))
        if timed and excluded(start.get("localTime"), mode, a, b):
            continue
        status = (((e.get("dates") or {}).get("status") or {}).get("code") or "").lower()
        when = "" if start.get("timeTBA") or start.get("noSpecificTime") else _clock(start.get("localTime"))
        cls = (e.get("classifications") or [{}])[0] or {}
        seg, gen = (cls.get("segment") or {}).get("name"), (cls.get("genre") or {}).get("name")
        kind = " · ".join(x for x in (seg, gen) if x and x != "Undefined")
        k = kind_of(seg, gen)
        ev: dict[str, Any] = {"date": day, "title": f"{when} {e.get('name') or 'Event'}".strip(),
                              "sub": kind + (f" · {status}" if status in DEAD else ""),
                              "series": KINDS[k][1], "kind_key": k}
        if status in DEAD:
            ev["struck"] = True
        out.append(ev)
    # One listing per name and time a day: Ticketmaster often lists a show's
    # packages (VIP, parking) as separate events with the same name.
    seen, uniq = set(), []
    for ev in out:
        k = (ev["date"], ev["title"])
        if k not in seen:
            seen.add(k)
            uniq.append(ev)
    return uniq


def window(today: dt.date, week_start: int) -> tuple[str, str]:
    """[the start of this week, DAYS on], as Discovery wants them (UTC, Z).
    A day's slack each side for the venue's zone."""
    back = (today.isoweekday() % 7 - week_start) % 7      # isoweekday % 7: Sunday 0
    first = today - dt.timedelta(days=back + 1)
    return f"{first.isoformat()}T00:00:00Z", f"{(first + dt.timedelta(days=DAYS + 2)).isoformat()}T00:00:00Z"
