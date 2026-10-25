// free.js -- the FREE layout: everything at an explicit cell (docs/free-layout.md).
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after group-grid.js (spans, tile cells, resize handles, the packed grid) and
// widget-layout.js (widgetCell, the palette), before main.js.
//
// A free dashboard is one FREE_COLS-wide grid. A tile or widget is on it only
// when it has a cell (x, y); a new free dashboard has none, so it starts empty
// and things are put on it from the palette. Positions are stored, not
// derived: nothing moves unless it is moved.
//
// GROUPS (LAYOUT.free_groups) are rectangles on the same grid:
//   static   a titled frame. What sits inside keeps its own cells and moves
//            with the frame; membership is simply "inside the rectangle".
//   dynamic  a titled box of fixed width. Its members have no cells -- their
//            category is "fg:<id>" -- and are packed inside it in order, like
//            a packed group, so it grows down to fit them.
// Nothing may overlap, except that page items sit inside static frames.
//
// On a phone the cells don't fit: groups and items are drawn in reading order
// (top to bottom, then left to right) in the ordinary packed grid.
'use strict';

var FREE_COLS = 24;             // layouts.py FREE_COLS
var FREE_NARROW = 700;          // px of page below which cells give way to reading order
var FREE_SPARE_ROWS = 6;        // empty rows kept below the lowest item while arranging

function freeMode() { return !!LAYOUT && LAYOUT.mode === 'free' && !ADMIN_MODE; }

function placedCell(x, y) { return x != null && y != null; }

function freeGroups() { return (LAYOUT && LAYOUT.free_groups) || []; }
function freeGroup(id) { return freeGroups().filter(function (g) { return g.id === id; })[0] || null; }

/** The dynamic group an item belongs to, from its category, or null. */
function memberOf(category) {
  var m = /^fg:(.+)$/.exec(category || '');
  var g = m ? freeGroup(m[1]) : null;
  return g && g.kind === 'dynamic' ? g : null;
}

/** What sits directly on the page: [{kind, a|p, x, y, key, shape, size}]. */
function freeItems() {
  var items = [];
  APPS.forEach(function (a) {
    if (!placedCell(a.x, a.y) || memberOf(a.category) || (a.hidden && !arranging())) { return; }
    items.push({ kind: 'app', a: a, x: a.x, y: a.y, key: 'app:' + a.slug, shape: 'tile', size: a.size });
  });
  WIDGETS.placements.forEach(function (p) {
    if (!placedCell(p.x, p.y) || memberOf(p.category) || !widgetVisible(p) || !WIDGETS.defs[p.def_id]) { return; }
    items.push({ kind: 'widget', p: p, x: p.x, y: p.y, key: 'w:' + p.id, shape: shapeOf(p), size: p.size });
  });
  return items.sort(function (i, j) { return (i.y - j.y) || (i.x - j.x); });
}

/** A dynamic group's members, in their order: [tiles], [placements]. */
function groupMembers(g) {
  var cat = 'fg:' + g.id;
  return [sorted(APPS.filter(function (a) { return a.category === cat && (!a.hidden || arranging()); })),
          widgetsIn(cat).filter(function (p) { return widgetVisible(p) && WIDGETS.defs[p.def_id]; })];
}

/** [cols, rows] an item covers, capped to the grid. */
function freeSpan(it) {
  var s = spanOf(it.shape, sizeOf(it.shape, it.size));
  return [Math.min(s[0], FREE_COLS), s[1]];
}

/** Rows a sequence of spans takes in `cols` columns, packed first-fit
 *  row by row (what `grid-auto-flow: row dense` does). */
function packedRows(spans, cols) {
  var used = {}, bottom = 0;
  function free(c, r, w, h) {
    for (var dc = 0; dc < w; dc++) { for (var dr = 0; dr < h; dr++) { if (used[(r + dr) + ':' + (c + dc)]) { return false; } } }
    return true;
  }
  spans.forEach(function (s) {
    var w = Math.min(s[0], cols), h = s[1];
    for (var r = 0; ; r++) {
      for (var c = 0; c + w <= cols; c++) {
        if (free(c, r, w, h)) {
          for (var dc = 0; dc < w; dc++) { for (var dr = 0; dr < h; dr++) { used[(r + dr) + ':' + (c + dc)] = 1; } }
          bottom = Math.max(bottom, r + h);
          return;
        }
      }
    }
  });
  return bottom;
}

