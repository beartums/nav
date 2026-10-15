// custom-tiles.js -- Custom tiles: group and audience pickers, create / delete.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// --- custom tiles ----------------------------------------------------
// A custom tile is a BOOKMARK, not a grant -- see the schema comment. It
// exists because the generated link-only applications cannot express a
// target that is not https://<host>.example.com: AdGuard on bare metal
// at 192.0.2.8, Pomerium's own /.pomerium page, anything off-network.
//
// These are written IMMEDIATELY rather than staged with the rest of the
// table. Creating a row and deleting one are not field edits: staging them
// would mean Cancel had to un-create things, and a half-staged tile that
// the table is already rendering has nothing sensible to show for its
// slug. The fields ON a custom tile stage normally once it exists.
/** Group chooser: a text box that filters the existing groups as you type,
 *  plus an explicit "create" row.
 *
 *  A combobox rather than a <select> because both are true at once: almost
 *  every tile belongs to a group that already exists, and occasionally one
 *  needs a new one. Free text alone produced "Infrastucture" sitting next
 *  to "Infrastructure" with no hint that anything was wrong -- a category
 *  is matched by exact string, so a typo silently makes a second group.
 *
 *  Returns the same { label, input } shape as field(), so it drops into
 *  the tile editor without changing how that form reads its values.
 */
function groupPicker(labelText, current, placeholder) {
  var l = document.createElement('label');
  if (labelText) {
    var t = document.createElement('span'); t.textContent = labelText;
    l.appendChild(t);
  }
  var wrap = document.createElement('div');
  wrap.className = 'gp';
  var input = document.createElement('input');
  input.type = 'text';
  input.value = current || '';
  input.placeholder = placeholder || '';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.autocomplete = 'off';
  input.className = input.value ? '' : 'inherited';
  var pop = document.createElement('div');
  pop.className = 'gp-pop';
  pop.hidden = true;
  wrap.appendChild(input); wrap.appendChild(pop);
  l.appendChild(wrap);

  function groups() { return categoriesOf(APPS, true); }

  // The input event is dispatched so anything listening on the field sees
  // the change -- but this widget's OWN input handler reopens the list, so
  // picking an option closed it and immediately reopened it. Suppress just
  // that one reentry rather than skipping the event and going silent.
  var picking = false;
  function choose(name) {
    input.value = name;
    input.className = name ? '' : 'inherited';
    close();
    picking = true;
    try { input.dispatchEvent(new Event('input', { bubbles: true })); }
    finally { picking = false; }
  }
  function close() { pop.hidden = true; input.setAttribute('aria-expanded', 'false'); }

  function draw() {
    pop.innerHTML = '';
    var q = input.value.trim().toLowerCase();
    var all = groups();
    var hits = all.filter(function (g) { return g.toLowerCase().indexOf(q) !== -1; });
    hits.forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = g;
      if (g.toLowerCase() === q) { b.className = 'on'; }
      b.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(g); });
      pop.appendChild(b);
    });

    // The create row. Disabled when the name is already taken -- checked
    // case-insensitively, because "Media" and "media" would render as two
    // headings and nobody means that.
    var typed = input.value.trim();
    var clash = all.filter(function (g) { return g.toLowerCase() === typed.toLowerCase(); })[0];
    var mk = document.createElement('button');
    mk.type = 'button'; mk.className = 'mk';
    if (!typed) {
      mk.textContent = '+ New group…';
      mk.disabled = true;
      mk.title = 'Type a name first';
    } else if (clash) {
      mk.textContent = '+ New group “' + typed + '”';
      mk.disabled = true;
    } else {
      mk.textContent = '+ New group “' + typed + '”';
      mk.addEventListener('mousedown', function (ev) { ev.preventDefault(); choose(typed); });
    }
    pop.appendChild(mk);
    if (clash) {
      var why = document.createElement('div');
      why.className = 'why';
      why.textContent = '“' + clash + '” already exists— choose it above.';
      pop.appendChild(why);
    }
    if (!hits.length && !typed) {
      var none = document.createElement('div');
      none.className = 'why';
      none.textContent = 'No groups yet.';
      pop.insertBefore(none, mk);
    }
  }

  function open() { pop.hidden = false; input.setAttribute('aria-expanded', 'true'); draw(); }
  input.addEventListener('focus', open);
  input.addEventListener('input', function () {
    input.className = input.value ? '' : 'inherited';
    if (picking) { return; }
    open();
  });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !pop.hidden) { ev.stopPropagation(); close(); }
  });
  // blur, not a document click: mousedown on the options already fires
  // first and is cancelled, so the value lands before this runs.
  input.addEventListener('blur', function () { window.setTimeout(close, 0); });

  return { label: l, input: input, value: function () { return input.value.trim(); } };
}

