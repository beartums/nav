// widget-layout.js -- saved widgets: in the groups, and in the admin sidebar.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after widgets.js (renderWidget) and before widget-designer.js and main.js.
//
// The server filters what comes back per viewer (api/widgets), so everything
// here can assume a widget it holds is one this person may see.
'use strict';

var WIDGETS = { defs: {}, placements: [] };

// Data per DEFINITION, not per placement: one widget placed in three groups
// is one fetch, and every copy on screen updates together.
var WIDGET_DATA = {};
// defId -> the upstream person a viewer is acting as in that widget (a
// choreboard admin's "as Toby"). This page load only: a reload is yourself.
var WIDGET_AS = {};
function widgetDataUrl(defId) {
  return 'api/widgets/' + defId + '/data' + (WIDGET_AS[defId] ? '?as=' + encodeURIComponent(WIDGET_AS[defId]) : '');
}

function loadWidgets() {
  return fetch('api/widgets' + layoutQuery('?')).then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (b) {
      // A failure here costs the widgets, never the tiles.
      WIDGETS = { defs: {}, placements: [] };
      if (!b) { return; }
      (b.defs || []).forEach(function (d) { WIDGETS.defs[d.id] = d; });
      WIDGETS.placements = (b.placements || []).filter(function (p) { return WIDGETS.defs[p.def_id]; });
    });
}

function widgetsIn(cat) {
  return WIDGETS.placements.filter(function (p) { return p.category === cat; })
    .sort(function (a, b) { return a.ord - b.ord || a.id - b.id; });
}

/** Whether a placement is on the page: a hidden one only while arranging, so
 *  the one screen that can unhide it still shows it. */
function widgetVisible(p) { return arranging() || !p.hidden; }

/** A group's widgets as drawn: visible ones, and when the group is collapsed
 *  only those marked above the fold -- the same rule as tiles. */
function widgetsShown(cat, collapsed) {
  return widgetsIn(cat).filter(function (p) { return widgetVisible(p) && (!collapsed || p.above_fold); });
}

/** Group names that hold a widget, so a widgets-only group still renders. */
function widgetCats() {
  var seen = {};
  WIDGETS.placements.forEach(function (p) { if (widgetVisible(p)) { seen[p.category] = 1; } });
  return Object.keys(seen);
}

/** Categories for the page: tiles' categories plus widget-only ones. */
function pageCats(all) {
  return categoriesOf(APPS.concat(widgetCats().map(function (c) { return { category: c }; })), all);
}

// `body` is the widget's own element; the cell around it also carries the
// admin controls, which a redraw must not wipe.
function fillWidget(body, defId) {
  var got = WIDGET_DATA[defId];
  var cell = body.parentNode;
  var ds = cell && cell.dataset ? cell.dataset : {};
  // `size` is the named size to draw; `span` the cells it really has (bigger,
  // for a size past the largest -- see sizeBase in group-grid.js).
  var span = ds.cols ? [Number(ds.cols), Number(ds.rows)] : undefined;
  if (got && got.payload) {
    renderWidget(body, got.payload, { key: 'def' + defId, size: ds.base || ds.size, span: span,
                                      placement: ds.placement });
    scrollIfOver(body);
  }
  else { body.classList.add('widget'); body.textContent = 'Loading…'; }
}

// --- more than fits: scroll ----------------------------------------------------
//
// A widget whose content is bigger than its cell scrolls, with a scrollbar
// that only shows on hover, and a mouse can drag the content (touch scrolls
// natively). Only when it really overflows: a cell that fits keeps
// overflow:hidden, so a pixel of rounding is not a scrollbar.

function scrollIfOver(body) {
  requestAnimationFrame(function () {
    body.classList.remove('scroller');
    if (body.scrollHeight > body.clientHeight + 2 || body.scrollWidth > body.clientWidth + 2) {
      body.classList.add('scroller');
    }
  });
}

/** The nearest element from `el` up to `root` that scrolls along an axis. */
function scrollerFor(el, root, axis) {
  for (; el && el !== root.parentNode; el = el.parentNode) {
    if (el.classList && el.classList.contains('scroller') &&
        (axis === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight)) { return el; }
  }
  return null;
}