/** A group's height as drawn: its own for a static frame; title plus packed
 *  content (at least one row, two while arranging, to drop into) for a
 *  dynamic one. */
function groupHeight(g) {
  if (g.kind !== 'dynamic') { return g.h; }
  var m = groupMembers(g), spans = [];
  m[1].forEach(function (p) { spans.push(spanOf(shapeOf(p), sizeOf(shapeOf(p), p.size))); });
  m[0].forEach(function (a) { spans.push(spanOf('tile', sizeOf('tile', a.size))); });
  return 1 + Math.max(packedRows(spans, g.w), arranging() ? 2 : 1);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function itemRect(it) { var s = freeSpan(it); return { x: it.x, y: it.y, w: s[0], h: s[1] }; }
function groupRect(g) { return { x: g.x, y: g.y, w: g.w, h: groupHeight(g) }; }

/** Whether `rect` may go where it is. An ITEM must not cover another item or
 *  a dynamic group (a static frame is fine: that is how it gets in one). A
 *  GROUP must not cover another group, and a dynamic one no item either.
 *  `skip`: the key of the thing being moved ("app:x", "w:3", "g:id"). */
function freeFits(rect, what, skip) {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > FREE_COLS) { return false; }
  var items = freeItems(), groups = freeGroups();
  var hitsItem = items.some(function (it) { return it.key !== skip && overlaps(rect, itemRect(it)); });
  var hitsGroup = function (onlyDynamic) {
    return groups.some(function (g) {
      return 'g:' + g.id !== skip && (!onlyDynamic || g.kind === 'dynamic') && overlaps(rect, groupRect(g));
    });
  };
  if (what === 'item') { return !hitsItem && !hitsGroup(true); }
  if (what === 'static') { return !hitsGroup(false); }
  return !hitsGroup(false) && !hitsItem;             // dynamic
}

/** Kept for callers that ask about plain items. */
function cellsFree(rect, items, skip) { return freeFits(rect, 'item', skip); }

function saveFreeGroups() {
  return api('PUT', layoutPath('/free-groups'), { groups: freeGroups() })
    .catch(function (e) { alert('Saving the groups failed: ' + e.message); refresh(); });
}

// --- drawing ----------------------------------------------------------------------

function renderFree() {
  var items = freeItems(), groups = freeGroups();
  if (!items.length && !groups.length && !arranging()) {
    out.className = 'msg';
    out.textContent = 'This dashboard is empty. Choose Edit layout from the menu, then drag apps ' +
                      'and widgets onto it from the widgets panel.';
    return;
  }
  if (SEARCH) {
    // A search is a list of matching apps, wherever they sit.
    var all = items.filter(function (i) { return i.kind === 'app'; }).map(function (i) { return i.a; });
    groups.forEach(function (g) { if (g.kind === 'dynamic') { all = all.concat(groupMembers(g)[0]); } });
    var hits = filtered(sorted(all));
    if (!hits.length) { noMatches(); return; }
    out.appendChild(grid(hits));
    return;
  }
  if (out.clientWidth > 0 && out.clientWidth < FREE_NARROW && !arranging()) { renderFreeNarrow(items, groups); return; }

  var ul = document.createElement('ul');
  ul.className = 'ugrid free free-cells';
  ul.dataset.cat = '__free__';
  ul.style.gridTemplateColumns = 'repeat(' + FREE_COLS + ', minmax(0, 1fr))';
  var bottom = 0;
  groups.forEach(function (g) {
    var el = groupEl(g);
    ul.appendChild(el);
    bottom = Math.max(bottom, g.y + groupHeight(g));
  });
  items.forEach(function (it) {
    var el = freeItemEl(it, FREE_COLS);
    el.style.gridColumn = (it.x + 1) + ' / span 1';
    el.style.gridRow = (it.y + 1) + ' / span 1';
    var span = applySpan(el, it.shape, it.size, FREE_COLS);
    bottom = Math.max(bottom, it.y + span[1]);
    if (arranging()) { el.appendChild(resizeHandle(el, it, it.shape, '__free__')); }
    ul.appendChild(el);
  });
  var rows = Math.max(bottom + (arranging() ? FREE_SPARE_ROWS : 0), arranging() ? 12 : 1);
  ul.style.gridTemplateRows = 'repeat(' + rows + ', ' + GRID_ROW + 'px)';
  ul.dataset.rows = rows;
  if (arranging()) { acceptFreeDrops(ul); }
  out.appendChild(ul);
}

