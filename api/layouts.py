"""Layouts: templates and personal dashboards (roadmap #34, decided 2026-10-11).

A LAYOUT is where tiles and widgets go: per-tile layout fields, the widget
placements, and the group order and hidden groups. Two kinds share it:

  template    admin-owned, named; one is the default. The admin page edits one.
  dashboard   a user's own, named; a FULL COPY of a template taken at creation.
              Later template edits never reach it (the user's call: snapshot,
              not overlay). Revert re-copies.

THE CASCADE, per tile:
  Authentik (or the custom_tiles row) -> admin_overrides, PRESENTATION only
  (name, icon, description...: site-wide) -> the layout's row for that tile.

A dashboard's row may carry every overridable field (users can rename and
re-icon for themselves); a template's carries LAYOUT fields only, because what
a tile is called is site-wide and an admin edits it once, not per template.

A tile with no row in a dashboard -- an app the user gained access to after the
copy -- takes its TEMPLATE's row, so it lands in the right group (at the end,
having no position). It is the whole row or nothing: blending a template's
fields under a dashboard's would make a dashboard an overlay after all, and a
template hiding a tile would reach into dashboards that never hid it.

Standard library only, like widgets.py: CI runs these tests without pip.
"""
from __future__ import annotations

import re
from typing import Any

# `order` is an integer position within a category, set by dragging. merge()
# skips None and "" but NOT 0 -- position zero is a real position, and treating
# it as "unset" would silently pin the first tile in place.
#
# `icon` is the DARK-MODE icon -- it is the one that already existed, and every
# stored value is one. `icon_light` is optional and falls back to `icon`.
#
# `above_fold` keeps a tile visible when its category is collapsed.
#
# `x`, `y` place a tile on a FREE layout's grid (FREE_COLS wide, rows grow
# down); a tile without them is not on a free layout at all. Packed layouts
# ignore them.
OVERRIDABLE = ("name", "description", "category", "icon", "icon_light", "colour",
               "hidden", "size", "frameable", "order", "above_fold", "x", "y")
LAYOUT_KEYS = ("category", "order", "size", "hidden", "above_fold", "x", "y")
PRESENTATION_KEYS = tuple(k for k in OVERRIDABLE if k not in LAYOUT_KEYS)
KINDS = ("template", "dashboard")
NAME_MAX = 60

# A layout's MODE. `packed`: groups of tiles in a sequence, placed by the
# packer (everything until 2026-10-25). `free`: everything at explicit cells
# on one FREE_COLS-wide grid, and nothing on it until someone puts it there --
# a new free dashboard is empty. Dashboards only, for now.
MODES = ("packed", "free")
FREE_COLS = 24
FREE_ROWS_MAX = 500


def clean_cell(v: Any, what: str, hi: int) -> int | None:
    """A grid coordinate: an integer in [0, hi), or None for "not placed"."""
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < hi:
        raise ValueError(f"{what} must be a whole number from 0 to {hi - 1}, or null")
    return v


def merge(base: dict[str, Any], *layers: dict[str, Any]) -> dict[str, Any]:
    """Apply override layers in order, later winning.

    Only keys in OVERRIDABLE, and only when actually set: an override object
    carrying `{"icon": ""}` means "no opinion", not "blank the icon". Without
    that rule an admin who opens the editor and saves erases everything they
    did not touch.
    """
    out = dict(base)
    for layer in layers:
        for k in OVERRIDABLE:
            if k in layer and layer[k] not in (None, ""):
                out[k] = layer[k]
    return out


