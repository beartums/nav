// free.js -- the FREE layout: everything at an explicit cell (docs/free-layout.md).
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after group-grid.js (spans, tile cells, resize handles) and widget-layout.js
// (widgetCell, the palette), before main.js.
//
// A free dashboard is one FREE_COLS-wide grid. A tile or widget is on it only
// when it has a cell (x, y); a new free dashboard has none, so it starts empty
// and things are put on it from the palette. Positions are stored, not
// derived: nothing moves unless it is moved. On a phone the cells don't fit,
// so the same items are drawn in reading order (top to bottom, then left to
// right) in the ordinary packed grid.
'use strict';

var FREE_COLS = 24;             // layouts.py FREE_COLS
var FREE_NARROW = 700;          // px of page below which cells give way to reading order
var FREE_SPARE_ROWS = 6;        // empty rows kept below the lowest item while arranging

function freeMode() { return !!LAYOUT && LAYOUT.mode === 'free' && !ADMIN_MODE; }

function placedCell(x, y) { return x != null && y != null; }

/** What is on the page: [{kind, a|p, x, y, key, shape, size}]. */
function freeItems() {
  var items = [];
  APPS.forEach(function (a) {
    if (!placedCell(a.x, a.y) || (a.hidden && !arranging())) { return; }
    items.push({ kind: 'app', a: a, x: a.x, y: a.y, key: 'app:' + a.slug, shape: 'tile', size: a.size });
  });
  WIDGETS.placements.forEach(function (p) {
    if (!placedCell(p.x, p.y) || !widgetVisible(p) || !WIDGETS.defs[p.def_id]) { return; }
    items.push({ kind: 'widget', p: p, x: p.x, y: p.y, key: 'w:' + p.id, shape: shapeOf(p), size: p.size });
  });
  return items.sort(function (i, j) { return (i.y - j.y) || (i.x - j.x); });
}