/** One page item's element (no position). */
function freeItemEl(it) {
  var el;
  if (it.kind === 'app') {
    el = tile(it.a, { unified: true });
    if (arranging()) { el.appendChild(unplaceButton(it)); }
  } else {
    el = widgetCell(it.p, 'li', sizeOf(it.shape, it.size));
    if (arranging()) { makeWidgetDraggable(el, it.p); }
  }
  el.dataset.key = it.key;
  return el;
}

/** A group: a frame (static) or a box of packed members (dynamic), with its
 *  title -- and while arranging, its controls, a drag handle and a resize
 *  corner. */
function groupEl(g) {
  var el = document.createElement('li');
  el.className = 'fgroup fg-' + g.kind;
  el.dataset.key = 'g:' + g.id;
  el.style.gridColumn = (g.x + 1) + ' / span ' + g.w;
  el.style.gridRow = (g.y + 1) + ' / span ' + groupHeight(g);
  if (g.bg) { paintBg(el, g.bg, 16, '--card', 0.5); }
  var head = document.createElement('div');
  head.className = 'fg-title';
  var name = document.createElement('span');
  name.className = 'fg-name';
  name.textContent = g.name || (arranging() ? 'Untitled group' : '');
  head.appendChild(name);
  el.appendChild(head);
  if (g.kind === 'dynamic') {
    var m = groupMembers(g);
    var inner = groupGrid('fg:' + g.id, m[0], m[1], g.w);
    inner.classList.add('fg-body');
    el.appendChild(inner);
  }
  if (!arranging()) { return el; }

  head.draggable = true;
  head.title = 'Drag to move the group';
  head.addEventListener('dragstart', function (ev) {
    DRAG.fgroup = g.id; DRAG.slug = null; DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false;
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'group:' + g.id); }
  });
  head.addEventListener('dragend', function () { DRAG.fgroup = null; });
  name.title = 'Click to rename';
  name.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var nn = prompt('Group name', g.name || '');
    if (nn == null) { return; }
    g.name = nn.trim();
    render();
    saveFreeGroups();
  });
  var kind = document.createElement('button');
  kind.type = 'button';
  kind.className = 'fg-btn';
  kind.textContent = g.kind === 'dynamic' ? '≡' : '▢';
  kind.title = g.kind === 'dynamic'
    ? 'Growing group: members pack in order and it grows to fit. Click to make it a fixed frame.'
    : 'Fixed frame: things inside keep their places and move with it. Click to make it a growing group.';
  kind.addEventListener('click', function (ev) { ev.stopPropagation(); toggleGroupKind(g); });
  head.appendChild(kind);
  var paint = document.createElement('button');
  paint.type = 'button';
  paint.className = 'fg-btn';
  paint.textContent = '\ud83c\udfa8';
  paint.title = 'Background';
  paint.addEventListener('click', function (ev) {
    ev.stopPropagation();
    bgPicker(paint, g.bg, { image: true, title: 'Group background' }, function (bg) {
      if (bg) { g.bg = bg; } else { delete g.bg; }
      paintBg(el, g.bg || null, 16, '--card', 0.5);
      saveFreeGroups();
    });
  });
  head.appendChild(paint);
  var x = document.createElement('button');
  x.type = 'button';
  x.className = 'fg-btn';
  x.textContent = '×';
  x.title = 'Delete the group';
  x.addEventListener('click', function (ev) { ev.stopPropagation(); deleteGroup(g); });
  head.appendChild(x);
  el.appendChild(groupResizeHandle(el, g));
  return el;
}

