// group-grid.js -- one grid per group, shared by tiles and widgets (roadmap #34).
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after tiles.js (tile) and widget-layout.js (widgetCell), before main.js.
//
// Everything is an item spanning grid cells. Sizes are named (S/M/L/XL) and
// mean a fixed span per kind, below; the grid packs smaller items into the
// gaps beside bigger ones (grid-auto-flow: dense). Tiles and widgets share ONE
// sequence per group, so a drop renumbers the whole group in one write
// (PUT api/layouts/{id}/order, a single transaction on the server).
//
// Used for the grouped and tabbed views, filling by row or column-first.
// Icons-only and ungrouped keep their own layouts (tiles.js grid() plus
// widget-layout.js widgetRow).
//
// Column-first was left out at first, and it is the layout actually in use --
// so the new grid, handles and all, simply never appeared. It is the same
// grid filling down then across, packed HERE (packColumns) and placed at
// explicit cells. It used to be left to `grid-auto-flow: column dense` with a
// row count guessed from area and grown after layout (fitRows) -- and when
// the growing missed, items spilled into implicit near-zero-width columns: a
// tile drawn narrow but laid out full size, its text cut off at the right.
'use strict';

// Cells are HALF a tile each way: two columns plus the gap (53+10+53) are the
// old 116px column, and two rows plus the gap (33+10+33) the old 76px row. So
// every size kept its footprint as the grid went finer, and an icon-only tile
// (XS) can take a single small cell.
var GRID_COL_MIN = 53, GRID_GAP = 10, GRID_ROW = 33;
// A width that is always capped to the row: W sizes span the whole group.
var WIDE = 999;

// [columns, rows] per size. Smallest first: resizing walks this order.
// XS and S widgets are COMPACT: a sense of the trend, not a reading -- the
// full widget opens over them on hover or focus (widget-layout.js).
var SIZE_SPANS = {
  tile:       { XS: [1, 1], S: [2, 2], M: [4, 2], L: [4, 4] },
  stat:       { XS: [2, 2], S: [4, 2], M: [4, 4], L: [6, 4] },
  timeseries: { XS: [4, 2], S: [4, 4], M: [8, 6], L: [12, 6], XL: [12, 8] },
  list:       { S: [4, 2], M: [4, 4], L: [4, 6] },
  status:     { XS: [2, 2], S: [4, 2] },
  clock:      { XS: [2, 2], S: [4, 2], M: [4, 4], L: [8, 4] },
  weather:    { XS: [2, 2], S: [4, 2], M: [4, 4], L: [8, 6], XL: [12, 6], W: [WIDE, 2] },
  // Under 8 columns an agenda; 8+ a week of columns or a month grid.
  calendar:   { M: [4, 4], L: [8, 4], XL: [12, 8], W: [WIDE, 4] },
  unknown:    { M: [4, 4] }
};
// A resize drag in progress, and a re-layout deferred until it ends.
var RESIZING = false, RELAYOUT_PENDING = false;

var SIZE_DEFAULT = { tile: 'M', stat: 'M', timeseries: 'M', list: 'M', status: 'S', clock: 'S', weather: 'M',
                     calendar: 'L', unknown: 'M' };

function useGroupGrid() { return opts.collapse !== 'on'; }

/** Columns that fit the page now. jsdom has no layout (width 0): 24. */
function gridCols() {
  var w = out.clientWidth;
  return w > 0 ? Math.max(4, Math.floor((w + GRID_GAP) / (GRID_COL_MIN + GRID_GAP))) : 24;
}

function sizeOf(kind, size) {
  var spans = SIZE_SPANS[kind] || SIZE_SPANS.unknown;
  if (spans[size] || (kind !== 'tile' && customSpan(size))) { return size; }
  return SIZE_DEFAULT[kind] || 'M';
}

// --- free sizes ----------------------------------------------------------------
//
// A widget may take ANY span from 2x2 to 48x32, saved as "COLSxROWS" -- the
// named sizes are presets, not the only choices (tiles stay named: a tile has
// four layouts and nothing in between). A span is DRAWN as the largest named
// size that fits inside it (its `base`), and the renderer is told the real
// span (opts.span) to lay out into the room rather than stretch.

var FREE_MIN = [2, 2], FREE_MAX = [48, 32];

