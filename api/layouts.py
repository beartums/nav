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
#
# `image` is a tile's background picture (an https link or an uploaded one,
# clean_image), drawn under a veil of the card so the name stays readable.
#
# `text_style` is how the tile's own text looks, {name?, desc?}, each a text
# style (clean_text_style); unset parts come from its group's (group_style).
OVERRIDABLE = ("name", "description", "category", "icon", "icon_light", "colour", "image",
               "hidden", "size", "frameable", "order", "above_fold", "x", "y", "text_style")
LAYOUT_KEYS = ("category", "order", "size", "hidden", "above_fold", "x", "y", "text_style")
PRESENTATION_KEYS = tuple(k for k in OVERRIDABLE if k not in LAYOUT_KEYS)
KINDS = ("template", "dashboard")
NAME_MAX = 60

# A layout's MODE. `packed`: groups of tiles in a sequence, placed by the
# packer (everything until 2026-10-25). `free`: everything at explicit cells
# on one FREE_COLS-wide grid, and nothing on it until someone puts it there --
# a new free dashboard is empty. Dashboards only, for now.
MODES = ("packed", "free")
FREE_COLS = 24
# A free layout's column count is its own (layouts.free_cols), one of these;
# a finer grid is more, narrower columns. Cells are checked against the most
# any layout may have; the page keeps each layout within its own count.
FREE_COLS_CHOICES = (12, 16, 24, 32, 36, 48)
FREE_COLS_MAX = max(FREE_COLS_CHOICES)
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
    if "image" in raw:
        raw["image"] = clean_image(raw["image"])
    if "x" in raw:
        raw["x"] = clean_cell(raw["x"], "x", FREE_COLS_MAX)
    if "y" in raw:
        raw["y"] = clean_cell(raw["y"], "y", FREE_ROWS_MAX)
    if "text_style" in raw:
        raw["text_style"] = clean_tile_style(raw["text_style"])
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
# `shape`: a drawn rectangle, ellipse or line (its `look`) that sits on a
# layer -- behind the tiles (z < 0) or in front of them (z > 0), ordered by z
# within it. Shapes overlap anything; they hold nothing.
FREE_GROUP_KINDS = ("static", "dynamic", "shape")
FREE_GROUPS_MAX = 120
SHAPE_FORMS = ("rect", "round", "ellipse", "hline", "vline")
LINE_STYLES = ("solid", "dashed", "dotted")
LINE_W_MAX = 16
Z_MAX = 200
# Besides the colours, a shape may take the theme's own: its text, its muted
# text, its card -- so a line drawn in "ink" follows light and dark mode.
SHAPE_INKS = ("ink", "muted", "card")
GROUP_ID = re.compile(r"^[a-z0-9]{1,16}$")


def clean_free_groups(raw: Any, cols: int = FREE_COLS) -> list[dict[str, Any]]:
    """The whole list, validated: ids unique, cells inside `cols` columns, kinds known."""
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
        x = clean_cell(g.get("x"), "x", cols)
        y = clean_cell(g.get("y"), "y", FREE_ROWS_MAX)
        w = clean_cell(g.get("w"), "w", cols + 1)
        h = clean_cell(g.get("h"), "h", FREE_ROWS_MAX)
        if x is None or y is None or not w or not h or x + w > cols:
            raise ValueError(f"group {gid}: needs x, y, w >= 1 and h >= 1 inside the {cols} columns")
        item = {"id": gid, "name": name, "kind": kind, "x": x, "y": y, "w": w, "h": h}
        if kind == "shape":
            item["name"] = ""
            item["look"] = clean_look(g.get("look"), gid)
            z = g.get("z")
            if not isinstance(z, int) or isinstance(z, bool) or not z or abs(z) > Z_MAX:
                raise ValueError(f"shape {gid}: z must be a whole number from -{Z_MAX} to {Z_MAX}, not 0")
            item["z"] = z
            out.append(item)
            continue
        bg = clean_bg(g.get("bg"))
        if bg:
            item["bg"] = bg
        out.append(item)
    return out


def clean_look(v: Any, gid: str) -> dict[str, Any]:
    """A shape's look: {form, fill?, fill_a, line?, line_w, line_s}. A colour
    left out is none (transparent); fill_a is the fill's opacity, 0-100."""
    v = v if isinstance(v, dict) else {}
    extra = set(v) - {"form", "fill", "fill_a", "line", "line_w", "line_s"}
    if extra:
        raise ValueError(f"shape {gid}: unknown look keys {sorted(extra)}")
    form = v.get("form") or "rect"
    if form not in SHAPE_FORMS:
        raise ValueError(f"shape {gid}: form must be one of {list(SHAPE_FORMS)}")
    line_s = v.get("line_s") or "solid"
    if line_s not in LINE_STYLES:
        raise ValueError(f"shape {gid}: line style must be one of {list(LINE_STYLES)}")

    def num(key: str, lo: int, hi: int, default: int) -> int:
        n = v.get(key, default)
        if not isinstance(n, int) or isinstance(n, bool) or not lo <= n <= hi:
            raise ValueError(f"shape {gid}: {key} must be a whole number {lo}-{hi}")
        return n
    out: dict[str, Any] = {"form": form, "fill_a": num("fill_a", 0, 100, 100),
                           "line_w": num("line_w", 0, LINE_W_MAX, 2), "line_s": line_s}
    for key in ("fill", "line"):
        c = v.get(key)
        c = c if c in SHAPE_INKS else clean_colour(c)
        if c:
            out[key] = c
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


