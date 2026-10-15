// admin.js -- Administrative mode: shared admin state, api(), impersonation and view-as.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// --- administrative mode ------------------------------------------------
var IS_ADMIN = false;
var ADMIN_MODE = false;
var MAY_IMPERSONATE = false;
// Who is being viewed, or null. The tiles on screen are THEIRS; every
// write still goes out as the real caller, which is why admin mode and
// this are mutually exclusive below.
var IMPERSONATING = null;
var OVERRIDES = {};          // slug -> fields, as stored
var SITE = {};
var GROUP_ORDER = [];        // category names, in the order they render

// Collapsed categories are a VIEW preference and per device: a phone and a
// desktop legitimately want different things folded away. Everything else
// the admin sets is central.
var collapsed = {};
try { collapsed = JSON.parse(localStorage.getItem('nav.collapsed') || '{}'); } catch (e) {}
function saveCollapsed() {
  try { localStorage.setItem('nav.collapsed', JSON.stringify(collapsed)); } catch (e) {}
}

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    if (!r.ok) { throw new Error(method + ' ' + path + ' \u2192 ' + r.status); }
    return r.status === 204 ? null : r.json().catch(function () { return null; });
  });
}

function applyImpersonation() {
  document.body.classList.toggle('impersonating', !!IMPERSONATING);
  if (!IMPERSONATING) { return; }
  var who = document.getElementById('imp-who');
  var note = document.getElementById('imp-note');
  who.textContent = 'Viewing as ' + IMPERSONATING.subject;
  var bits = [];
  if (IMPERSONATING.kind === 'both') {
    bits.push('Their real access, plus what ' +
              (IMPERSONATING.groups || []).map(function (g) { return '\u201c' + g + '\u201d'; })
                .join(' and ') + ' would add. Added tiles are outlined.');
  } else if (IMPERSONATING.kind === 'group') {
    // A hypothetical user in exactly these groups -- NOT a real member.
    // Sampling a real member answers a different question: real people
    // belong to several groups at once, so "view as family" used to
    // render everything evan could reach.
    bits.push('A hypothetical user in ' +
              (IMPERSONATING.groups || []).map(function (g) { return '\u201c' + g + '\u201d'; })
                .join(' and ') +
              ' and no other group. Real members usually belong to more, so they ' +
              'will see at least this much and often more.');
  }
  var und = IMPERSONATING.undetermined || [];
  if (und.length) {
    // Named, not dropped. Silently omitting an application this cannot
    // judge would make an incomplete answer look complete.
    bits.push('\u26a0 Could not evaluate ' + und.length + ' application' +
              (und.length === 1 ? '' : 's') + ' (' + und.join(', ') +
              '): they carry policy bindings, which only Authentik can decide. ' +
              'Neither shown nor ruled out.');
  }
  if (IMPERSONATING.empty) {
    bits.push(IMPERSONATING.user
      ? 'Authentik returned no applications for them \u2014 either they have none, ' +
        'or there is no such account.'
      : 'Nothing is reachable by those groups alone.');
  }
  bits.push('Tiles only, on the default template: their dashboards and click counts are ' +
            'not read. This grants nothing \u2014 clicking a tile still goes ' +
            'out as you.');
  note.textContent = bits.join(' · ');
}

function stopImpersonating() {
  IMPERSONATING = null;
  applyImpersonation();
  refresh();
}
document.getElementById('imp-exit').addEventListener('click', stopImpersonating);

