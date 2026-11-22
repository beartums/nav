// textstyle.js -- text styles for groups and tiles, and groups inside groups.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after groups.js (applyTextStyle, groupParents, groupStyleOf) and editor.js
// (the tile editor uses styleControls), before main.js.
//
// A style is {font, size, weight, italic, colour, align, case}, every key
// optional; unset inherits (tile <- group <- page). api/layouts.py checks the
// same closed set. A group's style has three parts: its heading, and the
// default for its tiles' names and descriptions.
'use strict';

var STYLE_PARTS = [['heading', 'Group heading'], ['name', 'Tile names'], ['desc', 'Tile descriptions']];

/** Controls for one style. `inherited` shows through as the placeholder state.
 *  Returns {el, value()}; value() is null when nothing is set. */
function styleControls(current, inherited) {
  var st = Object.assign({}, current || {});
  var inh = inherited || {};
  var box = document.createElement('div');
  box.className = 'ts';

  function pick(title, options, key, num) {
    var s = document.createElement('select');
    s.title = title; s.setAttribute('aria-label', title);
    var def = document.createElement('option');
    def.value = '';
    def.textContent = title + (inh[key] != null ? ': ' + label(options, inh[key]) + ' (inherited)' : ': default');
    s.appendChild(def);
    options.forEach(function (o) {
      var op = document.createElement('option'); op.value = String(o[0]); op.textContent = o[1]; s.appendChild(op);
    });
    s.value = st[key] != null ? String(st[key]) : '';
    s.addEventListener('change', function () {
      if (s.value === '') { delete st[key]; } else { st[key] = num ? Number(s.value) : s.value; }
    });
    box.appendChild(s);
  }
  function label(options, v) {
    var o = options.filter(function (x) { return String(x[0]) === String(v); })[0];
    return o ? o[1] : String(v);
  }
  pick('Font', [['system', 'System'], ['serif', 'Serif'], ['mono', 'Monospace'], ['rounded', 'Rounded'],
                ['condensed', 'Condensed']], 'font');
  var sizes = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48].map(function (n) { return [n, n + ' px']; });
  pick('Size', sizes, 'size', true);
  pick('Weight', [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'],
                  [800, 'Extra bold']], 'weight', true);
  pick('Case', [['none', 'As typed'], ['upper', 'UPPER'], ['lower', 'lower'], ['title', 'Title Case']], 'case');

  // Italic and alignment: pressed buttons, not checkboxes (the pressed state
  // is the value; press again to go back to inherited).
  function toggle(text, title, isOn, set) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ts-t'; b.innerHTML = text; b.title = title;
    b.setAttribute('aria-label', title);
    function paint() { b.setAttribute('aria-pressed', String(isOn())); }
    b.addEventListener('click', function () { set(); paint(); box.querySelectorAll('.ts-t').forEach(function (x) { x._paint && x._paint(); }); });
    b._paint = paint;
    paint();
    box.appendChild(b);
  }
  toggle('<i>I</i>', 'Italic (press again: inherited)', function () { return st.italic === true; },
         function () { if (st.italic === true) { delete st.italic; } else { st.italic = true; } });
  [['left', '&#8676;', 'Align left'], ['center', '&#8596;', 'Centre'], ['right', '&#8677;', 'Align right']]
    .forEach(function (a) {
      toggle(a[1], a[2] + ' (press again: inherited)', function () { return st.align === a[0]; },
             function () { if (st.align === a[0]) { delete st.align; } else { st.align = a[0]; } });
    });

  var col = document.createElement('span');
  col.className = 'ts-col';
  var ci = document.createElement('input');
  ci.type = 'color'; ci.title = 'Colour'; ci.setAttribute('aria-label', 'Colour');
  ci.value = st.colour || inh.colour || '#888888';
  var cx = document.createElement('button');
  cx.type = 'button'; cx.className = 'ts-t'; cx.textContent = '✕'; cx.title = 'Colour: inherited';
  function paintCol() { col.classList.toggle('ts-unset', !st.colour); cx.hidden = !st.colour; }
  ci.addEventListener('input', function () { st.colour = ci.value; paintCol(); });
  cx.addEventListener('click', function () { delete st.colour; ci.value = inh.colour || '#888888'; paintCol(); });
  col.appendChild(ci); col.appendChild(cx);
  box.appendChild(col);
  paintCol();

  return { el: box, value: function () { return Object.keys(st).length ? Object.assign({}, st) : null; } };
}