function customSpan(size) {
  var m = /^(\d{1,2})x(\d{1,2})$/.exec(size || '');
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function spanOf(kind, size) {
  return customSpan(size) || (SIZE_SPANS[kind] || SIZE_SPANS.unknown)[sizeOf(kind, size)];
}

/** The size to save for a span: the named size of exactly that span (W for
 *  the full row at its height), else "COLSxROWS". */
function sizeForSpan(kind, c, r, cols) {
  var spans = SIZE_SPANS[kind] || SIZE_SPANS.unknown, hit = null;
  Object.keys(spans).forEach(function (n) {
    var sp = spans[n];
    if (sp[1] === r && (sp[0] >= WIDE ? c >= cols : sp[0] === c) && !hit) { hit = n; }
  });
  return hit || c + 'x' + r;
}

function sizeBase(kind, size) {
  var c = customSpan(size);
  if (!c) { return sizeOf(kind, size); }
  var spans = SIZE_SPANS[kind] || SIZE_SPANS.unknown, best = null;
  Object.keys(spans).forEach(function (n) {
    var sp = spans[n];
    if (sp[0] >= WIDE || sp[0] > c[0] || sp[1] > c[1]) { return; }
    if (!best || sp[0] * sp[1] > spans[best][0] * spans[best][1]) { best = n; }
  });
  return best || Object.keys(spans)[0];
}

/** Apply a size to an item. Spans are capped at the columns that fit, so a
 *  6-wide chart on a phone is as wide as the phone, not wider. */
function applySpan(el, kind, size, cols) {
  size = sizeOf(kind, size);
  var span = spanOf(kind, size), base = sizeBase(kind, size);
  // A packed (column-first) item keeps its cell while resized mid-drag;
  // otherwise it is auto-placed and jumps.
  var c0 = /^(\d+) \//.exec(el.style.gridColumn || ''), r0 = /^(\d+) \//.exec(el.style.gridRow || '');
  el.style.gridColumn = (c0 ? c0[1] + ' / ' : '') + 'span ' + Math.min(span[0], cols);
  el.style.gridRow = (r0 ? r0[1] + ' / ' : '') + 'span ' + span[1];
  ['XS', 'S', 'M', 'L', 'XL', 'W'].forEach(function (k) { el.classList.remove('size-' + k); });
  el.classList.add('size-' + base);
  el.classList.toggle('size-custom', base !== size);
  el.dataset.size = size;
  el.dataset.base = base;
  return [Math.min(span[0], cols), span[1]];
}

/** A group's items in display order: tiles and widgets in one sequence.
 *  Positional sorts interleave by number; any other sort puts widgets first
 *  (by position) and then the tiles in that sort's order. */
function groupItems(tiles, placements) {
  var w = placements.map(function (p) { return { kind: 'widget', p: p, order: p.ord, key: 'w:' + p.id }; });
  var t = tiles.map(function (a) { return { kind: 'app', a: a, order: a.order, key: 'app:' + a.slug }; });
  if (!(arranging() || opts.sort === 'defined')) {
    return w.sort(function (x, y) { return x.order - y.order; }).concat(t);
  }
  return w.concat(t).sort(function (x, y) {
    var xo = x.order == null ? Infinity : x.order, yo = y.order == null ? Infinity : y.order;
    if (xo !== yo) { return xo - yo; }
    if (x.kind !== y.kind) { return x.kind === 'widget' ? -1 : 1; }
    return x.kind === 'app' ? x.a.name.localeCompare(y.a.name) : x.p.id - y.p.id;
  });
}

function shapeOf(p) { var d = WIDGETS.defs[p.def_id]; return (d && d.shape) || 'unknown'; }

function groupGrid(cat, tiles, placements) {
  var cols = gridCols();
  var ul = document.createElement('ul');
  ul.className = 'ugrid';
  ul.dataset.cat = cat;
  ul.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
  var placed = [];
  groupItems(tiles, placements).forEach(function (it) {
    var el, kind, size;
    if (it.kind === 'app') {
      el = tile(it.a, { unified: true });
      kind = 'tile'; size = it.a.size;
    } else {
      kind = shapeOf(it.p); size = sizeOf(kind, it.p.size);
      // The size goes in BEFORE the first draw: a compact widget renders
      // differently, not just smaller.
      el = widgetCell(it.p, 'li', size);
      if (arranging()) { makeWidgetDraggable(el, it.p); }
    }
    el.dataset.key = it.key;
    placed.push({ el: el, span: applySpan(el, kind, size, cols) });
    if (arranging()) { el.appendChild(resizeHandle(el, it, kind, cat)); }
    ul.appendChild(el);
  });
  if (arranging()) { acceptDrops(ul, cat); }
  if (opts.flow === 'col') {
    ul.classList.add('colfirst');
    var pack = packColumns(placed.map(function (x) { return x.span; }), cols);
    ul.dataset.rows = pack.rows;
    ul.style.gridTemplateRows = 'repeat(' + pack.rows + ', ' + GRID_ROW + 'px)';
    placed.forEach(function (x, i) {
      var at = pack.at[i];
      x.el.style.gridColumn = (at[0] + 1) + ' / span ' + x.span[0];
      x.el.style.gridRow = (at[1] + 1) + ' / span ' + x.span[1];
    });
  }
  return ul;
}

/** Column-first packing, done here rather than by the browser so it needs no
 *  layout and cannot spill: the fewest rows (at least the tallest item, at
 *  least area / columns) in which every [w, h] fits, each item at the first
 *  free spot scanning down then across -- what `column dense` does. Returns
 *  { rows, at: [[col, row], ...] }, zero-based, in item order. */
function packColumns(spans, cols) {
  var area = 0, tallest = 1;
  spans.forEach(function (s) { area += s[0] * s[1]; tallest = Math.max(tallest, s[1]); });
  for (var rows = Math.max(tallest, Math.ceil(area / cols)); ; rows++) {
    var used = [], at = [], ok = true;
    for (var i = 0; i < spans.length && ok; i++) {
      var w = spans[i][0], h = spans[i][1], spot = null;
      for (var c = 0; c + w <= cols && !spot; c++) {
        for (var r = 0; r + h <= rows && !spot; r++) {
          if (free(used, c, r, w, h)) { spot = [c, r]; }
        }
      }
      if (!spot) { ok = false; break; }
      for (var dc = 0; dc < w; dc++) {
        for (var dr = 0; dr < h; dr++) { used[(spot[0] + dc) * rows + spot[1] + dr] = 1; }
      }
      at.push(spot);
    }
    if (ok) { return { rows: rows, at: at }; }
  }
  function free(used, c, r, w, h) {
    for (var dc = 0; dc < w; dc++) {
      for (var dr = 0; dr < h; dr++) { if (used[(c + dc) * rows + r + dr]) { return false; } }
    }
    return true;
  }
}

// --- dragging ------------------------------------------------------------------

function makeWidgetDraggable(el, p) {
  el.draggable = true;
  el.addEventListener('dragstart', function (ev) {
    // A drag that starts on a control inside the widget is not a move.
    // CANCELLED, not just ignored: returning without preventDefault let the
    // browser carry on with a native drag of the whole widget, which cancels
    // the pointer events -- so grabbing the resize corner could start a move
    // and drop the resize half-way.
    if (ev.target.closest && ev.target.closest('button, .resize-handle') && ev.target !== el) {
      ev.preventDefault();
      return;
    }
    DRAG.widget = p.id; DRAG.slug = null; DRAG.group = null; DRAG.def = null;
    el.classList.add('dragging');
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', 'widget:' + p.id);
    }
  });
  el.addEventListener('dragend', function () {
    DRAG.widget = null;
    el.classList.remove('dragging');
    clearDropMarks();
  });
}

