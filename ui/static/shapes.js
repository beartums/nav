// shapes.js -- shapes drawn on a free page: rectangles, ellipses, lines (docs/free-layout.md).
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after free.js and style.js, before main.js.
//
// A shape is a free group of kind "shape" (layouts.py clean_look): cells like a
// frame, a `look`, and a `z` that puts it on a layer --
//   z < 0   behind the tiles and widgets (and over group frames)
//   z > 0   in front of them; it never takes a click, so what is under it works
// ordered by z within its layer. It overlaps anything and holds nothing.
// Phones draw in reading order, with no cells to draw on: shapes are left out.
'use strict';

var SHAPE_FORMS = [['rect', '▭', 'Rectangle'], ['round', '▢', 'Rounded rectangle'],
                   ['ellipse', '◯', 'Ellipse'], ['hline', '─', 'Line across'],
                   ['vline', '│', 'Line down']];
var LINE_STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
// layouts.py SHAPE_INKS: the theme's own colours, so they follow light and dark.
var SHAPE_INKS = { ink: ['var(--fg)', 'Text colour'], muted: ['var(--muted)', 'Muted text colour'],
                   card: ['var(--card)', 'Card colour'] };
var LINE_W_MAX = 16;            // layouts.py

function freeShapes() { return freeGroups().filter(function (g) { return g.kind === 'shape'; }); }
/** Bottom to top. */
function shapesByZ() { return freeShapes().sort(function (a, b) { return a.z - b.z; }); }

function inkVar(c) { return SHAPE_INKS[c] ? SHAPE_INKS[c][0] : colourVar(c); }

function shapeLook(g) {
  return Object.assign({ form: 'rect', fill_a: 100, line_w: 2, line_s: 'solid' }, g.look || {});
}

function paintShape(art, g) {
  var k = shapeLook(g);
  var line = k.line && k.line_w ? k.line_w + 'px ' + k.line_s + ' ' + inkVar(k.line) : '';
  art.className = 'fs-art fs-' + k.form;
  art.style.cssText = '';
  if (k.form === 'hline') { art.style.borderTop = line || 'none'; return; }
  if (k.form === 'vline') { art.style.borderLeft = line || 'none'; return; }
  art.style.border = line || 'none';
  var fill = inkVar(k.fill);
  if (fill) { art.style.background = 'color-mix(in srgb, ' + fill + ' ' + k.fill_a + '%, transparent)'; }
}

function shapeEl(g) {
  var el = document.createElement('li');
  el.className = 'fshape ' + (g.z > 0 ? 'fs-front' : 'fs-back');
  el.dataset.key = 'g:' + g.id;
  el.style.gridColumn = (g.x + 1) + ' / span ' + g.w;
  el.style.gridRow = (g.y + 1) + ' / span ' + g.h;
  var art = document.createElement('div');
  paintShape(art, g);
  el.appendChild(art);
  if (!arranging()) { return el; }

  var tools = document.createElement('div');
  tools.className = 'fs-tools';
  function btn(cls, text, title, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'fg-btn ' + cls;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(b); });
    tools.appendChild(b);
    return b;
  }
  var grip = document.createElement('span');
  grip.className = 'fs-move';
  grip.textContent = '✥';
  grip.title = 'Drag to move the shape';
  grip.draggable = true;
  grip.addEventListener('dragstart', function (ev) {
    DRAG.fgroup = g.id; DRAG.slug = null; DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false;
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', 'shape:' + g.id); }
  });
  grip.addEventListener('dragend', function () { DRAG.fgroup = null; });
  tools.appendChild(grip);
  btn('fs-style', '🎨', 'Shape, fill and line', function (b) { shapePicker(b, g, el); });
  var where = g.z > 0 ? 'In front of the tiles' : 'Behind the tiles';
  btn('fs-up', '↑', where + ' · bring forward', function () { restack(g, 1); });
  btn('fs-down', '↓', where + ' · send backward', function () { restack(g, -1); });
  btn('fs-del', '×', 'Delete the shape', function () {
    if (!confirm('Delete this shape?')) { return; }
    LAYOUT.free_groups = freeGroups().filter(function (x) { return x.id !== g.id; });
    render();
    saveFreeGroups();
  });
  el.appendChild(tools);
  el.appendChild(groupResizeHandle(el, g));
  return el;
}

/** One step up or down the stack: shapes behind, then the tiles, then shapes
 *  in front -- so stepping past the tiles changes the layer. z is renumbered
 *  -n..-1 below the tiles and 1..m above. */
function restack(g, step) {
  var TILES = {};
  var all = shapesByZ();
  var order = all.filter(function (s) { return s.z < 0; }).concat([TILES], all.filter(function (s) { return s.z > 0; }));
  var i = order.indexOf(g), j = Math.max(0, Math.min(order.length - 1, i + step));
  if (i < 0 || j === i) { return; }
  order.splice(i, 1);
  order.splice(j, 0, g);
  var t = order.indexOf(TILES);
  order.forEach(function (s, k) { if (s !== TILES) { s.z = k - t; } });
  render();
  saveFreeGroups();
}

/** A new shape, at the top of the layer behind the tiles. */
function addShape(x, y, w, h) {
  freeShapes().forEach(function (s) { if (s.z < 0) { s.z -= 1; } });
  LAYOUT.free_groups = freeGroups().concat([{
    id: newGroupId(), name: '', kind: 'shape', x: x, y: y, w: w, h: h, z: -1,
    look: { form: 'round', fill: 'blue', fill_a: 15, line: 'blue', line_w: 2, line_s: 'solid' }
  }]);
  render();
  saveFreeGroups();
}

