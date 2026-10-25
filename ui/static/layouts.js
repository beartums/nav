// layouts.js -- which layout is on screen, every write to it, and the admin's
// template picker (roadmap #34 step 6).
//
// One of nav's page scripts (classic, shared globals; see admin.js). Loads
// after admin.js (api) and before everything that writes a layout.
//
// A LAYOUT is a template (admin-edited, one is the default) or a user's
// dashboard (a full copy of a template). The page edits whichever is on screen
// through ONE set of routes, api/layouts/{id}/..., so the same grid, drag and
// resize code serves both. What a tile is CALLED is site-wide on a template --
// split off to api/admin/presentation -- and the dashboard's own on a dashboard.
'use strict';

var LAYOUT = null;                    // the reply's `layout`: on screen now
var LAYOUTS = { templates: [], dashboards: [] };
// The fields that belong to a layout; the rest of an override is presentation.
// Mirrors layouts.py LAYOUT_KEYS.
var LAYOUT_KEYS = ['category', 'order', 'size', 'hidden', 'above_fold', 'x', 'y'];

// The template the admin is editing, per device like the tab. Null: the default.
var ADMIN_TEMPLATE = null;
try { ADMIN_TEMPLATE = JSON.parse(localStorage.getItem('nav.admintpl') || 'null'); } catch (e) {}
function setAdminTemplate(id) {
  ADMIN_TEMPLATE = id;
  try { localStorage.setItem('nav.admintpl', JSON.stringify(id)); } catch (e) {}
}

/** The layout id to ask for: the template being edited in admin mode, else
 *  this device's dashboard (none: the server's default template).
 *  Impersonation always sees the default. */
function viewLayoutId() {
  if (IMPERSONATING) { return null; }
  return ADMIN_MODE ? ADMIN_TEMPLATE : USER_LAYOUT;
}
function layoutQuery(sep) {
  var id = viewLayoutId();
  return id == null ? '' : sep + 'layout=' + encodeURIComponent(id);
}

function layoutPath(rest) {
  // No `layout` in the reply: an API older than this page (the page ships a
  // few minutes first). Say so rather than throwing a TypeError at a drop.
  if (!LAYOUT) { throw new Error('nav-api is still rolling out -- reload in a few minutes'); }
  return 'api/layouts/' + LAYOUT.id + rest;
}
function groupOrder() { return (LAYOUT && LAYOUT.group_order) || []; }
function groupHiddenList() { return (LAYOUT ? LAYOUT.group_hidden : SITE.group_hidden) || []; }

function splitFields(f) {
  var pres = {}, lay = {};
  Object.keys(f || {}).forEach(function (k) {
    (LAYOUT_KEYS.indexOf(k) === -1 ? pres : lay)[k] = f[k];
  });
  return [pres, lay];
}

/** {slug: full override} -> stored, each tile REPLACED. On a template the
 *  presentation half is site-wide; a dashboard keeps both halves itself. */
function saveTiles(map) {
  if (LAYOUT.kind === 'dashboard') { return api('PUT', layoutPath('/tiles'), { tiles: map }); }
  var pres = {}, lay = {};
  Object.keys(map).forEach(function (s) {
    var h = splitFields(map[s]);
    pres[s] = h[0]; lay[s] = h[1];
  });
  // Two transactions, not one: a failure between them is possible, and the
  // caller's catch re-reads rather than trusting the local copy.
  return Promise.all([api('PUT', 'api/admin/presentation', { tiles: pres }),
                      api('PUT', layoutPath('/tiles'), { tiles: lay })]);
}

/** A tile back to its defaults: on a template, Authentik's name and icon and
 *  no layout row; on a dashboard, the template's row for it. */
function clearTile(slug) {
  var s = encodeURIComponent(slug);
  var lay = api('DELETE', layoutPath('/tiles/' + s));
  return LAYOUT.kind === 'dashboard' ? lay
    : Promise.all([lay, api('DELETE', 'api/admin/presentation/' + s)]);
}