/** Fixed <-> growing. Fixed to growing takes in what sits inside the frame
 *  (in reading order); growing to fixed lays its members out where they were
 *  drawn, so nothing jumps. */
function toggleGroupKind(g) {
  var writes = [];
  if (g.kind === 'static') {
    var inside = freeItems().filter(function (it) {
      var r = itemRect(it);
      return r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h;
    });
    g.kind = 'dynamic';
    inside.forEach(function (it, i) { writes.push(joinGroup(it, g, i)); });
    // Then their order, once, in reading order (the page's sequence write).
    var seq = inside.map(function (it) { return it.kind === 'app' ? { app: it.a.slug } : { widget: it.p.id }; });
    if (seq.length) {
      render();
      Promise.all(writes).then(function () { return saveOrder('fg:' + g.id, seq); }).then(saveFreeGroups)
        .catch(function (e) { alert('Saving the group failed: ' + e.message); refresh(); });
      return;
    }
  } else {
    var cells = drawnCells(g);
    g.kind = 'static';
    g.h = Math.max(2, groupHeightWas(g, cells));
    cells.forEach(function (c) { writes.push(leaveGroup(c.key, c.x, c.y)); });
  }
  render();
  Promise.all(writes).then(saveFreeGroups);
}

/** Where a dynamic group's members are drawn now, in page cells. */
function drawnCells(g) {
  var out = [], el = document.querySelector('li.fgroup[data-key="g:' + g.id + '"] ul.fg-body');
  if (!el) { return out; }
  Array.prototype.forEach.call(el.children, function (li) {
    if (!li.dataset.key) { return; }
    var r = li.getBoundingClientRect(), b = el.getBoundingClientRect();
    var colW = (b.width - GRID_GAP * (g.w - 1)) / g.w;
    var x = b.width ? Math.round((r.left - b.left) / (colW + GRID_GAP)) : 0;
    var y = b.width ? Math.round((r.top - b.top) / (GRID_ROW + GRID_GAP)) : out.length * 2;
    out.push({ key: li.dataset.key, x: g.x + x, y: g.y + 1 + y });
  });
  return out;
}
function groupHeightWas(g, cells) {
  var h = 2;
  cells.forEach(function (c) { h = Math.max(h, c.y - g.y + 2); });
  return h;
}

/** Put an item into a dynamic group (no cells), at `ord`. */
function joinGroup(it, g, ord) {
  var cat = 'fg:' + g.id;
  if (it.kind === 'app') {
    var f = Object.assign({}, OVERRIDES[it.a.slug] || {}, { x: null, y: null, category: cat, order: ord });
    OVERRIDES[it.a.slug] = f;
    it.a.x = null; it.a.y = null; it.a.category = cat; it.a.order = ord;
    var o = {}; o[it.a.slug] = f;
    return saveTiles(o);
  }
  it.p.x = null; it.p.y = null; it.p.category = cat; it.p.ord = ord;
  return editPlacement(it.p.id, { x: null, y: null, category: cat });
}

/** Take an item (by key) out of whatever group it is in, to page cells. */
function leaveGroup(key, x, y) {
  if (key.indexOf('app:') === 0) {
    var a = APPS.filter(function (z) { return 'app:' + z.slug === key; })[0];
    if (!a) { return null; }
    var f = Object.assign({}, OVERRIDES[a.slug] || {}, { x: x, y: y, category: null });
    OVERRIDES[a.slug] = f;
    a.x = x; a.y = y; a.category = a.base && a.base.category || '';
    var o = {}; o[a.slug] = f;
    return saveTiles(o);
  }
  var p = WIDGETS.placements.filter(function (z) { return 'w:' + z.id === key; })[0];
  if (!p) { return null; }
  p.x = x; p.y = y; p.category = 'Page';
  return editPlacement(p.id, { x: x, y: y, category: 'Page' });
}