function dragToScroll(root) {
  root.addEventListener('pointerdown', function (ev) {
    // Arranging, a drag moves the widget; a control keeps its own click.
    if (ev.pointerType !== 'mouse' || ev.button !== 0 || arranging()) { return; }
    if (ev.target.closest && ev.target.closest('button, input, select, textarea')) { return; }
    var sx = scrollerFor(ev.target, root, 'x'), sy = scrollerFor(ev.target, root, 'y');
    if (!sx && !sy) { return; }
    var x0 = ev.clientX, y0 = ev.clientY, l0 = sx && sx.scrollLeft, t0 = sy && sy.scrollTop;
    var moved = false;
    function move(e) {
      var dx = e.clientX - x0, dy = e.clientY - y0;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) { return; }
      if (!moved) { moved = true; root.classList.add('w-dragscroll'); }
      if (sx) { sx.scrollLeft = l0 - dx; }
      if (sy) { sy.scrollTop = t0 - dy; }
      e.preventDefault();
    }
    function up() {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      root.classList.remove('w-dragscroll');
      // A drag is not a click on whatever it ended over.
      // The click follows pointerup in the same task, so a timeout clears a
      // listener that no click came for.
      if (moved) {
        var eat = function (e) { e.stopPropagation(); e.preventDefault(); };
        root.addEventListener('click', eat, true);
        setTimeout(function () { root.removeEventListener('click', eat, true); }, 0);
      }
    }
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  });
}

function fetchWidgetData(defId) {
  var slot = WIDGET_DATA[defId] = WIDGET_DATA[defId] || {};
  if (slot.busy) { return; }
  slot.busy = true;
  fetch(widgetDataUrl(defId))
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        return r.ok ? b : { error: b.detail || ('widget data: ' + r.status) };
      });
    })
    .catch(function (e) { return { error: apiFailure(e) }; })
    .then(function (payload) {
      slot.busy = false;
      if (payload && payload.error && WIDGET_AS[defId]) {
        // Acting as someone failed (they left, or you're not an admin there):
        // back to yourself rather than a tile with no way out.
        console.warn('acting as', WIDGET_AS[defId], 'failed:', payload.error);
        delete WIDGET_AS[defId];
        fetchWidgetData(defId);
        return;
      }
      slot.payload = payload;
      slot.at = Date.now();
      var cells = out.querySelectorAll('.widget-cell[data-def="' + defId + '"] > .widget-body');
      Array.prototype.forEach.call(cells, function (c) { fillWidget(c, defId); });
      // Refresh on the provider's own ttl, but only while a copy is on
      // screen -- a widget scrolled out of the layout stops costing anything.
      clearTimeout(slot.timer);
      var ttl = Math.max(15, payload.ttl || 60);
      slot.timer = setTimeout(function () {
        if (out.querySelector('.widget-cell[data-def="' + defId + '"]')) {
          if (document.hidden) { slot.at = 0; return; }   // refetched on return
          fetchWidgetData(defId);
        }
      }, ttl * 1000);
    });
}

// Coming back to a hidden tab refetches anything that went stale meanwhile.
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { return; }
  Object.keys(WIDGET_DATA).forEach(function (id) {
    if (!WIDGET_DATA[id].at && out.querySelector('.widget-cell[data-def="' + id + '"]')) {
      fetchWidgetData(id);
    }
  });
});

/** One placed widget's element: the widget body plus, when arranging, its
 *  remove control -- and in a user's edit mode, edit-in-place (✎). `tag` is 'li' inside the shared group grid, else 'div'. */