function saveOrder(cat, items) { return api('PUT', layoutPath('/order'), { category: cat, items: items }); }
function saveGroupsTo(order, hidden) {
  return api('PUT', layoutPath('/groups'), { order: order, hidden: hidden });
}
function addPlacement(defId, cat, ord) {
  return api('POST', layoutPath('/placements'), { def_id: defId, category: cat, ord: ord });
}
function editPlacement(pid, body) { return api('PUT', layoutPath('/placements/' + pid), body); }
function dropPlacement(pid) { return api('DELETE', layoutPath('/placements/' + pid)); }

function loadLayouts() {
  return fetch('api/layouts').then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (b) { LAYOUTS = b || { templates: [], dashboards: [] }; });
}

// --- the admin's template picker ----------------------------------------------
//
// One select: the templates, then the actions on the one shown. Actions in the
// same control rather than four more buttons in an already full bar.

function buildTemplatePicker() {
  var sel = document.getElementById('admin-tpl');
  var note = document.getElementById('admin-tpl-note');
  if (!sel || !LAYOUT) { return; }
  sel.innerHTML = '';
  function opt(value, text, parent) {
    var o = document.createElement('option');
    o.value = value; o.textContent = text;
    (parent || sel).appendChild(o);
    return o;
  }
  var list = LAYOUTS.templates.length ? LAYOUTS.templates : [LAYOUT];
  list.forEach(function (t) { opt('t:' + t.id, t.name + (t.is_default ? ' (default)' : '')); });
  var acts = document.createElement('optgroup');
  acts.label = 'This template';
  opt('new', 'New template…', acts);
  opt('dup', 'Duplicate…', acts);
  opt('rename', 'Rename…', acts);
  if (!LAYOUT.is_default) { opt('default', 'Make it the default', acts); opt('delete', 'Delete…', acts); }
  sel.appendChild(acts);
  sel.value = 't:' + LAYOUT.id;
  // Who sees what is being edited -- the one thing an admin must not guess.
  note.textContent = LAYOUT.is_default
    ? 'The default: everyone without a dashboard of their own sees this.'
    : 'Not the default: nobody sees it until it is made the default or copied into a dashboard.';
  // One line on the bar, cut short when narrow; the whole sentence on hover.
  note.title = note.textContent;
}

function templateAction(v) {
  var sel = document.getElementById('admin-tpl');
  function done(id) {
    if (id != null) { setAdminTemplate(id); }
    return loadLayouts().then(refresh);
  }
  function fail(what) { return function (e) { alert(what + ' failed: ' + e.message); done(null); }; }
  sel.value = 't:' + LAYOUT.id;          // the select shows the template, never an action
  if (v.indexOf('t:') === 0) { return done(Number(v.slice(2))); }
  if (v === 'new' || v === 'dup') {
    var name = prompt(v === 'new' ? 'Name for the new, empty template'
                                  : 'Name for the copy of “' + LAYOUT.name + '”');
    if (!name || !name.trim()) { return; }
    var body = { kind: 'template', name: name.trim() };
    if (v === 'dup') { body.from_id = LAYOUT.id; }
    return api('POST', 'api/layouts', body).then(function (r) { return done(r.id); })
      .catch(fail('Creating the template'));
  }
  if (v === 'rename') {
    var nn = prompt('Rename “' + LAYOUT.name + '” to', LAYOUT.name);
    if (!nn || !nn.trim() || nn.trim() === LAYOUT.name) { return; }
    return api('PUT', 'api/layouts/' + LAYOUT.id, { name: nn.trim() }).then(function () { return done(null); })
      .catch(fail('Rename'));
  }
  if (v === 'default') {
    if (!confirm('Make “' + LAYOUT.name + '” the default? Everyone without a dashboard ' +
                 'of their own will see it.')) { return; }
    return api('PUT', 'api/layouts/' + LAYOUT.id, { is_default: true }).then(function () { return done(null); })
      .catch(fail('Making it the default'));
  }
  if (v === 'delete') {
    if (!confirm('Delete the template “' + LAYOUT.name + '”? Dashboards copied from it ' +
                 'keep their layout and revert to the default from now on.')) { return; }
    return api('DELETE', 'api/layouts/' + LAYOUT.id)
      .then(function () { setAdminTemplate(null); return done(null); })
      .catch(fail('Delete'));
  }
}