// Groups and users, fetched once per admin session. Only ever used to
// populate the audience picker, and the picker only decides who is OFFERED
// a bookmark -- it gates nothing. See the schema comment on custom_tiles.
var PRINCIPALS = null;

function loadPrincipals() {
  if (PRINCIPALS) { return Promise.resolve(PRINCIPALS); }
  return api('GET', 'api/admin/principals')
    .then(function (r) { PRINCIPALS = r || { groups: [], users: [] }; return PRINCIPALS; })
    // A directory that will not load must not block creating a tile. No
    // audience means "everyone who can load nav", which is the default
    // anyway -- so degrade to that and say so rather than refuse.
    .catch(function () { PRINCIPALS = { groups: [], users: [], failed: true }; return PRINCIPALS; });
}

/** Multi-select over groups and users. Returns { el, value() }. */
function audiencePicker(selected) {
  var chosen = {};
  (selected || []).forEach(function (e) {
    var v = String(e).toLowerCase();
    chosen[v.indexOf(':') === -1 ? 'group:' + v : v] = 1;
  });

  var wrap = document.createElement('div');
  wrap.className = 'aud';
  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'aud-btn';
  wrap.appendChild(btn);
  var pop = document.createElement('div');
  pop.className = 'aud-pop';
  pop.hidden = true;
  wrap.appendChild(pop);

  function label() {
    var keys = Object.keys(chosen);
    if (!keys.length) { return 'Everyone who can open nav'; }
    if (keys.length <= 2) {
      return keys.map(function (k) { return k.split(':').slice(1).join(':'); }).join(', ');
    }
    return keys.length + ' selected';
  }
  function paintBtn() { btn.textContent = label() + ' ▾'; }
  paintBtn();

  var filter = document.createElement('input');
  filter.className = 'f'; filter.type = 'search'; filter.placeholder = 'Filter…';
  var body = document.createElement('div');
  pop.appendChild(filter); pop.appendChild(body);

  function draw() {
    body.innerHTML = '';
    var q = filter.value.trim().toLowerCase();
    var p = PRINCIPALS || { groups: [], users: [] };
    if (p.failed) {
      var warn = document.createElement('div');
      warn.className = 'none';
      warn.textContent = 'Could not load groups and users. Leave empty to offer this ' +
                         'tile to everyone who can open nav.';
      body.appendChild(warn);
      return;
    }
    var any = false;
    function section(title, items, prefix, text) {
      var hits = items.filter(function (i) { return text(i).toLowerCase().indexOf(q) !== -1; });
      if (!hits.length) { return; }
      any = true;
      var h = document.createElement('h4'); h.textContent = title; body.appendChild(h);
      hits.forEach(function (i) {
        var key = prefix + (prefix === 'user:' ? i.email : i).toLowerCase();
        var l = document.createElement('label');
        var cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = !!chosen[key]; cb.value = key;
        cb.addEventListener('change', function () {
          if (cb.checked) { chosen[key] = 1; } else { delete chosen[key]; }
          paintBtn();
        });
        l.appendChild(cb);
        l.appendChild(document.createTextNode(text(i)));
        body.appendChild(l);
      });
    }
    section('Groups', p.groups || [], 'group:', function (g) { return g; });
    section('Users', p.users || [], 'user:', function (u) {
      return u.name ? u.name + ' — ' + u.email : u.email;
    });
    if (!any) {
      var n = document.createElement('div');
      n.className = 'none';
      n.textContent = q ? 'Nothing matches “' + q + '”.' : 'No groups or users.';
      body.appendChild(n);
    }
  }
  filter.addEventListener('input', draw);

  btn.addEventListener('click', function () {
    if (!pop.hidden) { pop.hidden = true; return; }
    pop.hidden = false;
    loadPrincipals().then(function () { draw(); filter.focus(); });
  });

  return {
    el: wrap,
    value: function () { return Object.keys(chosen); }
  };
}