function clearDropMarks() {
  Array.prototype.forEach.call(document.querySelectorAll('.dropbefore, .dropend'),
    function (n) { n.classList.remove('dropbefore'); n.classList.remove('dropend'); });
}

function dragKey() {
  if (DRAG.slug) { return 'app:' + DRAG.slug; }
  if (DRAG.widget) { return 'w:' + DRAG.widget; }
  if (DRAG.def) { return 'def:' + DRAG.def; }
  return null;
}

/** The whole grid is the drop target: over an item means "insert before it",
 *  over empty space means "append". dragenter AND dragover are cancelled --
 *  Chrome will not drop on an element that leaves dragenter alone, and says
 *  nothing about it (see tiles.js). */
function acceptDrops(ul, cat) {
  function target(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-key]') : null;
    return t && ul.contains(t) ? t : null;
  }
  function wanted() { return !!dragKey(); }
  ul.addEventListener('dragenter', function (ev) { if (wanted()) { ev.preventDefault(); } });
  ul.addEventListener('dragover', function (ev) {
    if (!wanted()) { return; }
    ev.preventDefault();
    if (ev.dataTransfer) { ev.dataTransfer.dropEffect = DRAG.def ? 'copy' : 'move'; }
    var t = target(ev);
    clearDropMarks();
    if (t && t.dataset.key !== dragKey()) { t.classList.add('dropbefore'); }
    else if (!t) { ul.classList.add('dropend'); }
  });
  ul.addEventListener('dragleave', function (ev) {
    if (ev.relatedTarget && ul.contains(ev.relatedTarget)) { return; }
    clearDropMarks();
  });
  ul.addEventListener('drop', function (ev) {
    var moved = dragKey();
    if (!moved) { return; }
    ev.preventDefault();
    var t = target(ev);
    var before = t ? t.dataset.key : null;
    clearDropMarks();
    DRAG.slug = null; DRAG.widget = null; DRAG.def = null;
    if (before === moved) { return; }
    placeInGroup(cat, moved, before);
  });
}