def clean_image(img: Any) -> str | None:
    """A background picture: an https link elsewhere, or one uploaded to nav."""
    if img in (None, ""):
        return None
    if (not isinstance(img, str) or len(img) > IMG_MAX or
            not (img.startswith("https://") or UPLOADED.match(img))):
        raise ValueError(f"a background image is an https:// URL of at most {IMG_MAX} characters, "
                         f"or an uploaded one")
    return img


def clean_bg(v: Any) -> dict[str, Any] | None:
    """{c?, img?} or None. Nothing set is None, so "no background" is one value."""
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict) or set(v) - {"c", "img"}:
        raise ValueError("a background is {c, img}")
    c = clean_colour(v.get("c"))
    img = clean_image(v.get("img"))
    out = {k: x for k, x in (("c", c), ("img", img)) if x}
    return out or None


# --- text styles, and groups inside groups ---------------------------------------
#
# A TEXT STYLE is a small dict; every key is optional and an unset key inherits
# (tile <- its group <- the page). Values are a closed set, so what reaches the
# page's style attribute is always one of these, never free CSS.
FONTS = ("system", "serif", "mono", "rounded", "condensed")
WEIGHTS = (300, 400, 500, 600, 700, 800)
ALIGNS = ("left", "center", "right")
CASES = ("none", "upper", "lower", "title")
SIZE_PX = (8, 72)
STYLE_KEYS = ("font", "size", "weight", "italic", "colour", "align", "case")
# A tile's text has two parts; a group adds its heading.
TILE_PARTS = ("name", "desc")
GROUP_PARTS = ("heading", "name", "desc")


def clean_text_style(v: Any) -> dict[str, Any] | None:
    """One text style, or None when nothing is set."""
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict) or set(v) - set(STYLE_KEYS):
        raise ValueError(f"a text style has only {', '.join(STYLE_KEYS)}")
    out: dict[str, Any] = {}
    if v.get("font") not in (None, ""):
        if v["font"] not in FONTS:
            raise ValueError(f"font is one of {', '.join(FONTS)}")
        out["font"] = v["font"]
    if v.get("size") not in (None, ""):
        if isinstance(v["size"], bool) or not isinstance(v["size"], int) or not SIZE_PX[0] <= v["size"] <= SIZE_PX[1]:
            raise ValueError(f"size is a whole number of pixels, {SIZE_PX[0]} to {SIZE_PX[1]}")
        out["size"] = v["size"]
    if v.get("weight") not in (None, ""):
        if v["weight"] not in WEIGHTS or isinstance(v["weight"], bool):
            raise ValueError(f"weight is one of {', '.join(map(str, WEIGHTS))}")
        out["weight"] = v["weight"]
    if v.get("italic") is not None:
        if not isinstance(v["italic"], bool):
            raise ValueError("italic is true or false")
        out["italic"] = v["italic"]
    if v.get("colour") not in (None, ""):
        c = v["colour"]
        if not (isinstance(c, str) and HEX.match(c)):
            raise ValueError("a text colour is #rrggbb")
        out["colour"] = c.lower()
    for key, allowed in (("align", ALIGNS), ("case", CASES)):
        if v.get(key) not in (None, ""):
            if v[key] not in allowed:
                raise ValueError(f"{key} is one of {', '.join(allowed)}")
            out[key] = v[key]
    return out or None


def _parts(v: Any, parts: tuple[str, ...], what: str) -> dict[str, Any] | None:
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict) or set(v) - set(parts):
        raise ValueError(f"{what} has only {', '.join(parts)}")
    out = {p: s for p in parts if (s := clean_text_style(v.get(p)))}
    return out or None


def clean_tile_style(v: Any) -> dict[str, Any] | None:
    """A tile's {name?, desc?} styles."""
    return _parts(v, TILE_PARTS, "a tile's text style")


GROUPS_MAX = 200


def clean_group_style(raw: Any) -> dict[str, dict[str, Any]]:
    """{group: {heading?, name?, desc?}}: each group's heading, and the default
    for its tiles' text. Groups with nothing set are dropped."""
    if not isinstance(raw, dict) or len(raw) > GROUPS_MAX:
        raise ValueError("group styles are {group: {heading, name, desc}}")
    out = {}
    for g, v in raw.items():
        if not isinstance(g, str) or not g.strip():
            raise ValueError("a group style needs a group name")
        s = _parts(v, GROUP_PARTS, f"{g}'s style")
        if s:
            out[g.strip()] = s
    return out


def clean_group_parents(raw: Any) -> dict[str, str]:
    """{child: parent}: groups inside groups, ONE level deep. A group with
    subgroups can't itself be inside one, and none is inside itself."""
    if not isinstance(raw, dict) or len(raw) > GROUPS_MAX:
        raise ValueError("group parents are {group: parent group}")
    out: dict[str, str] = {}
    for c, p in raw.items():
        if not isinstance(c, str) or not isinstance(p, str) or not c.strip() or not p.strip():
            raise ValueError("a group and its parent are names")
        c, p = c.strip(), p.strip()
        if c == p:
            raise ValueError(f"{c} can't be inside itself")
        out[c] = p
    for c, p in out.items():
        if p in out:
            raise ValueError(f"{c} can't go inside {p}: {p} is itself inside {out[p]} (one level only)")
    return out
