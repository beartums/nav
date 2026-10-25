// groups.js -- Categories: the group sidebar, ordering and hiding.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// --- categories -----------------------------------------------------
// `all` keeps groups that currently hold nothing.
//
// Without it a group created in the rail vanished the instant it was saved:
// it was filtered against the categories actually in use, and a brand-new
// group has no members yet -- leaving nowhere to drag the first tile.
// The rail passes true; the page passes false, because an empty heading on
// the dashboard is noise.
function categoriesOf(list, all) {
  var seen = {}, out = [];
  list.forEach(function (a) { var c = a.category || 'Other'; if (!seen[c]) { seen[c] = 1; out.push(c); } });
  var ordered = GROUP_ORDER.filter(function (g) {
    return all || out.indexOf(g) !== -1;
  });
  // Explicit order first, then anything new, so adding an app never
  // reshuffles the page.
  out.forEach(function (c) { if (ordered.indexOf(c) === -1) { ordered.push(c); } });
  return ordered;
}

function groupHidden(cat) {
  return groupHiddenList().indexOf(cat) !== -1;
}

function saveGroups(order, hidden) {
  return saveGroupsTo(order, hidden).then(refresh)
    .catch(function (e) { alert('Saving the groups failed: ' + e.message); refresh(); });
}

function buildGroups() {
  var host = document.getElementById('group-list');
  host.innerHTML = '';
  // While the bulk table is open the staged order is the truth; reading
  // categoriesOf() here would show the rail and the table disagreeing
  // about the order of the very thing you just dragged.
  // pageCats: a group holding only widgets is a group here too.
  var order = (BULK.on && BULK.cats) ? BULK.cats.slice() : pageCats(true);

  order.forEach(function (cat) {
    var li = document.createElement('li');
    li.draggable = true;
    var hidden = groupHidden(cat);

    var name = document.createElement('span');
    name.textContent = cat;
    name.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis;' +
                         (hidden ? 'opacity:.45; text-decoration:line-through;' : '');
    li.appendChild(name);

    var n = document.createElement('span');
    n.className = 'count';
    // Tiles and widgets both: a widget is a member of its group.
    n.textContent = APPS.filter(function (a) { return (a.category || 'Other') === cat; }).length +
                    widgetsIn(cat).length;
    li.appendChild(n);

    // Hiding is per group and site-wide: an admin deciding a whole section
    // is not worth showing. Distinct from a tile's own `hidden`.
    var eye = document.createElement('button');
    eye.type = 'button';
    eye.textContent = hidden ? '\u2609' : '\u25c9';
    eye.title = hidden ? 'Show this group' : 'Hide this group from the dashboard';
    eye.style.cssText = 'background:none; border:0; padding:0 2px; cursor:pointer; color:var(--muted);';
    eye.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var h = groupHiddenList().slice();
      var at = h.indexOf(cat);
      if (at === -1) { h.push(cat); } else { h.splice(at, 1); }
      saveGroups(order, h);
    });
    li.appendChild(eye);

    // --- reordering ---------------------------------------------------
    li.addEventListener('dragstart', function (ev) {
      DRAG.group = cat; DRAG.slug = null;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', cat);
    });
    li.addEventListener('dragend', function () {
      DRAG.group = null;
      Array.prototype.forEach.call(host.querySelectorAll('li'),
        function (x) { x.classList.remove('over'); });
    });
    li.addEventListener('dragover', function (ev) {
      // A tile or widget dropped here moves to this group; a library widget
      // is added to it; a group dropped here reorders.
      if (!DRAG.slug && !DRAG.group && !DRAG.widget && !DRAG.def && !DRAG.newWidget) { return; }
      if (DRAG.group === cat) { return; }
      ev.preventDefault();
      li.classList.add('over');
    });
    li.addEventListener('dragleave', function () { li.classList.remove('over'); });
    li.addEventListener('drop', function (ev) {
      li.classList.remove('over');
      ev.preventDefault();

      if (DRAG.group && DRAG.group !== cat) {
        // Bulk edit has one Save. A rail drop during it has to stage like
        // everything else, or half the session's changes write themselves
        // while the other half sit waiting for a button.
        if (BULK.on) { var g = DRAG.group; DRAG.group = null; bulkMoveGroup(g, cat); return; }
        var next = order.filter(function (g2) { return g2 !== DRAG.group; });
        next.splice(next.indexOf(cat), 0, DRAG.group);
        saveGroups(next, groupHiddenList());
        return;
      }
      if (DRAG.widget || DRAG.def || DRAG.newWidget) {
        // Appended to the end of that group, through the same path as a drop
        // inside the page, so tiles and widgets stay one sequence.
        var key = DRAG.widget ? 'w:' + DRAG.widget : DRAG.def ? 'def:' + DRAG.def : 'new';
        DRAG.widget = null; DRAG.def = null; DRAG.newWidget = false;
        placeInGroup(cat, key, null);
        return;
      }
      if (BULK.on && DRAG.slug) {
        var sl = DRAG.slug;
        DRAG.slug = null;
        bulkMove(sl, null, cat);       // append to the end of that group
        return;
      }
      if (DRAG.slug) {
        var o = {};
        var next = Object.assign({}, OVERRIDES[DRAG.slug] || {}, { category: cat });
        o[DRAG.slug] = next;
        OVERRIDES[DRAG.slug] = next;
        APPS.forEach(function (x) { if (x.slug === DRAG.slug) { x.category = cat; } });
        buildGroups();
        render();
        saveTiles(o)
          .catch(function (e) { alert('Move failed: ' + e.message); refresh(); });
      }
    });
    host.appendChild(li);
  });
}