// One dialog for both. Editing used to be a prompt() for the URL alone,
// which had nowhere to put an audience and no way to show what was already
// chosen.
function newTileDialog(existing) {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card); color:var(--fg); border:1px solid var(--line);' +
                      'border-radius:10px; padding:16px; width:min(460px, 92vw);' +
                      'display:flex; flex-direction:column; gap:10px;';
  var h = document.createElement('strong');
  h.textContent = existing ? 'Edit tile' : 'New tile';
  box.appendChild(h);

  var hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px; color:var(--muted);';
  hint.textContent = 'A link to something that is not an Authentik application. ' +
                     'This offers the link; it does not grant access to anything.';
  box.appendChild(hint);

  function row(label, placeholder) {
    var l = document.createElement('label');
    l.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:12px;';
    l.appendChild(document.createTextNode(label));
    var i = document.createElement('input');
    i.type = 'text'; i.placeholder = placeholder || '';
    i.style.cssText = 'padding:6px 8px; font:inherit; background:var(--bg); color:var(--fg);' +
                      'border:1px solid var(--line); border-radius:5px;';
    l.appendChild(i);
    box.appendChild(l);
    return i;
  }
  var fName = row('Name', 'AdGuard Home');
  var fUrl = row('URL', 'http://192.0.2.8/');
  var fSlug = row('Slug', 'lowercase, digits and hyphens');
  // groupPicker returns its own <label>; nesting it inside another would
  // be invalid and would make the caption click into the wrong control.
  var gp = groupPicker('Group', '', 'Infrastructure');
  gp.label.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:12px;';
  gp.input.style.cssText = 'padding:6px 8px; font:inherit; background:var(--bg);' +
                           'color:var(--fg); border:1px solid var(--line); border-radius:5px;';
  box.appendChild(gp.label);
  var fCat = gp.input;
  var fDesc = row('Description', '');
  if (existing) {
    fName.value = existing.name || '';
    fUrl.value = existing.url || '';
    fSlug.value = existing.slug;
    // The slug is the primary key and the icon filename. Changing it would
    // be a create plus a delete, silently orphaning overrides and clicks.
    fSlug.disabled = true;
    fSlug.title = 'A slug cannot be changed; delete the tile and make a new one';
    fCat.value = existing.category || '';
    fDesc.value = existing.description || '';
  }

  var aud = document.createElement('label');
  aud.style.cssText = 'display:flex; flex-direction:column; gap:3px; font-size:12px;';
  aud.appendChild(document.createTextNode('Offered to'));
  var picker = audiencePicker(existing ? (existing.visible_to || []) : []);
  aud.appendChild(picker.el);
  var audNote = document.createElement('div');
  audNote.style.cssText = 'font-size:11px; color:var(--muted);';
  audNote.textContent = 'Who is shown this link. It grants no access \u2014 whatever is ' +
                        'at the other end is exactly as reachable either way.';
  aud.appendChild(audNote);
  box.appendChild(aud);

  // Derive the slug from the name until the field is touched, so the
  // common case needs no thought and the unusual one is still reachable.
  var slugTouched = !!existing;
  fSlug.addEventListener('input', function () { slugTouched = true; });
  fName.addEventListener('input', function () {
    if (slugTouched) { return; }
    fSlug.value = fName.value.trim().toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  });

  var note = document.createElement('div');
  note.style.cssText = 'font-size:11px; color:#c0392b; min-height:14px;';
  box.appendChild(note);

  var actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  var create = document.createElement('button');
  create.type = 'button'; create.id = 'newtile-create';
  create.textContent = existing ? 'Save' : 'Create';
  actions.appendChild(cancel); actions.appendChild(create);
  box.appendChild(actions);

  function close() {
    document.removeEventListener('keydown', onKey);
    if (back.parentNode) { back.parentNode.removeChild(back); }
  }
  function onKey(ev) { if (ev.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);
  back.addEventListener('click', function (ev) { if (ev.target === back) { close(); } });

  create.addEventListener('click', function () {
    var slug = fSlug.value.trim();
    var url = fUrl.value.trim();
    if (!fName.value.trim()) { note.textContent = 'A tile needs a name.'; return; }
    // Same shape valid_slug() enforces in urls.py. Checked here only so
    // the message is immediate; the server is still the authority.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
      note.textContent = 'Slug must be lowercase letters, digits and hyphens.';
      return;
    }
    if (!/^(https?:\/\/|\/)/i.test(url)) {
      note.textContent = 'URL must start with http://, https:// or /.';
      return;
    }
    create.disabled = true;
    api('PUT', 'api/admin/custom-tiles/' + encodeURIComponent(slug), {
      url: url, name: fName.value.trim(),
      description: fDesc.value.trim(), category: fCat.value.trim(),
      icon: existing ? (existing.icon || '') : '',
      icon_light: existing ? (existing.icon_light || '') : '',
      visible_to: picker.value()
    }).then(function () { close(); refresh(); })
      .catch(function (e) { create.disabled = false; note.textContent = e.message; });
  });

  back.appendChild(box);
  document.body.appendChild(back);
  fName.focus();
}

function deleteTile(a) {
  if (!confirm('Delete the tile "' + (a.name || a.slug) + '"?\n\n' +
               'This removes the bookmark and its overrides. Nothing at the ' +
               'other end of the link is affected.')) { return; }
  api('DELETE', 'api/admin/custom-tiles/' + encodeURIComponent(a.slug))
    .then(refresh)
    .catch(function (e) { alert('Delete failed: ' + e.message); });
}