/** "+ Shape": drag onto the page to draw one there. */
function newShapeButton() {
  var b = document.createElement('button');
  b.type = 'button';
  b.id = 'shape-new';
  b.className = 'wl-new';
  b.textContent = '+ Shape';
  b.title = 'Drag onto the page to draw a shape (behind the tiles; its ↑ brings it in front)';
  b.draggable = true;
  b.addEventListener('dragstart', function (ev) {
    DRAG.newShape = true; DRAG.newGroup = false; DRAG.slug = null; DRAG.widget = null; DRAG.def = null;
    DRAG.newWidget = false; DRAG.fgroup = null;
    if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData('text/plain', 'new-shape'); }
  });
  b.addEventListener('dragend', function () { DRAG.newShape = false; });
  return b;
}

// --- the picker ---------------------------------------------------------------------

/** Swatches: none (transparent), the theme's inks, the colours, any colour. */
function inkSwatches(cur, onPick) {
  var row = document.createElement('div');
  row.className = 'bg-swatches';
  function mark(c) {
    Array.prototype.forEach.call(row.querySelectorAll('.bg-sw'), function (b) {
      b.classList.toggle('on', b.dataset.c === (c || ''));
      b.setAttribute('aria-pressed', String(b.dataset.c === (c || '')));
    });
  }
  function pick(c) { mark(c); onPick(c || null); }
  [''].concat(Object.keys(SHAPE_INKS), BG_COLOURS).forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bg-sw';
    b.dataset.c = c;
    b.title = !c ? 'None (transparent)' : SHAPE_INKS[c] ? SHAPE_INKS[c][1] : c;
    b.setAttribute('aria-label', b.title);
    if (c) { b.style.background = inkVar(c); } else { b.textContent = '∅'; }
    b.addEventListener('click', function () { pick(c); });
    row.appendChild(b);
  });
  var custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'bg-custom';
  custom.title = 'Any colour';
  custom.value = /^#/.test(cur || '') ? cur : '#888888';
  custom.addEventListener('change', function () { pick(custom.value.toLowerCase()); });
  row.appendChild(custom);
  mark(cur);
  return row;
}

/** Pressed buttons, one of `opts` ([value, label, title?]). */
function pressedRow(opts, cur, onPick) {
  var row = document.createElement('div');
  row.className = 'fs-pressed';
  opts.forEach(function (o) {
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = o[0];
    b.textContent = o[1];
    b.title = o[2] || o[1];
    b.addEventListener('click', function () {
      Array.prototype.forEach.call(row.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      onPick(o[0]);
    });
    b.setAttribute('aria-pressed', String(o[0] === cur));
    row.appendChild(b);
  });
  return row;
}

/** A 0..max slider with its number beside it: drawn as it moves, saved when let go. */
function slider(label, cur, max, unit, onMove, onDone) {
  var lab = document.createElement('label');
  lab.className = 'fs-slider';
  lab.textContent = label + ' ';
  var r = document.createElement('input');
  r.type = 'range';
  r.min = '0';
  r.max = String(max);
  r.value = String(cur);
  var n = document.createElement('span');
  n.textContent = cur + unit;
  r.addEventListener('input', function () { n.textContent = r.value + unit; onMove(Number(r.value)); });
  r.addEventListener('change', onDone);
  lab.appendChild(r);
  lab.appendChild(n);
  return lab;
}

/** Each choice applies at once and is saved; there is no Save. */
function shapePicker(anchor, g, el) {
  closeBgPicker();
  var k = g.look = shapeLook(g);
  var box = document.createElement('div');
  box.className = 'bg-picker shape-picker';
  box.id = 'bg-picker';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Shape');
  function head(t) {
    var h = document.createElement('div');
    h.className = 'bg-picker-h';
    h.textContent = t;
    box.appendChild(h);
    return h;
  }
  var fillPart = [];
  function drawn(save) {
    paintShape(el.querySelector('.fs-art'), g);
    var line = k.form === 'hline' || k.form === 'vline';
    fillPart.forEach(function (n) { n.hidden = line; });
    if (save) { saveFreeGroups(); }
  }
  function set(key, v) { if (v == null) { delete k[key]; } else { k[key] = v; } drawn(true); }
  head('Shape');
  box.appendChild(pressedRow(SHAPE_FORMS.map(function (f) { return [f[0], f[1], f[2]]; }), k.form,
                             function (v) { set('form', v); }));
  fillPart.push(head('Fill'));
  fillPart.push(box.appendChild(inkSwatches(k.fill, function (c) { set('fill', c); })));
  fillPart.push(box.appendChild(slider('Opacity', k.fill_a, 100, '%',
                                       function (v) { k.fill_a = v; drawn(false); }, function () { saveFreeGroups(); })));
  head('Line');
  box.appendChild(inkSwatches(k.line, function (c) { set('line', c); }));
  box.appendChild(slider('Width', k.line_w, LINE_W_MAX, 'px',
                         function (v) { k.line_w = v; drawn(false); }, function () { saveFreeGroups(); }));
  box.appendChild(pressedRow(LINE_STYLES, k.line_s, function (v) { set('line_s', v); }));
  drawn(false);

  document.body.appendChild(box);
  var r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
  box.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - box.offsetHeight - 8)) + 'px';
  setTimeout(function () { document.addEventListener('mousedown', outside); }, 0);
  document.addEventListener('keydown', esc);
  function outside(ev) { if (!box.contains(ev.target) && ev.target !== anchor) { closeBgPicker(); } }
  function esc(ev) { if (ev.key === 'Escape') { closeBgPicker(); } }
  box._off = function () { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
  return box;
}