function deleteGroup(g) {
  var m = g.kind === 'dynamic' ? groupMembers(g) : [[], []];
  var n = m[0].length + m[1].length;
  if (!confirm('Delete the group “' + (g.name || 'Untitled') + '”?' +
               (n ? ' Its ' + n + ' item(s) go back to the widgets panel.' : ''))) { return; }
  var writes = [];
  m[0].forEach(function (a) { writes.push(leaveGroup('app:' + a.slug, null, null)); });
  m[1].forEach(function (p) { writes.push(dropPlacement(p.id)); });
  LAYOUT.free_groups = freeGroups().filter(function (x) { return x.id !== g.id; });
  render();
  Promise.all(writes).then(saveFreeGroups).then(function () { return m[1].length ? reloadWidgets() : null; });
}

/** The group's corner: drag to resize by cells -- width and height for a
 *  frame, width only for a growing group (its height is its content). Refused
 *  sizes (covering something) are skipped, not drawn. */
function groupResizeHandle(el, g) {
  var h = document.createElement('span');
  h.className = 'resize-handle';
  h.title = 'Resize the group';
  h.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
  h.addEventListener('pointerdown', function (ev) {
    ev.preventDefault(); ev.stopPropagation();
    var grid = el.parentNode, b = el.getBoundingClientRect(), sx = ev.clientX, sy = ev.clientY;
    var colW = (grid.clientWidth - GRID_GAP * (FREE_COLS - 1)) / FREE_COLS;
    var w0 = g.w, h0 = g.h, done = false;
    if (h.setPointerCapture) { try { h.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ } }
    function move(e) {
      var w = Math.max(2, Math.min(FREE_COLS - g.x, Math.round((b.width + e.clientX - sx + GRID_GAP) / (colW + GRID_GAP))));
      var hh = g.kind === 'dynamic' ? g.h : Math.max(2, Math.round((b.height + e.clientY - sy + GRID_GAP) / (GRID_ROW + GRID_GAP)));
      var keep = { w: g.w, h: g.h };
      g.w = w; g.h = hh;
      if (!freeFits(groupRect(g), g.kind, 'g:' + g.id)) { g.w = keep.w; g.h = keep.h; return; }
      el.style.gridColumn = (g.x + 1) + ' / span ' + g.w;
      el.style.gridRow = (g.y + 1) + ' / span ' + groupHeight(g);
    }
    function up() {
      if (done) { return; }
      done = true;
      ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
        h.removeEventListener(t, t === 'pointermove' ? move : up);
      });
      if (g.w !== w0 || g.h !== h0) { render(); saveFreeGroups(); }
    }
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
    h.addEventListener('lostpointercapture', up);
  });
  return h;
}

/** A phone: everything in reading order. A group is its title over its own
 *  grid (a frame's contents, or a growing group's members); loose items
 *  between groups share a grid. */
function renderFreeNarrow(items, groups) {
  var blocks = [];
  var inFrame = {};
  groups.forEach(function (g) {
    var members;
    if (g.kind === 'dynamic') {
      var m = groupMembers(g);
      members = { tiles: m[0], widgets: m[1] };
    } else {
      members = { tiles: [], widgets: [] };
      items.forEach(function (it) {
        var r = itemRect(it);
        if (r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h) {
          inFrame[it.key] = 1;
          (it.kind === 'app' ? members.tiles : members.widgets).push(it.kind === 'app' ? it.a : it.p);
        }
      });
    }
    blocks.push({ y: g.y, x: g.x, group: g, members: members });
  });
  items.forEach(function (it) { if (!inFrame[it.key]) { blocks.push({ y: it.y, x: it.x, item: it }); } });
  blocks.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
  var loose = null;
  function flush() {
    if (!loose) { return; }
    out.appendChild(groupGrid('__free__', loose.tiles, loose.widgets));
    loose = null;
  }
  blocks.forEach(function (b) {
    if (b.item) {
      loose = loose || { tiles: [], widgets: [] };
      (b.item.kind === 'app' ? loose.tiles : loose.widgets).push(b.item.kind === 'app' ? b.item.a : b.item.p);
      return;
    }
    flush();
    if (b.group.name) {
      var h = document.createElement('h2');
      h.className = 'cat';
      h.textContent = b.group.name;
      out.appendChild(h);
    }
    out.appendChild(groupGrid('fg:' + b.group.id, b.members.tiles, b.members.widgets));
  });
  flush();
}