(function () {
  var sel = document.getElementById('admin-tpl');
  if (sel) { sel.addEventListener('change', function () { templateAction(sel.value); }); }
})();

// --- personal dashboards (roadmap #34 step 7) ------------------------------------
//
// Anyone may make dashboards: named, their own, each a FULL COPY of a template
// (the user's call -- later template edits do not reach it; Revert re-copies).
// Which one a device shows is per device, like the active tab: a phone and a
// desktop legitimately want different pages. Kept in localStorage so the first
// paint needs no extra round trip, and told to the server (api/device) so the
// choice is on record next to the dashboards it points at.

var EDIT_MODE = false;
var USER_LAYOUT = null;
try { USER_LAYOUT = JSON.parse(localStorage.getItem('nav.layout') || 'null'); } catch (e) {}

var DEVICE_ID = null;
try {
  DEVICE_ID = localStorage.getItem('nav.device');
  if (!DEVICE_ID) {
    DEVICE_ID = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem('nav.device', DEVICE_ID);
  }
} catch (e) { DEVICE_ID = null; }

function setUserLayout(id) {
  USER_LAYOUT = id;
  try { localStorage.setItem('nav.layout', JSON.stringify(id)); } catch (e) {}
  if (DEVICE_ID) {
    // On record only; a failure costs nothing the page needs.
    api('PUT', 'api/device/' + encodeURIComponent(DEVICE_ID), { layout_id: id }).catch(function () {});
  }
}

/** Arranging a layout: the admin on a template, or a user on their own. */
function arranging() { return ADMIN_MODE || EDIT_MODE; }
function ownDashboard() { return !!LAYOUT && LAYOUT.kind === 'dashboard'; }

function setEditMode(on) {
  if (on && !ownDashboard()) {
    // Viewing a shared template: there is nothing of the user's to edit yet.
    return newDashboardDialog('Make a dashboard of your own to arrange. It starts as a copy ' +
                              'of the one you are looking at.', function () { setEditMode(true); });
  }
  if (on && ADMIN_MODE) { setAdminMode(false); }
  EDIT_MODE = !!on;
  document.body.classList.toggle('edit-mode', EDIT_MODE);
  closeEditor();
  refresh();
}

function buildEditBar() {
  var n = document.getElementById('edit-name');
  if (n && LAYOUT) { n.textContent = '“' + LAYOUT.name + '”'; }
}

/** The View menu's dashboard section: switch, edit, and the actions on the
 *  dashboard shown. */
function dashboardMenu(menuList) {
  if (IMPERSONATING) { return; }
  function item(text, fn, opts) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (opts && opts.id) { b.id = opts.id; }
    if (opts && opts.checked != null) {
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(opts.checked));
      if (opts.checked) { b.textContent = '✓ ' + text; }
    }
    b.addEventListener('click', function () { closeMenu(); fn(); });
    li.appendChild(b);
    menuList.appendChild(li);
  }
  var sep = document.createElement('li');
  sep.style.cssText = 'border-top:1px solid var(--line); margin:4px 0;';
  menuList.appendChild(sep);
  var head = document.createElement('li');
  head.className = 'menu-head';
  head.textContent = 'Dashboard';
  menuList.appendChild(head);

  var shared = LAYOUTS.templates.filter(function (t) { return t.is_default; })[0];
  var onShared = !ownDashboard();
  if (shared) {
    item(shared.name + ' (shared)', function () { setUserLayout(null); refresh(); },
         { checked: onShared });
  }
  LAYOUTS.dashboards.forEach(function (d) {
    item(d.name, function () { setUserLayout(d.id); refresh(); },
         { checked: !onShared && LAYOUT.id === d.id });
  });
  item(onShared ? 'Make it mine…' : 'Edit layout', function () { setEditMode(true); },
       { id: 'menu-edit' });
  item('New dashboard…', function () { newDashboardDialog(null, null); });
  if (!onShared) {
    item('Rename…', renameDashboard);
    item('Revert to template…', revertDashboard);
    item('Delete…', deleteDashboard);
  }
}