function widgetCell(p, tag, size) {
  var def = WIDGETS.defs[p.def_id];
  var cell = document.createElement(tag || 'div');
  cell.className = 'widget-cell shape-' + (def.shape || 'unknown');
  cell.dataset.def = def.id;
  cell.dataset.placement = p.id;
  if (size) {
    var kind = def.shape || 'unknown', sp = spanOf(kind, size);
    cell.dataset.size = size;
    cell.dataset.base = sizeBase(kind, size);
    cell.dataset.cols = Math.min(sp[0], gridCols());
    cell.dataset.rows = sp[1];
  }
  var body = document.createElement('div');
  body.className = 'widget-body';
  cell.appendChild(body);
  if (IMPERSONATING) {
    // Widget data is always fetched as the REAL caller, so showing it here
    // would present your data as theirs. Show the layout, not the numbers.
    body.classList.add('widget');
    var lab = document.createElement('div');
    lab.className = 'w-label';
    lab.textContent = def.title;
    body.appendChild(lab);
    var n = document.createElement('div');
    n.className = 'w-sub';
    n.textContent = 'Widget data is not shown while viewing as someone else.';
    body.appendChild(n);
  } else {
    fillWidget(body, def.id);
    var slot = WIDGET_DATA[def.id];
    var ttl = slot && slot.payload ? Math.max(15, slot.payload.ttl || 60) * 1000 : 0;
    if (!slot || !slot.at || Date.now() - slot.at > ttl) { fetchWidgetData(def.id); }
  }
  if (wantsPeek(def.shape, cell.dataset.base) && !IMPERSONATING) { peekOnHover(cell, def.id); }
  dragToScroll(cell);
  if (arranging()) {
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'w-remove';
    x.textContent = '\u00d7';
    x.title = 'Remove from this group (the widget stays in the library)';
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      dropPlacement(p.id)
        .then(reloadWidgets)
        .catch(function (e) { alert('Remove failed: ' + e.message); });
    });
    cell.appendChild(x);
    // Hide / above the fold: the tile editor's two flags, for a widget.
    [['hidden', 'w-hide', p.hidden ? '\u25cc' : '\u25c9',
      p.hidden ? 'Hidden -- click to show it on the page' : 'Hide from the page (stays in this group)'],
     ['above_fold', 'w-fold', '\ud83d\udccc',
      p.above_fold ? 'Above the fold -- click to fold it away with its group'
                   : 'Keep showing when its group is collapsed']].forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = f[1] + (p[f[0]] ? ' on' : '');
      b.textContent = f[2];
      b.title = f[3];
      b.setAttribute('aria-pressed', String(!!p[f[0]]));
      b.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        var body = {}; body[f[0]] = !p[f[0]];
        p[f[0]] = body[f[0]];
        render();
        editPlacement(p.id, body).catch(function (e) { alert('Save failed: ' + e.message); refresh(); });
      });
      cell.appendChild(b);
    });
    if (p.hidden) { cell.classList.add('w-is-hidden'); }
    if (EDIT_MODE && ownDashboard() && !def.missing) {
      var ed = document.createElement('button');
      ed.type = 'button';
      ed.className = 'w-edit';
      ed.textContent = '\u270e';
      ed.title = 'Edit this widget here';
      ed.addEventListener('click', function (ev) {
        ev.stopPropagation();
        widgetDesigner(def, p.id);
      });
      cell.appendChild(ed);
    }
  }
  return cell;
}

// --- the full view over a compact widget -----------------------------------------
//
// XS and S widgets give the shape of things, not a reading. Pointing at one
// (briefly -- passing over the grid must not flash panels) or focusing it
// opens the FULL widget beside it, drawn from the data already fetched: no
// extra request, and the same tooltip and table as any full-size widget.

function isCompact(size) { return size === 'XS' || size === 'S'; }

/** The full view on hover wherever the cell draws less than all of it:
 *  every compact size, weather under L -- its strip and card leave out the
 *  chart, the details and the week -- and a calendar narrow enough to be an
 *  agenda (decided when hovered: a resize can change it; see peekOnHover). */
function wantsPeek(shape, base) {
  return isCompact(base) || shape === 'calendar' ||
    (shape === 'weather' && base !== 'L' && base !== 'XL');
}

/** At hover time: is the cell drawing less than the full view? Only the
 *  calendar's answer moves with the cell's width. */
function peekNow(cell) {
  if (!cell.classList.contains('shape-calendar') || isCompact(cell.dataset.base)) { return true; }
  return !!cell.querySelector('.cal-is-agenda');
}

var PEEK = null;       // { el, cell, timer }

function closePeek() {
  if (!PEEK) { return; }
  clearTimeout(PEEK.timer);
  if (PEEK.el && PEEK.el.parentNode) { PEEK.el.parentNode.removeChild(PEEK.el); }
  PEEK = null;
}