/** [cols, rows] an item covers, capped to the grid. */
function freeSpan(it) {
  var s = spanOf(it.shape, sizeOf(it.shape, it.size));
  return [Math.min(s[0], FREE_COLS), s[1]];
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether [x, y, w, h] is free of every item but `skip` (a key). */
function cellsFree(rect, items, skip) {
  return items.every(function (it) {
    if (it.key === skip) { return true; }
    var s = freeSpan(it);
    return !overlaps(rect, { x: it.x, y: it.y, w: s[0], h: s[1] });
  });
}

function renderFree() {
  var items = freeItems();
  if (!items.length && !arranging()) {
    out.className = 'msg';
    out.textContent = 'This dashboard is empty. Choose Edit layout from the menu, then drag apps ' +
                      'and widgets onto it from the widgets panel.';
    return;
  }
  if (SEARCH) {
    // A search is a list of matching apps, wherever they sit.
    var hits = filtered(sorted(items.filter(function (i) { return i.kind === 'app'; })
      .map(function (i) { return i.a; })));
    if (!hits.length) { noMatches(); return; }
    out.appendChild(grid(hits));
    return;
  }
  var narrow = out.clientWidth > 0 && out.clientWidth < FREE_NARROW && !arranging();
  var ul = document.createElement('ul');
  ul.className = 'ugrid free' + (narrow ? '' : ' free-cells');
  ul.dataset.cat = '__free__';
  var cols = narrow ? gridCols() : FREE_COLS;
  ul.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  var bottom = 0;
  items.forEach(function (it) {
    var el;
    if (it.kind === 'app') {
      el = tile(it.a, { unified: true });
    } else {
      el = widgetCell(it.p, 'li', sizeOf(it.shape, it.size));
      if (arranging()) { makeWidgetDraggable(el, it.p); }
    }
    el.dataset.key = it.key;
    if (!narrow) {
      el.style.gridColumn = (it.x + 1) + ' / span 1';
      el.style.gridRow = (it.y + 1) + ' / span 1';
    }
    var span = applySpan(el, it.shape, it.size, cols);
    bottom = Math.max(bottom, it.y + span[1]);
    if (arranging()) {
      el.appendChild(resizeHandle(el, it, it.shape, '__free__'));
      if (it.kind === 'app') { el.appendChild(unplaceButton(it)); }
    }
    ul.appendChild(el);
  });
  if (!narrow) {
    var rows = Math.max(bottom + (arranging() ? FREE_SPARE_ROWS : 0), arranging() ? 12 : 1);
    ul.style.gridTemplateRows = 'repeat(' + rows + ', ' + GRID_ROW + 'px)';
    ul.dataset.rows = rows;
  }
  if (arranging()) { acceptFreeDrops(ul, items); }
  out.appendChild(ul);
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

/** A tile to a cell, or off the page (null, null). Its other fields stay. */
function placeApp(a, x, y) {
  var f = Object.assign({}, OVERRIDES[a.slug] || {}, { x: x, y: y });
  OVERRIDES[a.slug] = f;
  a.x = x; a.y = y;
  render();
  if (arranging()) { buildWidgetLibrary(); }
  var o = {}; o[a.slug] = f;
  return saveTiles(o).catch(function (e) { alert('Saving the position failed: ' + e.message); refresh(); });
}

/** What is being dragged, as an item with a span, or null. */
function draggedItem(items) {
  if (DRAG.slug) {
    var a = APPS.filter(function (x) { return x.slug === DRAG.slug; })[0];
    return a ? { key: 'app:' + a.slug, shape: 'tile', size: a.size } : null;
  }
  if (DRAG.widget) {
    var p = WIDGETS.placements.filter(function (x) { return x.id === DRAG.widget; })[0];
    return p ? { key: 'w:' + p.id, shape: shapeOf(p), size: p.size } : null;
  }
  if (DRAG.def) {
    var d = WIDGETS.defs[DRAG.def];
    return d ? { key: 'def', shape: d.shape || 'unknown', size: null } : null;
  }
  if (DRAG.newWidget) { return { key: 'new', shape: 'unknown', size: null }; }
  return null;
}

/** The cell under the pointer, from the grid's box and its tracks. */
function cellAt(ul, ev) {
  var b = ul.getBoundingClientRect();
  var colW = (b.width - GRID_GAP * (FREE_COLS - 1)) / FREE_COLS;
  var x = Math.floor((ev.clientX - b.left + GRID_GAP / 2) / (colW + GRID_GAP));
  var y = Math.floor((ev.clientY - b.top + GRID_GAP / 2) / (GRID_ROW + GRID_GAP));
  return [Math.max(0, isFinite(x) ? x : 0), Math.max(0, isFinite(y) ? y : 0)];
}

/** Drop anywhere on the grid: the dragged thing's top-left goes to the cell
 *  under the pointer, snapped, if the cells it would cover are free. A ghost
 *  shows where, red when it won't fit. */
function acceptFreeDrops(ul, items) {
  var ghost = document.createElement('li');
  ghost.className = 'free-ghost';
  ghost.hidden = true;
  ul.appendChild(ghost);
  var at = null;
  function target(ev) {
    var it = draggedItem(items);
    if (!it) { return null; }
    var s = spanOf(it.shape, sizeOf(it.shape, it.size));
    var c = cellAt(ul, ev);
    var w = Math.min(s[0], FREE_COLS), x = Math.min(c[0], FREE_COLS - w);
    var rect = { x: x, y: c[1], w: w, h: s[1] };
    rect.ok = cellsFree(rect, items, it.key);
    return rect;
  }
  ul.addEventListener('dragenter', function (ev) { if (draggedItem(items)) { ev.preventDefault(); } });
  ul.addEventListener('dragover', function (ev) {
    at = target(ev);
    if (!at) { return; }
    ev.preventDefault();
    if (ev.dataTransfer) { ev.dataTransfer.dropEffect = at.ok ? (DRAG.def || DRAG.newWidget ? 'copy' : 'move') : 'none'; }
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
    var r = target(ev) || at;
    ghost.hidden = true;
    if (!r) { return; }
    ev.preventDefault();
    var slug = DRAG.slug, wid = DRAG.widget, def = DRAG.def, fresh = DRAG.newWidget;
    DRAG.slug = null; DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false;
    if (!r.ok) { return; }                         // the ghost was red: refused, nothing moves
    if (slug) {
      var a = APPS.filter(function (x) { return x.slug === slug; })[0];
      if (a) { placeApp(a, r.x, r.y); }
    } else if (wid) {
      var p = WIDGETS.placements.filter(function (x) { return x.id === wid; })[0];
      if (!p) { return; }
      p.x = r.x; p.y = r.y;
      render();
      editPlacement(p.id, { x: r.x, y: r.y }).catch(function (e) { alert('Move failed: ' + e.message); refresh(); });
    } else if (def) {
      placeDefAt(def, r.x, r.y);
    } else if (fresh) {
      widgetDesigner(null, null, { onCreate: function (id) { placeDefAt(id, r.x, r.y); } });
    }
  });
}

function placeDefAt(defId, x, y) {
  return api('POST', layoutPath('/placements'), { def_id: defId, category: 'Page', x: x, y: y })
    .then(function () { return reloadWidgets(); })
    .catch(function (e) { alert('Add failed: ' + e.message); });
}

/** The palette's apps, on a free dashboard: everything you can reach that is
 *  not on this page yet, to drag on. */
function freePaletteApps() {
  return sorted(APPS.filter(function (a) { return !placedCell(a.x, a.y); }))
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
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', a.slug); }
  });
  li.addEventListener('dragend', function () { DRAG.slug = null; });
  return li;
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
