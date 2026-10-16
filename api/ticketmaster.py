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


def events(events_reply: dict[str, Any]) -> list[dict[str, Any]]:
    """Calendar events: the time first in the title ("7:30 PM Nets vs Knicks")
    so a day's popover reads as a schedule; what kind of event in `sub`."""
    out = []
    for e in ((events_reply or {}).get("_embedded") or {}).get("events") or []:
        start = (e.get("dates") or {}).get("start") or {}
        day = start.get("localDate")
        if not day:
            continue
        status = (((e.get("dates") or {}).get("status") or {}).get("code") or "").lower()
        when = "" if start.get("timeTBA") or start.get("noSpecificTime") else _clock(start.get("localTime"))
        cls = (e.get("classifications") or [{}])[0] or {}
        kind = " · ".join(x for x in ((cls.get("segment") or {}).get("name"), (cls.get("genre") or {}).get("name"))
                          if x and x != "Undefined")
        ev: dict[str, Any] = {"date": day, "title": f"{when} {e.get('name') or 'Event'}".strip(),
                              "sub": kind + (f" · {status}" if status in DEAD else "")}
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
    back = (today.isoweekday() % 7 - week_start) % 7
    first = today - dt.timedelta(days=back + 1)
    return f"{first.isoformat()}T00:00:00Z", f"{(first + dt.timedelta(days=DAYS + 2)).isoformat()}T00:00:00Z"
