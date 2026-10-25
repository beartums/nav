# Free layout — design (not built)

Status: step 1 BUILT in v1.8.0 (2026-10-25) -- dashboards as tabs, free
dashboards (empty at creation, explicit cells on a 24-column grid, drag from
the panel with a snap ghost that turns red on overlap, reading order on a
phone). Not yet: groups inside a free page (static/dynamic), backgrounds,
keyboard moves, free templates.

## The problem with today's grid

Every group is a **packed sequence**: tiles and widgets have an order, and the
packer places each at the first free cell (row-first with `grid-auto-flow: dense`,
or column-first in `packColumns`). Position is *derived* from order and size.
That has two costs:

- **You can't put something somewhere.** You can only put it *before* something,
  and the packer decides where that lands. A big widget leaves a gap, a small tile
  backfills it, and the result reads as random. v1.7.0 renumbers from the
  on-screen order before a drop, which stops other items jumping, but a drop is
  still "insert before", not "put here".
- **Groups are rows of the page.** A group is a heading and a grid below it,
  stacked vertically. Two groups side by side, or a group that's a fixed panel,
  can't be expressed.

## Proposal: a per-layout `mode`, `packed` (today) or `free`

`free` stores **explicit cells** instead of an order. Everything else (tiles,
widgets, sizes, hiding, templates and dashboards) is unchanged, and a layout can
switch back to `packed` (the explicit cells become the order: sorted by row then
column).

### Model

| thing | stored | notes |
|---|---|---|
| page | `cols` (e.g. 48 half-cells), `background` | one grid for the whole page |
| group | `x, y, w, h`, `kind: static \| dynamic`, `background`, `title_shown` | a rectangle on the page grid |
| item (tile / widget) | `group`, `x, y` (inside the group), size as today | `size` keeps meaning a span |

- **Static group**: a fixed rectangle; items inside keep the cells you gave
  them. Overflow is clipped and flagged in edit mode, never reflowed.
- **Dynamic group**: the rectangle's width is fixed, its height grows to fit;
  items inside are **packed** (today's behaviour), so new apps from Authentik
  appear without anyone placing them. The natural home for "Other" and for
  anything a template doesn't know about.
- New tiles a viewer gains (a new Authentik binding) go to their group if it's
  dynamic, else to a dynamic **Inbox** group created on demand. Nothing is ever
  silently dropped off the page.

Storage: `layout_groups (layout_id, name, x, y, w, h, kind, style jsonb)`,
plus `x, y` on `layout_tiles.fields` and `widget_placements`. `style` holds
colours or an image reference; no new table for images (see below).

### Editing

- Drag snaps to the page grid (a group) or the group's grid (an item), with
  the target cells outlined while dragging. A drop onto occupied cells is
  refused (outline turns red) for static groups, and pushes the others down for
  dynamic ones.
- Resizing uses today's corner handle; groups get handles too.
- Keyboard: arrow keys move the focused item one cell; shift+arrows resize.
  Required for accessibility, and the cheapest way to make precise moves.
- Phone width: free layouts don't survive 360px. Below a breakpoint the page
  falls back to `packed` order (groups by `y` then `x`, items likewise). This
  is a rendering rule, not a second stored layout.

### Backgrounds

- Page, group and tile: a colour (theme-aware: stored as a token or two values,
  light and dark) or an image.
- Images: NOT the custom-tile icon path. That shrinks an upload to a 128px
  data URL stored inline, which every viewer fetches on every page load: fine
  for an icon, wrong for a background. Backgrounds need their own small store
  (a `layout_images` table served by URL with caching headers, size-capped and
  re-encoded server side), or a URL to an image hosted elsewhere. `object-fit:
  cover`; text over an image gets a scrim so contrast holds.
- Tiles keep their own colours legible: the tile's text colour is chosen
  against its background, never left to the image.

## Cost and order

1. **Free mode, static groups only, no backgrounds**: page grid, group
   rectangles, explicit item cells, drag-and-snap, keyboard moves, the phone
   fallback. The bulk of the work: the renderer, the editor, a schema change
   with a migration from `packed` (order becomes cells).
2. **Dynamic groups + Inbox**: reuse `packColumns` inside a rectangle.
3. **Backgrounds**: colours first, images second.

Decide before starting: whether a template can be free (and dashboards copied
from it inherit cells), and the page-grid column count (48 half-cells keeps
today's sizes meaningful).
