"""choreboard's calendar as a `calendar` widget payload.

STANDARD LIBRARY ONLY (CI runs these tests without pip): the HTTP is in
providers.py. Input shapes are choreboard's API (github.com/beartums/choreboard,
choreboard/service.py entries_json):
  GET /api/people    [{id, name, color, ...}]
  GET /api/chores    [{id, title, icon, points, ...}]
  GET /api/calendar  [{id, chore_id, date, person_id, available, due, skipped,
                       scheduled_person_id, group_id, unscheduled, outcome}]

Each person gets a palette colour (`series`, 1-8, stable by person id) and an
initial; the page colours chips by person and, when a cell is too small for
names, shows the person's initial instead of a dot.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

BACK, AHEAD = 35, 70          # days the widget can page back and forward
SERIES = 8
OUTCOME = {"done": "done", "covered": "covered", "skipped": "not needed", "failed": "missed",
           "failed_covered": "missed, covered"}


def candidates(entries: list[dict[str, Any]], key: str, people: list[dict[str, Any]],
               chores: list[dict[str, Any]], today: str) -> list[dict[str, Any]]:
    """What `key` could be swapped with: someone else's scheduled chore, not
    recorded, skipped or already in a pending swap -- any date ahead."""
    me = next((e for e in entries if e.get("id") == key), None)
    if me is None:
        return []
    name = {p["id"]: p.get("name") or "?" for p in people if isinstance(p.get("id"), int)}
    chore = {c["id"]: c for c in chores if isinstance(c.get("id"), int)}
    out = []
    for e in entries:
        if (e.get("id") == key or e.get("person_id") == me.get("person_id") or e.get("rule_id") is None
                or e.get("skipped") or e.get("outcome") or e.get("pending_swap") or e.get("date", "") < today):
            continue
        c = chore.get(e.get("chore_id"), {})
        out.append({"key": e["id"], "date": e["date"], "who": name.get(e.get("person_id"), "?"),
                    "title": f"{c.get('icon') or ''} {c.get('title') or 'Chore'}".strip(),
                    "window": _window(e.get("available"), e.get("due"))})
    return out


def window(today: dt.date) -> tuple[str, str]:
    return (today - dt.timedelta(days=BACK)).isoformat(), (today + dt.timedelta(days=AHEAD)).isoformat()


def initials(people: list[dict[str, Any]]) -> dict[int, str]:
    """One letter each where that's unambiguous; two (first + next distinct
    letter) where two people share a first letter -- Cara and Chris become
    'Ca' and 'Ch'."""
    names = {p["id"]: (p.get("name") or "?").strip() or "?" for p in people if isinstance(p.get("id"), int)}
    out = {}
    for pid, name in names.items():
        first = name[0].upper()
        clash = [n for q, n in names.items() if q != pid and n[:1].upper() == first]
        if not clash:
            out[pid] = first
            continue
        out[pid] = name[:2].title() if len(name) > 1 else first
    return out


def _clock(hhmm: str | None) -> str:
    if not hhmm:
        return ""
    t = dt.datetime.strptime(hhmm, "%H:%M")
    return t.strftime("%-I:%M %p") if t.minute else t.strftime("%-I %p")


def _window(available: str | None, due: str | None) -> str:
    if available and due:
        a, d = _clock(available), _clock(due)
        return f"{a.split(' ')[0]}–{d}" if a.split(" ")[1] == d.split(" ")[1] else f"{a}–{d}"
    if available:
        return f"after {_clock(available)}"
    if due:
        return f"by {_clock(due)}"
    return ""


def events(entries: list[dict[str, Any]], people: list[dict[str, Any]], chores: list[dict[str, Any]],
           mine: int | None = None, include_skipped: bool = True) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(events, legend). `mine` narrows to one person's chores."""
    pids = sorted(p["id"] for p in people if isinstance(p.get("id"), int))
    series = {pid: i % SERIES + 1 for i, pid in enumerate(pids)}
    letter = initials(people)
    name = {p["id"]: p.get("name") or "?" for p in people if isinstance(p.get("id"), int)}
    chore = {c["id"]: c for c in chores if isinstance(c.get("id"), int)}
    out, seen = [], set()
    for e in entries:
        if not isinstance(e, dict) or not e.get("date"):
            continue
        pid = e.get("person_id")
        if mine is not None and pid != mine:
            continue
        if e.get("skipped") and not include_skipped:
            continue
        c = chore.get(e.get("chore_id"), {})
        title = f"{c.get('icon') or ''} {c.get('title') or 'Chore'}".strip()
        outcome = (e.get("outcome") or {}).get("status")
        # Covered (someone else did it, or did it after it was missed): the
        # chip shows WHO DID IT; the detail says whose it was and how.
        doer = (e.get("outcome") or {}).get("done_by_id")
        covered = outcome in ("covered", "failed_covered") and isinstance(doer, int) and doer != pid
        shown = doer if covered else pid
        bits = [name.get(shown, "?")]
        w = _window(e.get("available"), e.get("due"))
        if w:
            bits.append(w)
        if e.get("scheduled_person_id") is not None:
            bits.append(f"instead of {name.get(e['scheduled_person_id'], '?')}")
        if e.get("skipped"):
            bits.append("skipped")
        elif covered and outcome == "covered":
            bits.append(f"covered for {name.get(pid, '?')}")
        elif covered:
            bits.append(f"{name.get(pid, '?')} missed it; covered")
        elif outcome:
            bits.append(OUTCOME.get(outcome, outcome))
        elif e.get("pending_swap"):
            bits.append({"undo": "undo pending", "give": "hand-off pending"}.get(e["pending_swap"].get("kind"),
                                                                                  "swap pending"))
        elif e.get("group_id"):
            bits.append("swapped")
        ev: dict[str, Any] = {"date": e["date"], "title": title, "sub": " · ".join(bits),
                              "done": outcome in ("done", "covered", "failed_covered"),
                              "series": series.get(shown, SERIES), "initial": letter.get(shown, "?"),
                              # The parts, for a chip that shows initial, icon, name, chore
                              # in that order as space allows. `title`/`sub` stay whole.
                              "icon": c.get("icon") or "", "who": name.get(shown, "?"),
                              "name": c.get("title") or "Chore", "detail": " · ".join(bits[1:]),
                              # For actions: the occurrence, what THIS viewer may do with it
                              # (choreboard's answer), and why not for the common ones.
                              "key": e.get("id"), "person_id": pid, "who_id": shown,
                              "can": list(e.get("can") or []), "cannot": dict(e.get("cannot") or {})}
        if (e.get("outcome") or {}).get("id"):
            ev["outcome_id"] = e["outcome"]["id"]
        if covered:
            ev["covered"] = {"for": name.get(pid, "?"), "missed": outcome == "failed_covered"}
        if e.get("pending_swap"):
            ps = e["pending_swap"]
            ev["pending"] = {"id": ps.get("id"), "side": ps.get("side"), "reason": ps.get("reason", ""),
                             "kind": ps.get("kind") or "swap",
                             "from": name.get(ps.get("from_person"), "?"), "to": name.get(ps.get("to_person"), "?")}
        if e.get("group_id"):
            ev["group"] = e["group_id"]
        if e.get("skipped") or outcome in ("skipped", "failed"):
            ev["struck"] = True
        out.append(ev)
        seen.add(shown)
    out.sort(key=lambda x: (x["date"], x["title"]))
    legend = [{"label": name[pid], "series": series[pid], "id": pid} for pid in pids if pid in seen]
    return out, legend