/** The payload for a definition: cached, or fetched once and cached. A
 *  library entry may be placed nowhere, so nothing has loaded it yet. */
function widgetPayload(defId) {
  var got = WIDGET_DATA[defId];
  if (got && got.payload) { return Promise.resolve(got.payload); }
  return fetch(widgetDataUrl(defId))
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (payload) {
      if (payload) { WIDGET_DATA[defId] = Object.assign(WIDGET_DATA[defId] || {}, { payload: payload, at: Date.now() }); }
      return payload;
    });
}

function openPeek(cell, defId) {
  // Cached: open now, synchronously -- no reason to wait a tick.
  var got = WIDGET_DATA[defId];
  if (got && got.payload) {
    if (!got.payload.error) { showPeek(cell, defId, got.payload); }
    return;
  }
  widgetPayload(defId).then(function (payload) {
    // Still wanted? The pointer may have left while the data was coming.
    if (!payload || payload.error || !PEEK || PEEK.cell !== cell) { return; }
    showPeek(cell, defId, payload);
  });
}

function showPeek(cell, defId, payload) {
  var got = { payload: payload };
  if (PEEK && PEEK.el && PEEK.el.parentNode) { PEEK.el.parentNode.removeChild(PEEK.el); }
  var pop = document.createElement('div');
  pop.className = 'w-peek';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', (WIDGETS.defs[defId] || {}).title || 'Widget');
  var shape = got.payload.shape;
  // The full widget's natural width: charts and the week's forecast want
  // room; several clocks side by side want some.
  var multi = shape === 'clock' && ((got.payload.data || {}).zones || []).length > 1;
  pop.style.width = ({ timeseries: 520, weather: 520, list: 340, calendar: 680 }[shape] || (multi ? 420 : 260)) + 'px';
  var body = document.createElement('div');
  pop.appendChild(body);
  document.body.appendChild(pop);
  // Full size: no `size`, so the renderer draws its complete layout. Same
  // key, so a folded legend stays folded here too.
  renderWidget(body, got.payload, { key: 'def' + defId });
  // Beside the cell if either side has room; otherwise below it (or above,
  // near the bottom). Never over the cell itself, never off-screen.
  var r = cell.getBoundingClientRect(), pw = pop.offsetWidth || parseInt(pop.style.width, 10);
  var ph = pop.offsetHeight || 200;
  var left, top;
  if (r.right + 8 + pw <= innerWidth - 8) { left = r.right + 8; top = r.top; }
  else if (r.left - 8 - pw >= 8) { left = r.left - 8 - pw; top = r.top; }
  else {
    left = Math.min(Math.max(8, r.left), innerWidth - pw - 8);
    top = r.bottom + 8 + ph <= innerHeight - 8 ? r.bottom + 8 : r.top - 8 - ph;
  }
  top = Math.min(Math.max(8, top), Math.max(8, innerHeight - ph - 8));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  PEEK = { el: pop, cell: cell, timer: null };
  pop.addEventListener('mouseleave', function (ev) {
    if (!cell.contains(ev.relatedTarget)) { closePeek(); }
  });
}

function peekOnHover(cell, defId) {
  // Focusable so the keyboard gets the same full view.
  if (!cell.hasAttribute('tabindex')) { cell.tabIndex = 0; }
  cell.addEventListener('mouseenter', function () {
    if (PEEK && PEEK.cell === cell) { return; }
    if (!peekNow(cell)) { closePeek(); return; }
    closePeek();
    PEEK = { el: null, cell: cell, timer: setTimeout(function () { openPeek(cell, defId); }, 300) };
  });
  cell.addEventListener('mouseleave', function (ev) {
    if (PEEK && PEEK.el && PEEK.el.contains(ev.relatedTarget)) { return; }
    closePeek();
  });
  cell.addEventListener('focus', function () {
    closePeek();
    if (!peekNow(cell)) { return; }
    PEEK = { el: null, cell: cell, timer: null };
    openPeek(cell, defId);
  });
  cell.addEventListener('blur', function (ev) {
    if (PEEK && PEEK.el && PEEK.el.contains(ev.relatedTarget)) { return; }
    closePeek();
  });
  cell.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { closePeek(); } });
}