/** Your dashboards as tabs: the shared default first, then yours in the
 *  order you made them, and + for another. Click to switch (this device);
 *  double-click your own to rename it. Not while impersonating or editing a
 *  template -- those show one layout chosen elsewhere. */
function buildDashTabs() {
  var bar = document.getElementById('dashtabs');
  if (!bar) { return; }
  bar.innerHTML = '';
  bar.hidden = !!IMPERSONATING || ADMIN_MODE || !LAYOUT;
  if (bar.hidden) { return; }
  bar.setAttribute('role', 'tablist');
  var shared = LAYOUTS.templates.filter(function (t) { return t.is_default; })[0];
  var tabs = [];
  if (shared) { tabs.push({ id: null, name: shared.name, shared: true }); }
  LAYOUTS.dashboards.forEach(function (d) { tabs.push({ id: d.id, name: d.name, mode: d.mode }); });
  tabs.forEach(function (t) {
    var on = t.shared ? !ownDashboard() : (ownDashboard() && LAYOUT.id === t.id);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dtab' + (on ? ' on' : '');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.textContent = t.name;
    if (t.shared) { b.title = 'The shared dashboard'; }
    else if (t.mode === 'free') { b.title = 'Free layout -- double-click to rename'; }
    else { b.title = 'Double-click to rename'; }
    b.addEventListener('click', function () {
      if (on) { return; }
      if (EDIT_MODE) { EDIT_MODE = false; document.body.classList.remove('edit-mode'); }
      setUserLayout(t.id);
      refresh();
    });
    if (!t.shared) { b.addEventListener('dblclick', function () { if (on) { renameDashboard(); } }); }
    bar.appendChild(b);
  });
  var add = document.createElement('button');
  add.type = 'button';
  add.className = 'dtab dtab-add';
  add.id = 'dashtab-add';
  add.textContent = '+';
  add.title = 'New dashboard (a free layout starts empty)';
  add.setAttribute('aria-label', 'New dashboard');
  add.addEventListener('click', function () { newDashboardDialog(null, null, 'free'); });
  bar.appendChild(add);
}

function renameDashboard() {
  var nn = prompt('Rename “' + LAYOUT.name + '” to', LAYOUT.name);
  if (!nn || !nn.trim() || nn.trim() === LAYOUT.name) { return; }
  api('PUT', 'api/layouts/' + LAYOUT.id, { name: nn.trim() })
    .then(function () { return loadLayouts(); }).then(refresh)
    .catch(function (e) { alert('Rename failed: ' + e.message); });
}

function revertDashboard() {
  if (!confirm('Revert “' + LAYOUT.name + '” to its template? Your arrangement, ' +
               'renames and widgets in it are replaced by a fresh copy.')) { return; }
  api('POST', 'api/layouts/' + LAYOUT.id + '/revert')
    .then(refresh)
    .catch(function (e) { alert('Revert failed: ' + e.message); });
}

function deleteDashboard() {
  if (!confirm('Delete the dashboard “' + LAYOUT.name + '”?')) { return; }
  var id = LAYOUT.id;
  api('DELETE', 'api/layouts/' + id)
    .then(function () {
      if (EDIT_MODE) { EDIT_MODE = false; document.body.classList.remove('edit-mode'); }
      setUserLayout(null);
      return loadLayouts();
    }).then(refresh)
    .catch(function (e) { alert('Delete failed: ' + e.message); });
}

/** Name it and pick what it starts as: the dashboard on screen, or any
 *  template. `lead` explains why it opened, `then` runs once it is shown. */