/** × on a placed tile: off this page (back to the palette), nothing else. */
function unplaceButton(it) {
  var x = document.createElement('button');
  x.type = 'button';
  x.className = 'w-remove';
  x.textContent = '×';
  x.title = 'Take it off this page (it stays in the widgets panel)';
  x.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
  x.addEventListener('click', function (ev) {
    ev.stopPropagation(); ev.preventDefault();
    placeApp(it.a, null, null);
  });
  return x;
}

/** A tile to a cell, or off the page (null, null). Out of any group; its
 *  other fields stay. */
function placeApp(a, x, y) {
  var f = Object.assign({}, OVERRIDES[a.slug] || {}, { x: x, y: y });
  if (memberOf(f.category || a.category)) { f.category = null; a.category = (a.base && a.base.category) || ''; }
  OVERRIDES[a.slug] = f;
  a.x = x; a.y = y;
  render();
  if (arranging()) { buildWidgetLibrary(); }
  var o = {}; o[a.slug] = f;
  return saveTiles(o).catch(function (e) { alert('Saving the position failed: ' + e.message); refresh(); });
}

// --- dropping on the page -----------------------------------------------------------

/** What is being dragged, as {key, what, span} or null. */
function draggedThing() {
  function s(shape, size) { var sp = spanOf(shape, sizeOf(shape, size)); return [Math.min(sp[0], FREE_COLS), sp[1]]; }
  if (DRAG.slug) {
    var a = APPS.filter(function (x) { return x.slug === DRAG.slug; })[0];
    return a ? { key: 'app:' + a.slug, what: 'item', span: s('tile', a.size) } : null;
  }
  if (DRAG.widget) {
    var p = WIDGETS.placements.filter(function (x) { return x.id === DRAG.widget; })[0];
    return p ? { key: 'w:' + p.id, what: 'item', span: s(shapeOf(p), p.size) } : null;
  }
  if (DRAG.def) {
    var d = WIDGETS.defs[DRAG.def];
    return d ? { key: 'def', what: 'item', span: s(d.shape || 'unknown', null) } : null;
  }
  if (DRAG.newWidget) { return { key: 'new', what: 'item', span: s('unknown', null) }; }
  if (DRAG.newGroup) { return { key: 'newgroup', what: 'static', span: [8, 4] }; }
  if (DRAG.fgroup) {
    var g = freeGroup(DRAG.fgroup);
    return g ? { key: 'g:' + g.id, what: g.kind, span: [g.w, groupHeight(g)], group: g } : null;
  }
  return null;
}
// Older name, used by tests.
function draggedItem() { return draggedThing(); }

/** The cell under the pointer, from the grid's box and its tracks. */
function cellAt(ul, ev) {
  var b = ul.getBoundingClientRect();
  var colW = (b.width - GRID_GAP * (FREE_COLS - 1)) / FREE_COLS;
  var x = Math.floor((ev.clientX - b.left + GRID_GAP / 2) / (colW + GRID_GAP));
  var y = Math.floor((ev.clientY - b.top + GRID_GAP / 2) / (GRID_ROW + GRID_GAP));
  return [Math.max(0, isFinite(x) ? x : 0), Math.max(0, isFinite(y) ? y : 0)];
}

/** Drop anywhere on the grid: the dragged thing's top-left goes to the cell
 *  under the pointer, snapped, if it fits there (freeFits). A ghost shows
 *  where, red when it won't. A drop INSIDE a growing group belongs to that
 *  group's own grid (group-grid.js acceptDrops), and onto its title appends. */