/** The row of widgets for one group, or null when there are none to show.
 *  Used by the layouts the shared grid does not cover (icons-only,
 *  column-first, ungrouped); see group-grid.js. */
function widgetRow(placements) {
  // Search narrows tiles; a chart is never a "match", so widgets step aside.
  if (SEARCH || !placements.length) { return null; }
  var row = document.createElement('div');
  row.className = 'widget-row';
  placements.forEach(function (p) { row.appendChild(widgetCell(p, 'div')); });
  return row;
}

function reloadWidgets() {
  return loadWidgets().then(function () {
    if (arranging()) { buildWidgetLibrary(); }
    render();
  });
}

// --- the widget palette ---------------------------------------------------------
//
// Opened from the mode bar's widgets icon. One flat list, not a collapsible
// section per type: the TYPE is a filter chip across the top and a tag on each
// widget. Drag a widget onto the page to place it; drag "New widget" onto the
// page to make one there (the designer opens, and saving places it where it
// was dropped).

// The chosen filter is per DEVICE, like collapsed groups.
var LIB_FILTER = 'all';
try { LIB_FILTER = (JSON.parse(localStorage.getItem('nav.widgetlib') || '{}') || {}).filter || 'all'; } catch (e) {}
function saveLibFilter() {
  try { localStorage.setItem('nav.widgetlib', JSON.stringify({ filter: LIB_FILTER })); } catch (e) {}
}

function typeTitle(t) { return WIDGET_TYPE_TITLES[t] || t; }

function buildWidgetLibrary() {
  var host = document.getElementById('widget-lib');
  host.innerHTML = '';
  var all = Object.keys(WIDGETS.defs).map(function (k) { return WIDGETS.defs[k]; });
  // A template holds library widgets only (the server refuses a personal
  // one), so admin mode does not offer them; edit mode lists them first.
  var shown = ADMIN_MODE ? all.filter(function (d) { return !d.mine; }) : all;
  shown.sort(function (a, b) {
    return (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.title.localeCompare(b.title);
  });

  // Filter chips: All, Mine (your own, edit mode), then each type present.
  var types = [];
  shown.forEach(function (d) { if (types.indexOf(d.type) < 0) { types.push(d.type); } });
  types.sort(function (a, b) { return typeTitle(a).localeCompare(typeTitle(b)); });
  var chips = [['all', 'All']];
  if (!ADMIN_MODE) { chips.push(['__mine__', 'Mine']); }
  types.forEach(function (t) { chips.push([t, typeTitle(t)]); });
  if (chips.map(function (c) { return c[0]; }).indexOf(LIB_FILTER) < 0) { LIB_FILTER = 'all'; }
  var bar = document.createElement('div');
  bar.className = 'wl-chips';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Show');
  chips.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wl-chip' + (c[0] === LIB_FILTER ? ' on' : '');
    b.dataset.filter = c[0];
    b.textContent = c[1];
    b.setAttribute('aria-pressed', String(c[0] === LIB_FILTER));
    b.addEventListener('click', function () { LIB_FILTER = c[0]; saveLibFilter(); buildWidgetLibrary(); });
    bar.appendChild(b);
  });
  host.appendChild(bar);

  host.appendChild(newWidgetButton(ADMIN_MODE ? 'widget-new' : 'widget-new-mine'));

  var ul = document.createElement('ul');
  ul.className = 'wl-list';
  shown.filter(function (d) {
    return LIB_FILTER === 'all' || (LIB_FILTER === '__mine__' ? d.mine : d.type === LIB_FILTER);
  }).forEach(function (d) {
    // The library is the admin's to edit; in a user's edit mode it is a
    // palette to drag from, and only their own widgets open the designer
    // (a placed widget is edited on the page, by its ✎).
    ul.appendChild(libItem(d, ADMIN_MODE || !!d.mine));
  });
  host.appendChild(ul);
  if (!ul.children.length) {
    var none = document.createElement('div');
    none.className = 'note';
    none.textContent = shown.length ? 'Nothing of that type.' : 'No saved widgets yet.';
    host.appendChild(none);
  }
}