function newDashboardDialog(lead, then, startMode) {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  var box = document.createElement('div');
  box.className = 'icondlg';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'New dashboard');
  var h = document.createElement('h3');
  h.textContent = 'New dashboard';
  h.style.margin = '0 0 8px';
  box.appendChild(h);
  if (lead) {
    var p = document.createElement('p');
    p.className = 'note';
    p.textContent = lead;
    box.appendChild(p);
  }
  var nl = document.createElement('label');
  nl.textContent = 'Name';
  nl.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:12px;';
  var name = document.createElement('input');
  name.id = 'dash-name';
  name.type = 'text';
  name.maxLength = 60;
  name.value = LAYOUTS.dashboards.length ? '' : 'My dashboard';
  nl.appendChild(name);
  box.appendChild(nl);

  // Free: an empty grid you place things on. Packed: a copy, arranged in groups.
  var ml = document.createElement('fieldset');
  ml.style.cssText = 'border:0; padding:0; margin:8px 0 0; display:flex; flex-direction:column; gap:4px; font-size:12px;';
  var modeIn = {};
  [['free', 'Free layout: starts empty, put things anywhere'],
   ['packed', 'Groups: a copy of a dashboard, arranged automatically']].forEach(function (m, i) {
    var lab = document.createElement('label');
    lab.style.cssText = 'display:flex; gap:6px; align-items:center;';
    var r = document.createElement('input');
    r.type = 'radio'; r.name = 'dash-mode'; r.value = m[0]; r.id = 'dash-mode-' + m[0];
    r.checked = m[0] === (startMode || 'packed');
    modeIn[m[0]] = r;
    lab.appendChild(r);
    lab.appendChild(document.createTextNode(m[1]));
    ml.appendChild(lab);
  });
  box.appendChild(ml);

  var sl = document.createElement('label');
  sl.textContent = 'Start from';
  sl.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:12px; margin-top:8px;';
  var from = document.createElement('select');
  from.id = 'dash-from';
  if (ownDashboard()) {
    var o0 = document.createElement('option');
    o0.value = String(LAYOUT.id); o0.textContent = 'A copy of “' + LAYOUT.name + '”';
    from.appendChild(o0);
  }
  LAYOUTS.templates.forEach(function (t) {
    var o = document.createElement('option');
    o.value = String(t.id);
    o.textContent = t.name + (t.is_default ? ' (shared default)' : '');
    from.appendChild(o);
  });
  from.value = String(LAYOUT ? LAYOUT.id : '');
  sl.appendChild(from);
  box.appendChild(sl);
  function syncMode() { sl.hidden = modeIn.free.checked; }
  modeIn.free.addEventListener('change', syncMode);
  modeIn.packed.addEventListener('change', syncMode);
  syncMode();

  var note = document.createElement('div');
  note.className = 'note';
  note.style.cssText = 'color:#c0392b; min-height:14px; font-size:11px;';
  box.appendChild(note);

  var acts = document.createElement('div');
  acts.style.cssText = 'display:flex; gap:8px; justify-content:flex-end; margin-top:8px;';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  var go = document.createElement('button');
  go.type = 'button'; go.id = 'dash-create'; go.textContent = 'Create';
  acts.appendChild(cancel); acts.appendChild(go);
  box.appendChild(acts);

  function close() {
    document.removeEventListener('keydown', onKey);
    if (back.parentNode) { back.parentNode.removeChild(back); }
  }
  function onKey(ev) { if (ev.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  back.addEventListener('click', function (ev) { if (ev.target === back) { close(); } });
  go.addEventListener('click', function () {
    if (!name.value.trim()) { note.textContent = 'It needs a name.'; name.focus(); return; }
    go.disabled = true;
    var free = modeIn.free.checked;
    api('POST', 'api/layouts', free ? { kind: 'dashboard', name: name.value.trim(), mode: 'free' }
                                    : { kind: 'dashboard', name: name.value.trim(),
                                        from_id: Number(from.value) || null })
      .then(function (r) {
        close();
        setUserLayout(r.id);
        return loadLayouts().then(function () { return refresh(); }).then(function () {
          if (then) { then(); }
        });
      })
      .catch(function (e) {
        go.disabled = false;
        note.textContent = /409/.test(e.message) ? 'You already have a dashboard with that name.'
                                                 : e.message;
      });
  });
  back.appendChild(box);
  document.body.appendChild(back);
  name.focus();
  name.select();
}

(function () {
  var d = document.getElementById('edit-done');
  if (d) { d.addEventListener('click', function () { setEditMode(false); }); }
  var r = document.getElementById('edit-revert');
  if (r) { r.addEventListener('click', revertDashboard); }
})();