function acceptFreeDrops(ul) {
  var ghost = document.createElement('li');
  ghost.className = 'free-ghost';
  ghost.hidden = true;
  ul.appendChild(ghost);
  var at = null;
  function inGroupGrid(ev) {
    var inner = ev.target && ev.target.closest ? ev.target.closest('ul.ugrid') : null;
    return inner && inner !== ul;
  }
  function onDynTitle(ev) {
    var li = ev.target && ev.target.closest ? ev.target.closest('li.fg-dynamic') : null;
    return li && ul.contains(li) && !DRAG.fgroup && !DRAG.newGroup ? freeGroup(li.dataset.key.slice(2)) : null;
  }
  function target(ev) {
    var t = draggedThing();
    if (!t) { return null; }
    var c = cellAt(ul, ev);
    var w = Math.min(t.span[0], FREE_COLS);
    var rect = { x: Math.min(c[0], FREE_COLS - w), y: c[1], w: w, h: t.span[1] };
    rect.ok = freeFits(rect, t.what, t.key);
    rect.t = t;
    return rect;
  }
  ul.addEventListener('dragenter', function (ev) { if (draggedThing()) { ev.preventDefault(); } });
  ul.addEventListener('dragover', function (ev) {
    if (inGroupGrid(ev)) { ghost.hidden = true; return; }
    if (onDynTitle(ev)) { ev.preventDefault(); ghost.hidden = true; return; }
    at = target(ev);
    if (!at) { return; }
    ev.preventDefault();
    // The drop effect MUST be one the drag allowed -- "+ Group" and "New
    // widget" start as copy, the rest as move -- or Chrome silently refuses
    // the drop with a normal cursor all the way (the v1.10.0 "+ Group" bug).
    if (ev.dataTransfer) { ev.dataTransfer.dropEffect = at.ok ? dropEffectFor() : 'none'; }
    ghost.hidden = false;
    ghost.classList.toggle('bad', !at.ok);
    ghost.style.gridColumn = (at.x + 1) + ' / span ' + at.w;
    ghost.style.gridRow = (at.y + 1) + ' / span ' + at.h;
  });
  ul.addEventListener('dragleave', function (ev) {
    if (ev.relatedTarget && ul.contains(ev.relatedTarget)) { return; }
    ghost.hidden = true;
  });
  ul.addEventListener('drop', function (ev) {
    if (inGroupGrid(ev)) { return; }                 // the group's grid handled it
    ghost.hidden = true;
    var dyn = onDynTitle(ev);
    if (dyn) {
      ev.preventDefault();
      var key = dragKey();
      DRAG.slug = null; DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false;
      if (key) { placeInGroup('fg:' + dyn.id, key, null); }
      return;
    }
    var r = target(ev) || at;
    if (!r) { return; }
    ev.preventDefault();
    var slug = DRAG.slug, wid = DRAG.widget, def = DRAG.def, fresh = DRAG.newWidget,
        newGroup = DRAG.newGroup, gid = DRAG.fgroup;
    DRAG.slug = null; DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false;
    DRAG.newGroup = false; DRAG.fgroup = null;
    if (!r.ok) { return; }                         // the ghost was red: refused, nothing moves
    if (slug) {
      var a = APPS.filter(function (x) { return x.slug === slug; })[0];
      if (a) { placeApp(a, r.x, r.y); }
    } else if (wid) {
      var p = WIDGETS.placements.filter(function (x) { return x.id === wid; })[0];
      if (!p) { return; }
      var body = { x: r.x, y: r.y };
      if (memberOf(p.category)) { body.category = 'Page'; p.category = 'Page'; }
      p.x = r.x; p.y = r.y;
      render();
      editPlacement(p.id, body).catch(function (e) { alert('Move failed: ' + e.message); refresh(); });
    } else if (def) {
      placeDefAt(def, r.x, r.y);
    } else if (fresh) {
      widgetDesigner(null, null, { onCreate: function (id) { placeDefAt(id, r.x, r.y); } });
    } else if (newGroup) {
      LAYOUT.free_groups = freeGroups().concat([{ id: newGroupId(), name: 'New group', kind: 'static',
                                                   x: r.x, y: r.y, w: r.w, h: r.h }]);
      render();
      saveFreeGroups();
    } else if (gid) {
      moveGroup(freeGroup(gid), r.x, r.y);
    }
  });
}

