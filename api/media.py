"""The *arr calendars and Seerr's requests, as widget payloads.

STANDARD LIBRARY ONLY (CI runs these tests without pip): the HTTP lives in
providers.py, and this turns what Sonarr, Radarr, Lidarr and Seerr answer into
what the renderers draw.

Calendar events carry either `at` (an instant: Sonarr's air time, UTC) or
`date` (a day: Radarr's and Lidarr's release dates, which the APIs send as UTC
midnight and mean as a calendar day). The browser buckets `at` by the VIEWER's
local day; `date` is never shifted -- a film out on the 14th is out on the 14th
in every time zone.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

# Wide enough for one step back and one forward whatever the viewer's zone:
# the PREVIOUS month's grid starts up to a week before its 1st (at most 67
# days back from today) and the NEXT month's ends up to a week after its last
# day (at most 67 on); weeks reach about nine either way. Today is UTC's; a few
# days of slack cover the zones. The page steps no further than `range`.
BACK, AHEAD = 70, 70
MAX_EVENTS = 800

KINDS = {"tv": "sonarr", "movies": "radarr", "music": "lidarr"}

RADARR_DATES = (("inCinemas", "In cinemas"), ("digitalRelease", "Digital"),
                ("physicalRelease", "Physical"))


def window(today: dt.date) -> tuple[str, str]:
    return ((today - dt.timedelta(days=BACK)).isoformat(),
            (today + dt.timedelta(days=AHEAD)).isoformat())


def day(value: Any) -> str | None:
    """'2026-10-14T00:00:00Z' -> '2026-10-14'."""
    return value[:10] if isinstance(value, str) and len(value) >= 10 else None


def sonarr_events(episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One event per series per air time: a season dropped at once is one
    line ("S02E01-E08"), not eight."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for e in episodes:
        series = (e.get("series") or {}).get("title") or "Unknown series"
        at = e.get("airDateUtc")
        if not at:
            continue
        groups.setdefault((series, at), []).append(e)
    out = []
    for (series, at), eps in groups.items():
        eps.sort(key=lambda e: (e.get("seasonNumber") or 0, e.get("episodeNumber") or 0))
        first, last = eps[0], eps[-1]
        code = f"S{first.get('seasonNumber', 0):02d}E{first.get('episodeNumber', 0):02d}"
        if len(eps) > 1:
            code += f"–E{last.get('episodeNumber', 0):02d}"
            sub = f"{code} · {len(eps)} episodes"
        else:
            sub = f"{code} · {first.get('title') or 'TBA'}"
        out.append({"kind": "tv", "at": at, "date": day(first.get("airDate")) or day(at),
                    "title": series, "sub": sub,
                    "done": all(e.get("hasFile") for e in eps)})
    return out


def radarr_events(movies: list[dict[str, Any]], start: str, end: str) -> list[dict[str, Any]]:
    """Radarr's calendar returns a film when ANY of its dates is in range; each
    date in range is its own event, labelled with what kind of release it is."""
    out = []
    for m in movies:
        name = m.get("title") or "Unknown film"
        if m.get("year"):
            name = f"{name} ({m['year']})"
        for key, what in RADARR_DATES:
            d = day(m.get(key))
            if d and start <= d <= end:
                out.append({"kind": "movie", "date": d, "title": name, "sub": what,
                            "done": bool(m.get("hasFile"))})
    return out


def lidarr_events(albums: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for a in albums:
        d = day(a.get("releaseDate"))
        if not d:
            continue
        artist = (a.get("artist") or {}).get("artistName") or "Unknown artist"
        stats = a.get("statistics") or {}
        out.append({"kind": "music", "date": d, "title": a.get("title") or "Untitled",
                    "sub": artist, "done": (stats.get("trackFileCount") or 0) > 0})
    return out


def calendar(parts: list[list[dict[str, Any]]], label: str, view: str,
             warnings: list[str], span: tuple[str, str] | None = None) -> dict[str, Any]:
    events = [e for p in parts for e in p]
    events.sort(key=lambda e: (e.get("at") or e["date"], e["title"]))
    out = {"label": label, "view": view, "events": events[:MAX_EVENTS],
           "truncated": max(0, len(events) - MAX_EVENTS), "warnings": warnings}
    if span:
        # The days asked for, a day in from each end for the viewer's zone:
        # the page's previous/next stop where the data does.
        out["range"] = [(dt.date.fromisoformat(span[0]) + dt.timedelta(days=1)).isoformat(),
                        (dt.date.fromisoformat(span[1]) - dt.timedelta(days=1)).isoformat()]
    return out


# --- Seerr ----------------------------------------------------------------------
#
# MediaRequestStatus and MediaStatus, seerr-team/seerr server/constants/media.ts.
# What a requester cares about is whether they can watch it yet, so an
# available title says so whatever the request's own state.

REQUEST = {1: ("Pending", "warn"), 2: ("Approved", "good"), 3: ("Declined", "muted"),
           4: ("Failed", "crit"), 5: ("Completed", "good")}
MEDIA = {3: ("Processing", "good"), 4: ("Partly available", "good"), 5: ("Available", "good"),
         6: ("Blocklisted", "muted"), 7: ("Deleted", "muted")}

SEERR_FILTERS = ("all", "pending", "approved", "processing", "available", "unavailable", "failed")


def ago(when: str | None, now: dt.datetime) -> str:
    if not when:
        return ""
    try:
        t = dt.datetime.fromisoformat(when.replace("Z", "+00:00"))
    except ValueError:
        return ""
    s = (now - t).total_seconds()
    if s < 3600:
        return f"{max(1, int(s // 60))}m ago"
    if s < 86400:
        return f"{int(s // 3600)}h ago"
    if s < 86400 * 60:
        return f"{int(s // 86400)}d ago"
    return t.strftime("%b %Y")


def seerr_state(req: dict[str, Any]) -> tuple[str, str]:
    media = (req.get("media") or {}).get("status")
    if req.get("status") in (1, 3, 4):      # pending, declined, failed: the request is the news
        return REQUEST[req["status"]]
    return MEDIA.get(media) or REQUEST.get(req.get("status"), ("Unknown", "muted"))


def seerr_item(req: dict[str, Any], detail: dict[str, Any] | None, public: str,
               now: dt.datetime) -> dict[str, Any]:
    media = req.get("media") or {}
    kind = req.get("type") or media.get("mediaType") or "movie"
    detail = detail or {}
    title = detail.get("title") or detail.get("name") or f"TMDB {media.get('tmdbId')}"
    year = (detail.get("releaseDate") or detail.get("firstAirDate") or "")[:4]
    if year:
        title = f"{title} ({year})"
    who = (req.get("requestedBy") or {})
    who = who.get("displayName") or who.get("username") or "someone"
    seasons = [s.get("seasonNumber") for s in req.get("seasons") or [] if s.get("seasonNumber")]
    what = "TV" if kind == "tv" else "Film"
    if seasons:
        what += " · S" + ", S".join(str(n) for n in sorted(seasons)[:4]) + \
            ("…" if len(seasons) > 4 else "")
    text, level = seerr_state(req)
    item = {"label": title, "sub": f"{what} · {who} · {ago(req.get('createdAt'), now)}",
            "badge": {"text": text, "level": level}}
    if media.get("tmdbId"):
        item["url"] = f"{public}/{'tv' if kind == 'tv' else 'movie'}/{media['tmdbId']}"
    return item


def seerr_note(counts: dict[str, Any] | None) -> str | None:
    if not counts:
        return None
    p = counts.get("pending") or 0
    return f"{p} pending" if p else "nothing pending"