function saveGroupMeta(patch) {
  return api('PUT', layoutPath('/groups'), patch).then(refresh)
    .catch(function (e) { alert('Saving the group failed: ' + e.message); refresh(); });
}

/** A modal of our own (like newTileDialog): {box, close}. */
function smallDialog(title) {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.className = 'smalldlg';
  var h = document.createElement('strong');
  h.textContent = title;
  box.appendChild(h);
  back.appendChild(box);
  document.body.appendChild(back);
  function close() { back.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', function (e) { if (e.target === back) { close(); } });
  return { box: box, close: close };
}

/** A group's text styles: its heading, and its tiles' names and descriptions. */
function groupStyleDialog(cat) {
  var d = smallDialog('Text style: ' + cat);
  var cur = groupStyleOf(cat);
  var ctl = {};
  STYLE_PARTS.forEach(function (p) {
    var sec = document.createElement('div');
    sec.className = 'ts-sec';
    var lab = document.createElement('div');
    lab.className = 'ts-lab';
    lab.textContent = p[1];
    sec.appendChild(lab);
    ctl[p[0]] = styleControls(cur[p[0]], {});
    sec.appendChild(ctl[p[0]].el);
    d.box.appendChild(sec);
  });
  var hint = document.createElement('div');
  hint.className = 'note';
  hint.textContent = 'A tile can override its own name and description in its editor.';
  d.box.appendChild(hint);
  var foot = document.createElement('div');
  foot.className = 'smalldlg-foot';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', d.close);
  var save = document.createElement('button');
  save.type = 'button'; save.textContent = 'Save'; save.id = 'groupstyle-save';
  save.addEventListener('click', function () {
    var all = Object.assign({}, (LAYOUT && LAYOUT.group_style) || {});
    var mine = {};
    STYLE_PARTS.forEach(function (p) { var v = ctl[p[0]].value(); if (v) { mine[p[0]] = v; } });
    if (Object.keys(mine).length) { all[cat] = mine; } else { delete all[cat]; }
    d.close();
    saveGroupMeta({ styles: all });
  });
  foot.appendChild(cancel); foot.appendChild(save);
  d.box.appendChild(foot);
}

/** Put a group inside another (or back at the top). One level: a group that
 *  has subgroups can't go inside one, and only top-level groups take them. */
function nestGroup(cat, parent) {
  var p = Object.assign({}, groupParents());
  if (parent) { p[cat] = parent; } else { delete p[cat]; }
  saveGroupMeta({ parents: p });
}

/** The ⋯ menu on a sidebar group: where it sits, and its text style. */
function groupMenu(cat, anchor) {
  document.querySelectorAll('.grp-menu').forEach(function (m) { m.remove(); });
  var parents = groupParents();
  var hasKids = Object.keys(parents).some(function (k) { return parents[k] === cat; });
  var menu = document.createElement('ul');
  menu.className = 'menu-list grp-menu';
  function item(text, fn, on, off) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = (on ? '✓ ' : '') + text;
    b.disabled = !!off;
    b.addEventListener('click', function () { menu.remove(); fn(); });
    li.appendChild(b);
    menu.appendChild(li);
  }
  function head(text) {
    var li = document.createElement('li');
    li.className = 'menu-head';
    li.textContent = text;
    menu.appendChild(li);
  }
  item('Text style…', function () { groupStyleDialog(cat); });
  head(hasKids ? 'Holds subgroups, so stays at the top' : 'Inside');
  if (!hasKids) {
    item('Top level', function () { nestGroup(cat, null); }, !parents[cat]);
    pageCats(true).forEach(function (g) {
      if (g === cat || parents[g]) { return; }      // one level: only top-level groups hold others
      item(g, function () { nestGroup(cat, g); }, parents[cat] === g);
    });
  }
  menu.hidden = false;
  var r = anchor.getBoundingClientRect();
  menu.style.cssText = 'position:fixed; z-index:70; left:' + Math.max(8, r.left) + 'px; top:' + (r.bottom + 4) + 'px; min-width:180px;';
  document.body.appendChild(menu);
  setTimeout(function () {
    document.addEventListener('click', function off(e) {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', off); }
    });
  });
}
