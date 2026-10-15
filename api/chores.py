"""Donetick's chores as a `list` widget payload.

STANDARD LIBRARY ONLY (CI runs these tests without pip): the HTTP is in
providers.py. Shapes are Donetick v0.1.80's /eapi/v1/chore and
/eapi/v1/circle/members (internal/chore/model, internal/circle/model).

Days are the configured ZONE's, not UTC's: a chore due at 8pm in New York is
due tonight, which in UTC is already tomorrow.
"""
from __future__ import annotations

import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo

# Donetick's chore Status (internal/chore/model): 0 is no status.
STATUS = {1: ("In progress", "good"), 2: ("Paused", "muted"), 3: ("Awaiting approval", "warn")}
HORIZONS = ("today", "week", "all")
MAX_ITEMS = 60


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception as e:  # noqa: BLE001 -- ZoneInfoNotFoundError, ValueError
        raise ValueError(f"unknown time zone {name!r}: use Area/City, e.g. America/New_York") from e


def parse(when: Any) -> dt.datetime | None:
    if not isinstance(when, str) or not when:
        return None
    try:
        t = dt.datetime.fromisoformat(when.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def names(members: list[dict[str, Any]] | None) -> dict[int, str]:
    out = {}
    for m in members or []:
        uid = m.get("userId")
        if isinstance(uid, int):
            out[uid] = m.get("displayName") or m.get("username") or f"user {uid}"
    return out


def assignee(chore: dict[str, Any]) -> int | None:
    """Who it is on now: `assignedTo` (the rotation's current pick), else the
    only assignee when there is one."""
    if isinstance(chore.get("assignedTo"), int):
        return chore["assignedTo"]
    ids = [a.get("userId") for a in chore.get("assignees") or [] if isinstance(a.get("userId"), int)]
    return ids[0] if len(ids) == 1 else None


def section(due: dt.datetime | None, today: dt.date) -> tuple[int, str]:
    """(sort rank, heading). Overdue first; undated last."""
    if due is None:
        return 9, "Any time"
    d = due.date()
    if d < today:
        return 0, "Overdue"
    if d == today:
        return 1, "Today"
    if d == today + dt.timedelta(days=1):
        return 2, "Tomorrow"
    if d <= today + dt.timedelta(days=6):
        return 3, "This week"
    return 4, "Later"


def chore_items(chores: list[dict[str, Any]], members: list[dict[str, Any]] | None,
                now: dt.datetime, tzname: str, horizon: str, person: str,
                public: str) -> tuple[list[dict[str, Any]], int]:
    """The rows, and how many are overdue. `person` narrows to one member by
    display name or username (case-insensitive); empty means everyone."""
    tz = zone(tzname)
    today = now.astimezone(tz).date()
    who = names(members)
    want = person.strip().lower()
    rows = []
    for c in chores:
        if c.get("isActive") is False:
            continue
        due = parse(c.get("nextDueDate"))
        local = due.astimezone(tz) if due else None
        rank, head = section(local, today)
        if horizon == "today" and rank > 1:
            continue
        if horizon == "week" and rank > 3:
            continue
        uid = assignee(c)
        name = who.get(uid, "") if uid is not None else ""
        if want and want not in (name.lower(), _username(members, uid)):
            continue
        rows.append((rank, local or dt.datetime.max.replace(tzinfo=dt.timezone.utc),
                     -(c.get("priority") or 0), c, local, head, name))
    rows.sort(key=lambda r: (r[0], r[1], r[2], (r[3].get("name") or "").lower()))
    overdue = sum(1 for r in rows if r[0] == 0)
    items = []
    for _, _, _, c, local, head, name in rows[:MAX_ITEMS]:
        bits = [name or "Unassigned"]
        if local is not None:
            bits.append(_when(local, today))
        if c.get("points"):
            bits.append(f"{c['points']} pt" + ("" if c["points"] == 1 else "s"))
        item: dict[str, Any] = {"label": c.get("name") or "Untitled", "sub": " · ".join(bits),
                                "section": head}
        state = STATUS.get(c.get("status") or 0)
        if state:
            item["badge"] = {"text": state[0], "level": state[1]}
        elif head == "Overdue":
            item["badge"] = {"text": "Overdue", "level": "crit"}
        if public and isinstance(c.get("id"), int):
            item["url"] = f"{public}/chores/{c['id']}"
        items.append(item)
    return items, overdue


def _username(members: list[dict[str, Any]] | None, uid: int | None) -> str:
    for m in members or []:
        if m.get("userId") == uid:
            return (m.get("username") or "").lower()
    return ""


def _when(local: dt.datetime, today: dt.date) -> str:
    """'9 AM', 'Thu 9 AM', or 'Oct 14' -- whatever the section heading has
    not already said. Midnight reads as a date alone (a day, not a time)."""
    timed = (local.hour, local.minute) != (0, 0)
    hm = (local.strftime("%-I:%M %p") if local.minute else local.strftime("%-I %p")) if timed else ""
    d = local.date()
    if d in (today, today + dt.timedelta(days=1)) and d >= today:
        return hm or "any time"
    if today < d <= today + dt.timedelta(days=6):
        return local.strftime("%a") + (" " + hm if hm else "")
    return local.strftime("%b %-d") + (" " + hm if hm else "")


def note(overdue: int, total: int) -> str:
    if overdue:
        return f"{overdue} overdue"
    return f"{total} due" if total else "all done"