/** "New widget": click to design one into the library, or DRAG it onto the
 *  page to design one that is placed where it was dropped. */
function newWidgetButton(id) {
  var nb = document.createElement('button');
  nb.type = 'button';
  nb.id = id;
  nb.className = 'wl-new';
  nb.textContent = '+ New widget';
  nb.title = 'Click to make a widget, or drag onto the page to make one there';
  nb.draggable = true;
  nb.addEventListener('click', function () { widgetDesigner(null); });
  nb.addEventListener('dragstart', function (ev) {
    DRAG.newWidget = true; DRAG.def = null; DRAG.slug = null; DRAG.widget = null; DRAG.group = null;
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'copy';
      ev.dataTransfer.setData('text/plain', 'new-widget');
    }
  });
  nb.addEventListener('dragend', function () { DRAG.newWidget = false; clearDropMarks(); });
  return nb;
}

/** Open or close the palette; the bars' widgets icons say which. */
function setPalette(open) {
  var pal = document.getElementById('widget-palette');
  if (!pal) { return; }
  pal.hidden = !open;
  document.body.classList.toggle('palette-open', !!open);
  // The grid's column count follows the page width.
  if (typeof render === 'function' && APPS.length) { render(); }
  Array.prototype.forEach.call(document.querySelectorAll('.widgets-toggle'), function (b) {
    b.setAttribute('aria-expanded', String(!!open));
    b.classList.toggle('on', !!open);
  });
  try { localStorage.setItem('nav.palette', open ? '1' : '0'); } catch (e) {}
}
(function () {
  Array.prototype.forEach.call(document.querySelectorAll('.widgets-toggle'), function (b) {
    b.addEventListener('click', function () { setPalette(document.getElementById('widget-palette').hidden); });
  });
  var close = document.querySelector('#widget-palette .wp-close');
  if (close) { close.addEventListener('click', function () { setPalette(false); }); }
  var was = null;
  try { was = localStorage.getItem('nav.palette'); } catch (e) {}
  if (was === '1') { setPalette(true); }
})();

function libItem(d, editable) {
  var li = document.createElement('li');
  var name = document.createElement(editable ? 'button' : 'span');
  name.className = 'wl-name';
  name.textContent = d.title;
  if (editable) {
    name.type = 'button';
    name.title = 'Edit this widget';
    name.addEventListener('click', function () { widgetDesigner(d); });
  }
  li.appendChild(name);
  var tag = document.createElement('span');
  tag.className = 'wl-tag';
  tag.textContent = d.mine ? 'Mine · ' + typeTitle(d.type) : typeTitle(d.type) + (d.missing ? ' (type removed)' : '');
  li.appendChild(tag);
  if (d.mine) { li.classList.add('wl-mine'); }
  li.dataset.type = d.type;
  // Drag straight into a group (group-grid.js) or onto a group in the
  // sidebar.
  if (!d.missing) {
    li.draggable = true;
    li.classList.add('wl-drag');
    li.addEventListener('dragstart', function (ev) {
      DRAG.def = d.id; DRAG.slug = null; DRAG.widget = null; DRAG.group = null; DRAG.newWidget = false;
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('text/plain', 'def:' + d.id);
      }
    });
    li.addEventListener('dragend', function () { DRAG.def = null; clearDropMarks(); });
  }

  // Where it is placed, said quietly; adding is by dragging.
  var n = WIDGETS.placements.filter(function (p) { return p.def_id === d.id; }).length;
  if (n) {
    var where = document.createElement('span');
    where.className = 'wl-where';
    where.textContent = 'in ' + n + ' group' + (n === 1 ? '' : 's');
    li.appendChild(where);
  }
  if (!d.missing) { peekOnHover(li, d.id); }
  return li;
}

// Type titles for section headings. Filled lazily from api/widgets/types the
// first time the library is built; a type missing from it shows its id.
var WIDGET_TYPE_TITLES = {};
function loadWidgetTypeTitles() {
  return fetch('api/widgets/types').then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (b) {
      ((b && b.types) || []).forEach(function (t) { WIDGET_TYPE_TITLES[t.type] = t.title || t.type; });
    });
}
