"""OpenChore's chores as a `list` widget payload.

STANDARD LIBRARY ONLY (CI runs these tests without pip): the HTTP is in
providers.py. Shapes are OpenChore 53b030e's public, read-only endpoints --
the ones its wall display (/ambient) reads with nobody signed in:
  GET /api/users                         [{id, name, role, paused, ...}]
  GET /api/users/{id}/chores?view=&date= [ScheduledChore, internal/model]
  GET /api/users/{id}/points             {balance, ...}

Days are the household's: OpenChore buckets by its server clock (TZ in its
Deployment), and the `date` asked for here is today in the configured zone,
so the two agree.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

import chores   # zone(): the same time-zone check and message

HORIZONS = ("today", "week")
MAX_ITEMS = 60

# completion_status (internal/model): approved is plain done.
STATUS = {"pending": ("Awaiting approval", "warn"), "excused": ("Excused", "muted"),
          "rejected": ("Redo", "warn")}


def zone(name: str) -> Any:
    return chores.zone(name)


def people(users: list[dict[str, Any]] | None, person: str) -> list[dict[str, Any]]:
    """Who to ask about, in OpenChore's order. Paused profiles are on a
    break and have no chores; `person` narrows to one name."""
    want = person.strip().lower()
    out = []
    for u in users or []:
        if not isinstance(u.get("id"), int) or u.get("paused"):
            continue
        if want and (u.get("name") or "").lower() != want:
            continue
        out.append(u)
    return out


def _clock(hhmm: str | None) -> str:
    """'17:30' -> '5:30 PM'; '09:00' -> '9 AM'."""
    if not hhmm:
        return ""
    try:
        t = dt.datetime.strptime(hhmm, "%H:%M")
    except ValueError:
        return hhmm
    return t.strftime("%-I:%M %p") if t.minute else t.strftime("%-I %p")


def state(c: dict[str, Any]) -> tuple[int, dict[str, str] | None, str]:
    """(sort rank, badge, extra sub text). To do first, then waiting, then
    done -- so what is left reads from the top."""
    status = c.get("completion_status")
    if c.get("completed") or status in STATUS:
        if status in STATUS:
            text, level = STATUS[status]
            return (1 if status == "pending" else 2), {"text": text, "level": level}, ""
        by = c.get("completed_by_name") or ""
        return 2, {"text": "Done", "level": "good"}, (f"by {by}" if c.get("completed_by_sibling") and by else "")
    if c.get("expired"):
        return 0, {"text": "Missed", "level": "crit"}, ""
    if c.get("available") is False and c.get("available_at"):
        return 0, None, f"from {_clock(c['available_at'])}"
    if c.get("due_by"):
        return 0, None, f"by {_clock(c['due_by'])}"
    return 0, None, ""


def chore_items(by_user: list[tuple[dict[str, Any], list[dict[str, Any]], int | None]],
                horizon: str, today: dt.date, public: str) -> tuple[list[dict[str, Any]], int, int]:
    """Rows, how many are done and how many there are. Today: a heading per
    person with their points. Week: a heading per day, the person in the sub."""
    rows = []
    for user, items, points in by_user:
        name = user.get("name") or f"user {user.get('id')}"
        for c in items:
            if not isinstance(c, dict):
                continue
            rank, badge, extra = state(c)
            day = c.get("date") or today.isoformat()
            if horizon == "week" and not (today.isoformat() <= day <= (today + dt.timedelta(days=6)).isoformat()):
                continue   # OpenChore's week is Mon-Sun; this one is the next seven days
            bits = [] if horizon == "today" else [name]
            if extra:
                bits.append(extra)
            if c.get("points_value"):
                bits.append(f"{c['points_value']} pt" + ("" if c["points_value"] == 1 else "s"))
            label = ((c.get("icon") or "") + " " + (c.get("title") or "Untitled")).strip()
            item: dict[str, Any] = {"label": label, "sub": " · ".join(bits)}
            if badge:
                item["badge"] = badge
            if public:
                item["url"] = public + "/"
            if horizon == "today":
                # Person order as OpenChore lists them; within a person, to do first.
                item["section"] = name + (f" · {points} pts" if isinstance(points, int) else "")
                key: tuple[Any, ...] = (user.get("id"), rank, len(rows))
            else:
                item["section"] = _day(day, today)
                key = (day, rank, len(rows))
            rows.append((key, item, rank))
    if horizon == "today":
        first: dict[Any, int] = {}
        for k, _, _ in rows:
            first.setdefault(k[0], len(first))
        rows.sort(key=lambda r: (first[r[0][0]], r[0][1], r[0][2]))
    else:
        rows.sort(key=lambda r: r[0])
    done = sum(1 for r in rows if r[2] == 2)
    return [r[1] for r in rows[:MAX_ITEMS]], done, len(rows)


def _day(iso: str, today: dt.date) -> str:
    try:
        d = dt.date.fromisoformat(iso)
    except ValueError:
        return iso
    if d == today:
        return "Today"
    if d == today + dt.timedelta(days=1):
        return "Tomorrow"
    if d == today - dt.timedelta(days=1):
        return "Yesterday"
    return d.strftime("%a %b %-d")


def note(done: int, total: int) -> str:
    if not total:
        return "nothing scheduled"
    return "all done" if done == total else f"{total - done} left of {total}"
