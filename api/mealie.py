"""Mealie's meal plan and recipe comments, as list payloads.

STANDARD LIBRARY ONLY (see media.py). Checked against Mealie v2.8.0
(the Mealie deployment): GET /api/households/mealplans takes
start_date / end_date, GET /api/comments pages with perPage / orderBy, and
responses are camelCase (entryType, recipeId, createdAt, fullName). Both
spellings are read, so a release that changes casing degrades to a blank field
rather than a broken widget.

The API token is ONE Mealie user's: the plan is that user's household's, and
the comments are whatever that user can read.
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from media import ago

MEALS = ("breakfast", "lunch", "dinner", "side")
ORDER = {m: i for i, m in enumerate(MEALS)}
DAYS = {"today": 1, "3 days": 3, "week": 7}


def get(d: dict[str, Any], camel: str, snake: str) -> Any:
    return d.get(camel, d.get(snake))


def day_name(d: str, today: dt.date) -> str:
    try:
        when = dt.date.fromisoformat(d)
    except ValueError:
        return d
    n = (when - today).days
    if n == 0:
        return "Today"
    if n == 1:
        return "Tomorrow"
    return when.strftime("%A %-d %b") if n < 7 else when.strftime("%a %-d %b")


def recipe_url(public: str, group: str | None, slug: str | None) -> str | None:
    return f"{public}/g/{group}/r/{slug}" if group and slug else None


def plan_items(entries: list[dict[str, Any]], meals: str, today: dt.date,
               public: str, group: str | None) -> list[dict[str, Any]]:
    """Grouped by day (`section`), meals in breakfast-to-side order. A note
    entry (no recipe) shows its own title."""
    rows = []
    for e in entries:
        kind = get(e, "entryType", "entry_type") or "dinner"
        if meals == "dinner" and kind != "dinner":
            continue
        recipe = e.get("recipe") or {}
        name = recipe.get("name") or e.get("title") or "(untitled)"
        item = {"label": name, "section": day_name(e.get("date") or "", today),
                "value": kind.capitalize() if meals != "dinner" else None,
                "_k": (e.get("date") or "", ORDER.get(kind, 9))}
        text = (e.get("text") or "").strip()
        if text:
            item["sub"] = text[:120]
        url = recipe_url(public, group, recipe.get("slug"))
        if url:
            item["url"] = url
        rows.append(item)
    rows.sort(key=lambda r: r.pop("_k"))
    return [{k: v for k, v in r.items() if v is not None} for r in rows]


def comment_items(comments: list[dict[str, Any]], recipes: dict[str, dict[str, Any]],
                  now: dt.datetime, public: str, group: str | None) -> list[dict[str, Any]]:
    out = []
    for c in comments:
        user = c.get("user") or {}
        who = get(user, "fullName", "full_name") or user.get("username") or "someone"
        rid = str(get(c, "recipeId", "recipe_id") or "")
        recipe = recipes.get(rid) or {}
        item = {"label": recipe.get("name") or "a recipe",
                "sub": (c.get("text") or "").strip()[:160],
                "value": f"{who} · {ago(get(c, 'createdAt', 'created_at'), now)}"}
        url = recipe_url(public, group, recipe.get("slug"))
        if url:
            item["url"] = url
        out.append(item)
    return out