document.getElementById('group-add').addEventListener('click', function () {
  var name = prompt('New group name');
  if (!name || !name.trim()) { return; }
  if (categoriesOf(APPS, true).indexOf(name.trim()) !== -1) { return; }
  saveGroups(categoriesOf(APPS, true).concat([name.trim()]), groupHiddenList());
});

// The sidebar's Manage menu (admin tools that used to crowd the admin bar).
// Each item's own listener lives with its dialog; this only opens and closes.
(function () {
  var btn = document.getElementById('side-menu-btn');
  var list = document.getElementById('side-menu-list');
  function close() { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  btn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    list.hidden = !list.hidden;
    btn.setAttribute('aria-expanded', String(!list.hidden));
  });
  list.addEventListener('click', function (ev) { if (ev.target.closest('button')) { close(); } });
  document.addEventListener('click', function (ev) {
    if (!list.hidden && !list.contains(ev.target) && ev.target !== btn) { close(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !list.hidden) { close(); btn.focus(); }
  });
})();

// The sidebar's width: drag its edge (or arrow keys on the grip). Per viewer,
// in localStorage -- a convenience; it falls back to the default.
(function () {
  var KEY = 'nav.sideWidth', MIN = 180, DEF = 210;
  var grip = document.getElementById('side-grip');
  function max() { return Math.max(MIN, Math.round(innerWidth * 0.5)); }
  function set(w, save) {
    w = Math.max(MIN, Math.min(max(), Math.round(w)));
    document.body.style.setProperty('--side-w', w + 'px');
    if (save) { try { localStorage.setItem(KEY, String(w)); } catch (e) { /* none */ } }
    return w;
  }
  function now() { return parseInt(getComputedStyle(document.body).getPropertyValue('--side-w'), 10) || DEF; }
  try { var w0 = Number(localStorage.getItem(KEY)); if (w0) { set(w0, false); } } catch (e) { /* none */ }
  grip.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    grip.setPointerCapture && grip.setPointerCapture(ev.pointerId);
    document.body.classList.add('side-dragging');
    function move(e) { set(e.clientX, false); }
    function up() {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.body.classList.remove('side-dragging');
      set(now(), true);
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', function () {
    document.body.style.removeProperty('--side-w');
    try { localStorage.removeItem(KEY); } catch (e) { /* none */ }
  });
  grip.addEventListener('keydown', function (ev) {
    var d = ev.key === 'ArrowLeft' ? -20 : ev.key === 'ArrowRight' ? 20 : 0;
    if (d) { ev.preventDefault(); set(now() + d, true); }
  });
})();

// The sidebar folds away (the bars' ◫ icon), per device: arranging with the
// whole width when the groups list isn't needed.
(function () {
  function set(collapsed) {
    document.body.classList.toggle('side-collapsed', collapsed);
    Array.prototype.forEach.call(document.querySelectorAll('.side-toggle'), function (b) {
      b.setAttribute('aria-expanded', String(!collapsed));
    });
    try { localStorage.setItem('nav.side', collapsed ? 'collapsed' : 'open'); } catch (e) {}
  }
  var was = null;
  try { was = localStorage.getItem('nav.side'); } catch (e) {}
  set(was === 'collapsed');
  Array.prototype.forEach.call(document.querySelectorAll('.side-toggle'), function (b) {
    b.addEventListener('click', function () { set(!document.body.classList.contains('side-collapsed')); });
  });
})();