// Which principals the "View as" picker offers. Authentik holds every
// account and group -- service accounts, admin roles nothing is bound to --
// and most of them are noise in that picker. Stored as a site setting, so
// an empty setting means "offer everything", which is what a fresh install
// should do.
//
// Its own screen, not a column in the bulk table: this is a list of PEOPLE
// AND GROUPS, and the bulk table is a list of tiles. Bolting one onto the
// other would make a table that is two tables.
function viewAsListDialog() {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card); color:var(--fg); border:1px solid var(--line);' +
                      'border-radius:10px; padding:16px; width:min(520px, 92vw);' +
                      'display:flex; flex-direction:column; gap:10px;';
  var h = document.createElement('strong');
  h.textContent = 'View-as list';
  box.appendChild(h);
  var hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px; color:var(--muted);';
  hint.textContent = 'Which people and groups appear in the "View as" picker. ' +
                     'Tick none and everything is offered. This changes the picker only ' +
                     '— it is not access control and hides nothing from anyone.';
  box.appendChild(hint);

  var note = document.createElement('div');
  note.style.cssText = 'font-size:11px; color:#c0392b; min-height:14px;';

  var wrap = document.createElement('div');
  wrap.className = 'bulkwrap';
  wrap.style.maxHeight = '320px';
  wrap.style.overflowY = 'auto';
  var t = document.createElement('table');
  t.className = 'bulk';
  t.id = 'viewas-table';
  var thead = document.createElement('thead');
  var hr = document.createElement('tr');
  ['Show', 'Kind', 'Name'].forEach(function (x) {
    var th = document.createElement('th'); th.textContent = x; hr.appendChild(th);
  });
  thead.appendChild(hr); t.appendChild(thead);
  var tb = document.createElement('tbody');
  t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);

  var pickG = {}, pickU = {};
  function fill() {
    tb.innerHTML = '';
    var p = PRINCIPALS || {};
    var groups = p.all_groups || p.groups || [];
    var users = p.all_users || p.users || [];
    // An unset list means "everything", so pre-tick everything: the screen
    // should open showing what the picker currently does.
    var on = p.curated ? null : true;
    groups.forEach(function (g) {
      if (pickG[g] === undefined) { pickG[g] = on !== null ? on : (p.groups || []).indexOf(g) !== -1; }
    });
    users.forEach(function (u) {
      if (pickU[u.email] === undefined) {
        pickU[u.email] = on !== null ? on
          : (p.users || []).some(function (x) { return x.email === u.email; });
      }
    });
    function row(kind, label, key, store) {
      var tr = document.createElement('tr');
      var c1 = document.createElement('td');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!store[key];
      cb.addEventListener('change', function () { store[key] = cb.checked; });
      c1.appendChild(cb); tr.appendChild(c1);
      var c2 = document.createElement('td'); c2.textContent = kind; tr.appendChild(c2);
      var c3 = document.createElement('td'); c3.textContent = label; tr.appendChild(c3);
      tb.appendChild(tr);
    }
    groups.forEach(function (g) { row('group', g, g, pickG); });
    users.forEach(function (u) {
      row('person', u.name ? u.name + ' — ' + u.email : u.email, u.email, pickU);
    });
    if (!groups.length && !users.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 3; td.textContent = 'Could not load groups and users.';
      tr.appendChild(td); tb.appendChild(tr);
    }
  }

  box.appendChild(note);
  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
  var all = document.createElement('button');
  all.type = 'button'; all.id = 'viewas-all'; all.textContent = 'Offer everything';
  all.style.marginRight = 'auto';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  var save = document.createElement('button');
  save.type = 'button'; save.id = 'viewas-save'; save.textContent = 'Save';
  actions.appendChild(all); actions.appendChild(cancel); actions.appendChild(save);
  box.appendChild(actions);

  function close() {
    document.removeEventListener('keydown', onKey);
    if (back.parentNode) { back.parentNode.removeChild(back); }
  }
  function onKey(ev) { if (ev.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  back.addEventListener('click', function (ev) { if (ev.target === back) { close(); } });

  all.addEventListener('click', function () {
    // Clearing the setting, not ticking every box: the two differ when a
    // group is added to Authentik later. `null` keeps offering everything;
    // a full list freezes today's roster.
    api('PUT', 'api/site/viewas_list', { value: null })
      .then(function () { PRINCIPALS = null; close(); })
      .catch(function (e) { note.textContent = e.message; });
  });
  save.addEventListener('click', function () {
    var value = {
      groups: Object.keys(pickG).filter(function (k) { return pickG[k]; }),
      users: Object.keys(pickU).filter(function (k) { return pickU[k]; })
    };
    api('PUT', 'api/site/viewas_list', { value: value })
      .then(function () { PRINCIPALS = null; close(); })
      .catch(function (e) { note.textContent = e.message; });
  });

  back.appendChild(box);
  document.body.appendChild(back);
  loadPrincipals().then(fill);
}
document.getElementById('admin-viewas-btn')
  .addEventListener('click', viewAsListDialog);

function impersonateDialog() {
  // ONE user, MANY groups. A person is a specific account; groups are a
  // hypothesis about membership, and several of them is still one
  // hypothesis. Choosing both asks "what would these groups ADD for this
  // person", which is the question with an actual decision attached.
  var chosenUser = IMPERSONATING ? (IMPERSONATING.user || null) : null;
  var chosenGroups = {};
  if (IMPERSONATING) {
    (IMPERSONATING.groups || []).forEach(function (g) { chosenGroups[g] = 1; });
  }

  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card); color:var(--fg); border:1px solid var(--line);' +
                      'border-radius:10px; padding:16px; width:min(480px, 92vw);' +
                      'display:flex; flex-direction:column; gap:10px;';
  var h = document.createElement('strong');
  h.textContent = 'View as…';
  box.appendChild(h);
  var hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px; color:var(--muted);';
  hint.textContent = 'One person, any number of groups. Picking both highlights what ' +
                     'the groups would ADD for that person. It grants nothing: every ' +
                     'tile is a link, and each target still checks you. Use is logged.';
  box.appendChild(hint);

  var summary = document.createElement('div');
  summary.id = 'imp-summary';
  summary.style.cssText = 'font-size:12px; min-height:16px;';
  box.appendChild(summary);

  var list = document.createElement('div');
  list.className = 'aud-pop';
  list.style.cssText = 'position:static; max-height:250px;';
  var filter = document.createElement('input');
  filter.className = 'f'; filter.type = 'search'; filter.placeholder = 'Filter…';
  var body = document.createElement('div');
  list.appendChild(filter); list.appendChild(body);
  box.appendChild(list);

  function describe() {
    var gs = Object.keys(chosenGroups);
    if (!chosenUser && !gs.length) { return 'Nothing selected.'; }
    var parts = [];
    if (chosenUser) { parts.push(chosenUser); }
    if (gs.length) { parts.push(gs.length + ' group' + (gs.length === 1 ? '' : 's') +
                                ': ' + gs.join(', ')); }
    return parts.join(' + ');
  }
  function paint() {
    summary.textContent = describe();
    go.disabled = !chosenUser && !Object.keys(chosenGroups).length;
    draw();
  }

  function draw() {
    body.innerHTML = '';
    var q = filter.value.trim().toLowerCase();
    var p = PRINCIPALS || { groups: [], users: [] };
    if (p.failed) {
      var w = document.createElement('div');
      w.className = 'none'; w.textContent = 'Could not load groups and users.';
      body.appendChild(w); return;
    }
    var any = false;
    function row(text, on, onclick) {
      var l = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!on;
      cb.addEventListener('change', function () { onclick(cb.checked); });
      l.appendChild(cb);
      l.appendChild(document.createTextNode(text));
      body.appendChild(l);
    }
    var gs = (p.groups || []).filter(function (g) { return g.toLowerCase().indexOf(q) !== -1; });
    if (gs.length) {
      any = true;
      var gh = document.createElement('h4'); gh.textContent = 'Groups (any number)';
      body.appendChild(gh);
      gs.forEach(function (g) {
        row(g, chosenGroups[g], function (on) {
          if (on) { chosenGroups[g] = 1; } else { delete chosenGroups[g]; }
          paint();
        });
      });
    }
    var us = (p.users || []).filter(function (u) {
      return (u.name + ' ' + u.email).toLowerCase().indexOf(q) !== -1;
    });
    if (us.length) {
      any = true;
      var uh = document.createElement('h4'); uh.textContent = 'Person (one only)';
      body.appendChild(uh);
      us.forEach(function (u) {
        row(u.name ? u.name + ' — ' + u.email : u.email, chosenUser === u.email,
            function (on) {
              // Radio behaviour on checkboxes: a second person replaces the
              // first rather than silently being ignored.
              chosenUser = on ? u.email : null;
              paint();
            });
      });
    }
    if (!any) {
      var n = document.createElement('div');
      n.className = 'none';
      n.textContent = q ? 'Nothing matches “' + q + '”.' : 'No groups or users.';
      body.appendChild(n);
    }
  }
  filter.addEventListener('input', draw);

  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  var go = document.createElement('button');
  go.type = 'button'; go.id = 'imp-go'; go.textContent = 'View';
  actions.appendChild(cancel); actions.appendChild(go);
  box.appendChild(actions);

  go.addEventListener('click', function () {
    var gs = Object.keys(chosenGroups);
    IMPERSONATING = { kind: chosenUser && gs.length ? 'both' : chosenUser ? 'user' : 'group',
                      user: chosenUser, groups: gs, subject: describe(), added: [] };
    if (ADMIN_MODE) { setAdminMode(false); } else { refresh(); }
    close();
  });

  function close() {
    document.removeEventListener('keydown', onKey);
    if (back.parentNode) { back.parentNode.removeChild(back); }
  }
  function onKey(ev) { if (ev.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  back.addEventListener('click', function (ev) { if (ev.target === back) { close(); } });

  back.appendChild(box);
  document.body.appendChild(back);
  loadPrincipals().then(function () { paint(); filter.focus(); });
}

function setAdminMode(on) {
  // Entering admin mode ends impersonation. The admin UI writes, and every
  // write goes out as the real caller -- editing while the screen shows
  // someone else's tiles is how you change the wrong thing confidently.
  if (on && IMPERSONATING) { IMPERSONATING = null; applyImpersonation(); }
  // Leaving admin mode with staged edits would discard them with no sign
  // that anything was lost, so say so. BULK is declared later in the file
  // but `var` hoists, hence the guard rather than a direct read.
  if (!on && typeof BULK !== 'undefined' && BULK && BULK.on &&
      Object.keys(BULK.dirty).length &&
      !confirm(Object.keys(BULK.dirty).length + ' unsaved change(s) will be discarded. Leave anyway?')) {
    return;
  }
  if (typeof BULK !== 'undefined' && BULK) { BULK.on = false; BULK.dirty = {}; BULK.snapshot = null; }
  ADMIN_MODE = on && IS_ADMIN;
  // One editor at a time: a template, or your own dashboard.
  if (ADMIN_MODE && EDIT_MODE) { EDIT_MODE = false; document.body.classList.remove('edit-mode'); }
  document.body.classList.toggle('admin-mode', ADMIN_MODE);
  closeEditor();
  refresh();
}
document.getElementById('admin-done').addEventListener('click', function () { setAdminMode(false); });
