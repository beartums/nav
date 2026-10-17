"""The combined week: several saved widgets' answers as one `week` payload.

STANDARD LIBRARY ONLY (CI runs these tests without pip): fetching is in
providers.py, which hands this module each source's payload as its own widget
would get it -- the same cache, the same filters, the same permissions.

  weather   a `weather` payload       -> per-day icon, high/low, words
  marks     `calendar` payloads       -> an icon on days with an event (Barclays)
  rows      `calendar` payloads       -> a row of dots or initials per day

Events keep what their own widget sent (key, can, series, initial, …) and say
which widget they came from (`def`), so the page can later hand an action to
that widget's own action endpoint -- interactivity without a second copy of
the chore logic.
"""
from __future__ import annotations

from typing import Any


def weather_days(payload: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    data = (payload or {}).get("data") or {}
    out = {}
    for d in data.get("daily") or []:
        if d.get("date"):
            out[d["date"]] = {k: d.get(k) for k in ("icon", "hi", "lo", "text", "pop")}
    return out


def events_of(payload: dict[str, Any] | None, def_id: int) -> list[dict[str, Any]]:
    data = (payload or {}).get("data") or {}
    return [{**e, "def": def_id} for e in data.get("events") or [] if isinstance(e, dict)]


def span(payloads: list[dict[str, Any] | None]) -> list[str] | None:
    """The days every calendar source covers (their ranges intersected)."""
    lo, hi = None, None
    for p in payloads:
        r = ((p or {}).get("data") or {}).get("range")
        if isinstance(r, list) and len(r) == 2:
            lo = r[0] if lo is None or r[0] > lo else lo
            hi = r[1] if hi is None or r[1] < hi else hi
    return [lo, hi] if lo and hi and lo <= hi else None


def problem(name: str, payload: dict[str, Any] | None) -> str | None:
    if payload is None:
        return f"{name}: no widget by that name you can see"
    if payload.get("error"):
        return f"{name}: {payload['error']}"
    return None


def day_url(inbox_url: str | None) -> str | None:
    """Choreboard's calendar for a day, from the inbox link its widget sends:
    the page appends the date. None for sources without one."""
    if not inbox_url or "/inbox" not in inbox_url:
        return None
    return inbox_url.split("/inbox", 1)[0] + "/calendar?date="