def split(fields: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """(presentation, layout) halves of one override object."""
    return ({k: v for k, v in fields.items() if k in PRESENTATION_KEYS},
            {k: v for k, v in fields.items() if k in LAYOUT_KEYS})


def allowed_keys(kind: str) -> tuple[str, ...]:
    return OVERRIDABLE if kind == "dashboard" else LAYOUT_KEYS


def tile_fields(kind: str, raw: dict[str, Any] | None) -> dict[str, Any]:
    """The fields a layout of this kind may store for a tile. A presentation
    field on a template is REFUSED rather than dropped: dropped, the rename
    would look saved and silently not be (the 2026-10-11 lesson in
    clean_fields)."""
    raw = dict(raw or {})
    unknown = set(raw) - set(OVERRIDABLE)
    if unknown:
        raise ValueError(f"unknown tile field(s): {', '.join(sorted(unknown))}")
    refused = set(raw) - set(allowed_keys(kind))
    if refused:
        raise ValueError(f"a template stores layout only ({', '.join(LAYOUT_KEYS)}); "
                         f"{', '.join(sorted(refused))} is site-wide -- edit it on the tile")
    if "colour" in raw:
        raw["colour"] = clean_colour(raw["colour"])
    if "x" in raw:
        raw["x"] = clean_cell(raw["x"], "x", FREE_COLS)
    if "y" in raw:
        raw["y"] = clean_cell(raw["y"], "y", FREE_ROWS_MAX)
    return raw


def tile_layer(slug: str, kind: str, own: dict[str, dict[str, Any]],
               template: dict[str, dict[str, Any]], mode: str = "packed") -> dict[str, Any]:
    """The layout row that applies to `slug`: the layout's own, else -- for a
    PACKED dashboard only -- its template's whole row (see the module
    docstring). A free dashboard never falls back: it starts empty, and an app
    gained later waits in the palette rather than landing somewhere."""
    if slug in own:
        return own[slug]
    return template.get(slug, {}) if kind == "dashboard" and mode == "packed" else {}


def clean_name(raw: Any) -> str:
    name = " ".join(str(raw or "").split())
    if not name:
        raise ValueError("a layout needs a name")
    if len(name) > NAME_MAX:
        raise ValueError(f"a layout name is at most {NAME_MAX} characters")
    return name


def clean_groups(raw: Any, what: str) -> list[str]:
    """A list of group names, trimmed, de-duplicated, order kept."""
    if not isinstance(raw, list) or not all(isinstance(g, str) for g in raw):
        raise ValueError(f"{what} must be a list of group names")
    out: list[str] = []
    for g in raw:
        g = g.strip()
        if g and g not in out:
            out.append(g)
    return out


# Groups on a FREE layout: rectangles on the page grid. `static`: a titled
# frame; what sits inside keeps its own cells and moves with the frame.
# `dynamic`: a titled box of fixed width whose members (category "fg:<id>",
# no cells of their own) are packed inside it, and which grows down to fit.
FREE_GROUP_KINDS = ("static", "dynamic")
FREE_GROUPS_MAX = 60
GROUP_ID = re.compile(r"^[a-z0-9]{1,16}$")


def clean_free_groups(raw: Any) -> list[dict[str, Any]]:
    """The whole list, validated: ids unique, cells in range, kinds known."""
    if not isinstance(raw, list) or len(raw) > FREE_GROUPS_MAX:
        raise ValueError(f"groups must be a list of at most {FREE_GROUPS_MAX}")
    out, seen = [], set()
    for i, g in enumerate(raw):
        if not isinstance(g, dict):
            raise ValueError(f"group {i} is not an object")
        gid = str(g.get("id") or "")
        if not GROUP_ID.match(gid) or gid in seen:
            raise ValueError(f"group {i}: id must be 1-16 lower-case letters or digits, unique")
        seen.add(gid)
        kind = g.get("kind") or "static"
        if kind not in FREE_GROUP_KINDS:
            raise ValueError(f"group {gid}: kind must be one of {list(FREE_GROUP_KINDS)}")
        name = " ".join(str(g.get("name") or "").split())[:NAME_MAX]
        x = clean_cell(g.get("x"), "x", FREE_COLS)
        y = clean_cell(g.get("y"), "y", FREE_ROWS_MAX)
        w = clean_cell(g.get("w"), "w", FREE_COLS + 1)
        h = clean_cell(g.get("h"), "h", FREE_ROWS_MAX)
        if x is None or y is None or not w or not h or x + w > FREE_COLS:
            raise ValueError(f"group {gid}: needs x, y, w >= 1 and h >= 1 inside the {FREE_COLS} columns")
        item = {"id": gid, "name": name, "kind": kind, "x": x, "y": y, "w": w, "h": h}
        bg = clean_bg(g.get("bg"))
        if bg:
            item["bg"] = bg
        out.append(item)
    return out


# BACKGROUNDS. A colour is a THEME NAME (drawn from the palette, so it follows
# light and dark mode) or "#rrggbb"; an image is an https URL to a picture
# hosted elsewhere -- nav stores no images. Page and groups take both
# ({"c": ..., "img": ...}); a tile takes a colour, in its `colour` field.
COLOURS = ("blue", "orange", "green", "amber", "pink", "leaf", "violet", "red")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
IMG_MAX = 500
UPLOADED = re.compile(r"^api/images/[0-9a-f]{64}$")     # images.URL


def clean_colour(v: Any) -> str | None:
    if v in (None, ""):
        return None
    if isinstance(v, str) and (v in COLOURS or HEX.match(v)):
        return v.lower() if v.startswith("#") else v
    raise ValueError(f"a colour is one of {list(COLOURS)} or #rrggbb")


def clean_bg(v: Any) -> dict[str, Any] | None:
    """{c?, img?} or None. Nothing set is None, so "no background" is one value."""
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict) or set(v) - {"c", "img"}:
        raise ValueError("a background is {c, img}")
    c = clean_colour(v.get("c"))
    img = v.get("img") or None
    # An https link to a picture elsewhere, or one uploaded to nav (images.py).
    if img is not None and (not isinstance(img, str) or len(img) > IMG_MAX or
                            not (img.startswith("https://") or UPLOADED.match(img))):
        raise ValueError(f"a background image is an https:// URL of at most {IMG_MAX} characters, "
                         f"or an uploaded one")
    out = {k: x for k, x in (("c", c), ("img", img)) if x}
    return out or None