/** Move `moved` (a key) before `before` (a key, or null for the end) in
 *  `cat`, renumber the whole group, show it at once, then persist. */
function placeInGroup(cat, moved, before) {
  if (moved.indexOf('def:') === 0) {
    // From the library: create the placement first, then position it.
    var defId = Number(moved.slice(4));
    addPlacement(defId, cat, -1)
      .then(function (r) { return loadWidgets().then(function () { return r.id; }); })
      .then(function (pid) { buildWidgetLibrary(); placeInGroup(cat, 'w:' + pid, before); })
      .catch(function (e) { alert('Add failed: ' + e.message); });
    return;
  }
  var tiles = sorted(APPS.filter(function (x) { return (x.category || 'Other') === cat; }));
  var items = groupItems(tiles, widgetsIn(cat)).filter(function (it) { return it.key !== moved; });
  var item;
  if (moved.indexOf('app:') === 0) {
    var a = APPS.filter(function (x) { return 'app:' + x.slug === moved; })[0];
    if (!a) { return; }
    item = { kind: 'app', a: a, key: moved };
  } else {
    var p = WIDGETS.placements.filter(function (x) { return 'w:' + x.id === moved; })[0];
    if (!p) { return; }
    item = { kind: 'widget', p: p, key: moved };
  }
  var at = before ? items.map(function (x) { return x.key; }).indexOf(before) : -1;
  items.splice(at < 0 ? items.length : at, 0, item);

  var payload = items.map(function (it, i) {
    if (it.kind === 'app') {
      // Local first, so the drop shows without waiting for Authentik.
      OVERRIDES[it.a.slug] = Object.assign({}, OVERRIDES[it.a.slug] || {}, { order: i, category: cat });
      it.a.order = i; it.a.category = cat;
      return { app: it.a.slug };
    }
    it.p.ord = i; it.p.category = cat;
    return { widget: it.p.id };
  });
  if (arranging()) { buildGroups(); }
  render();
  saveOrder(cat, payload)
    .catch(function (e) { alert('Reorder failed: ' + e.message); refresh(); });
}

// --- resizing -------------------------------------------------------------------

/** A corner handle: drag to resize (snaps to the allowed sizes), or focus it
 *  and use the arrow keys. Right/Down grow, Left/Up shrink. */