/** Move a group; a frame takes what is inside it along. */
function moveGroup(g, x, y) {
  if (!g) { return; }
  var dx = x - g.x, dy = y - g.y, writes = [];
  if (g.kind === 'static') {
    freeItems().forEach(function (it) {
      var r = itemRect(it);
      if (r.x >= g.x && r.y >= g.y && r.x + r.w <= g.x + g.w && r.y + r.h <= g.y + g.h) {
        writes.push(leaveGroup(it.key, it.x + dx, it.y + dy));
      }
    });
  }
  g.x = x; g.y = y;
  render();
  Promise.all(writes).then(saveFreeGroups);
}

/** The effect a drop answers with: the one the current drag started with. */
function dropEffectFor() { return DRAG.def || DRAG.newWidget || DRAG.newGroup ? 'copy' : 'move'; }

function newGroupId() { return Math.random().toString(36).slice(2, 10) || 'g' + Date.now().toString(36); }

function placeDefAt(defId, x, y) {
  return api('POST', layoutPath('/placements'), { def_id: defId, category: 'Page', x: x, y: y })
    .then(function () { return reloadWidgets(); })
    .catch(function (e) { alert('Add failed: ' + e.message); });
}

/** After an item is dropped INTO a growing group (group-grid.js placeInGroup):
 *  it keeps no page cells. */
function freeJoined(it) {
  if (it.kind === 'app' && placedCell(it.a.x, it.a.y)) {
    var f = Object.assign({}, OVERRIDES[it.a.slug] || {}, { x: null, y: null });
    OVERRIDES[it.a.slug] = f;
    it.a.x = null; it.a.y = null;
    var o = {}; o[it.a.slug] = f;
    return saveTiles(o);
  }
  if (it.kind === 'widget' && placedCell(it.p.x, it.p.y)) {
    it.p.x = null; it.p.y = null;
    return editPlacement(it.p.id, { x: null, y: null });
  }
  return null;
}

// --- the palette's part -------------------------------------------------------------

/** The palette's apps, on a free dashboard: everything you can reach that is
 *  not on this page yet, to drag on. */
function freePaletteApps() {
  return APPS.filter(function (a) { return !placedCell(a.x, a.y) && !memberOf(a.category); })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function paletteAppItem(a) {
  var li = document.createElement('li');
  li.className = 'wl-drag wl-app';
  li.draggable = true;
  li.appendChild(tileIcon(a));
  var name = document.createElement('span');
  name.className = 'wl-name';
  name.textContent = a.name;
  li.appendChild(name);
  var tag = document.createElement('span');
  tag.className = 'wl-tag';
  tag.textContent = 'App';
  li.appendChild(tag);
  li.addEventListener('dragstart', function (ev) {
    DRAG.slug = a.slug; DRAG.widget = null; DRAG.def = null; DRAG.group = null; DRAG.newWidget = false;
    DRAG.newGroup = false; DRAG.fgroup = null;
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', a.slug); }
  });
  li.addEventListener('dragend', function () { DRAG.slug = null; });
  return li;
}

/** "+ Group": drag onto the page to draw a fixed frame there. */
function newGroupButton() {
  var b = document.createElement('button');
  b.type = 'button';
  b.id = 'group-new';
  b.className = 'wl-new';
  b.textContent = '+ Group';
  b.title = 'Drag onto the page to add a group (a frame; switch it to growing from its title)';
  b.draggable = true;
  b.addEventListener('dragstart', function (ev) {
    DRAG.newGroup = true; DRAG.slug = null; DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false; DRAG.fgroup = null;
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData('text/plain', 'new-group'); }
  });
  b.addEventListener('dragend', function () { DRAG.newGroup = false; });
  return b;
}

// The page's width decides cells vs reading order; re-draw when it crosses.
(function () {
  var wasNarrow = null;
  window.addEventListener('resize', function () {
    if (!freeMode()) { return; }
    var n = out.clientWidth > 0 && out.clientWidth < FREE_NARROW;
    if (n !== wasNarrow) { wasNarrow = n; render(); }
  });
})();