function resizeHandle(el, it, kind, cat) {
  var h = document.createElement('span');
  h.className = 'resize-handle';
  h.tabIndex = 0;
  h.draggable = false;
  // A native drag begins on mousedown; stop it here, before the browser
  // decides the widget (draggable in admin mode) is being moved.
  h.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
  h.addEventListener('dragstart', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
  h.setAttribute('role', 'slider');
  var names = Object.keys(SIZE_SPANS[kind] || SIZE_SPANS.unknown);
  function label() {
    h.setAttribute('aria-label', kind === 'tile' ? 'Size ' + el.dataset.size + ' of ' + names.join(', ')
      : 'Size ' + spanOf(kind, el.dataset.size).map(function (v, i) { return i ? v : Math.min(v, gridCols()); }).join(' by '));
    h.title = 'Resize (' + el.dataset.size + ') — drag, or focus and use the arrow keys';
  }
  label();
  if (kind === 'tile' && names.length < 2) { h.hidden = true; return h; }

  function commit(size) {
    if (size === (it.kind === 'app' ? sizeOf('tile', it.a.size) : sizeOf(kind, it.p.size))) { return; }
    commitSize(it, kind, size);
  }
  h.addEventListener('click', function (ev) { ev.stopPropagation(); ev.preventDefault(); });
  h.addEventListener('keydown', function (ev) {
    // A widget: the arrows move by cells -- Right/Left a column, Down/Up a
    // row. A tile: its named sizes, in order.
    var cur = el.dataset.size;
    if (kind !== 'tile') {
      var dc = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      var dr = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
      if (!dc && !dr) { return; }
      ev.preventDefault();
      var cols = gridCols(), sp = spanOf(kind, cur);
      var nc = Math.min(sp[0], cols) + dc, nr = sp[1] + dr;
      if (nc >= FREE_MIN[0] && nr >= FREE_MIN[1] && nc <= Math.min(FREE_MAX[0], cols) && nr <= FREE_MAX[1]) {
        commit(sizeForSpan(kind, nc, nr, cols));
      }
      return;
    }
    var i = names.indexOf(cur);
    var next = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? i + 1
             : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? i - 1 : null;
    if (next == null) { return; }
    ev.preventDefault();
    next = Math.max(0, Math.min(names.length - 1, next));
    if (next !== i) { commit(names[next]); }
  });
  h.addEventListener('pointerdown', function (ev) {
    ev.preventDefault(); ev.stopPropagation();
    var grid = el.parentNode, cols = gridCols();
    var colW = (grid.clientWidth - GRID_GAP * (cols - 1)) / cols;
    var box = el.getBoundingClientRect(), sx = ev.clientX, sy = ev.clientY;
    var chosen = el.dataset.size, done = false;
    el.classList.add('resizing');
    RESIZING = true;
    if (h.setPointerCapture) { try { h.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic */ } }
    function move(e) {
      var wantC = (box.width + (e.clientX - sx) + GRID_GAP) / (colW + GRID_GAP);
      var wantR = (box.height + (e.clientY - sy) + GRID_GAP) / (GRID_ROW + GRID_GAP);
      var best;
      if (kind === 'tile') {
        // Nearest named size: a tile has nothing in between.
        var bestD = Infinity;
        names.forEach(function (n) {
          var sp = SIZE_SPANS[kind][n];
          var d = Math.abs(Math.min(sp[0], cols) - wantC) + Math.abs(sp[1] - wantR);
          if (d < bestD) { bestD = d; best = n; }
        });
      } else {
        // A widget: by cells, named where the span is a named size's.
        var fc = Math.max(FREE_MIN[0], Math.min(cols, FREE_MAX[0], Math.round(wantC)));
        var fr = Math.max(FREE_MIN[1], Math.min(FREE_MAX[1], Math.round(wantR)));
        best = sizeForSpan(kind, fc, fr, cols);
      }
      if (best !== chosen) { chosen = best; applySpan(el, kind, best, cols); label(); }
    }
    // 🔴 EVERY way a drag can end commits: pointerup, pointercancel AND
    // lostpointercapture. Listening for pointerup alone, a drag whose release
    // never arrived (capture lost, the handle re-rendered away) LOOKED resized
    // but was never saved -- and the next resize's render drew it from the
    // saved size, so an earlier tile "grew back". Once only (`done`).
    function up() {
      if (done) { return; }
      done = true;
      ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
        h.removeEventListener(t, t === 'pointermove' ? move : up);
      });
      el.classList.remove('resizing');
      RESIZING = false;
      commit(chosen);
      if (RELAYOUT_PENDING) { RELAYOUT_PENDING = false; render(); }
    }
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
    h.addEventListener('lostpointercapture', up);
  });
  return h;
}

function commitSize(it, kind, size) {
  var isDefault = size === SIZE_DEFAULT[kind];
  if (it.kind === 'app') {
    var f = Object.assign({}, OVERRIDES[it.a.slug] || {});
    // The default is stored as no size at all, so a later change of default
    // reaches every tile nobody deliberately sized.
    if (isDefault) { delete f.size; } else { f.size = size; }
    OVERRIDES[it.a.slug] = f;
    it.a.size = isDefault ? undefined : size;
    render();
    var o = {}; o[it.a.slug] = f;
    saveTiles(o)
      .catch(function (e) { alert('Resize failed: ' + e.message); refresh(); });
  } else {
    it.p.size = isDefault ? null : size;
    render();
    editPlacement(it.p.id, { size: isDefault ? null : size })
      .catch(function (e) { alert('Resize failed: ' + e.message); refresh(); });
  }
}

// Re-lay out when the number of columns that fit changes (a window resize, a
// phone rotating). Only then: spans are recomputed from the column count.
(function () {
  if (!window.ResizeObserver) { return; }
  var last = 0;
  new ResizeObserver(function () {
    var c = gridCols();
    if (last && c !== last && useGroupGrid() && out.querySelector('.ugrid')) {
      // Not mid-resize: a render would replace the handle being dragged
      // (a resize can itself add or remove the scrollbar). After it ends.
      if (RESIZING) { RELAYOUT_PENDING = true; } else { render(); }
    }
    last = c;
  }).observe(out);
})();
