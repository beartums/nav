// access.js -- who is in which group, staged as a pull request.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Reuses
// the admin page host (admin-pages.js), like connections.js. Server half: /api/admin/access
// (api/access.py). Nothing here changes access directly: a click stages a
// membership change, "Open PR" turns every staged change into one pull request
// on the GitOps repo, and access changes when that is merged and applied.
'use strict';

function accessPage(h) {
  var note = h.note;
  var save = h.save;
  note.textContent = 'Loading…';
  h.body.innerHTML = '';
  var view = null;

  function staged(pk, group) {
    return (view.pending || []).filter(function (c) { return c.pk === pk && c.group === group; })[0];
  }

  function cell(u, g) {
    var td = document.createElement('td');
    var on = u.groups.indexOf(g.name) >= 0;
    var c = staged(u.pk, g.name);
    var will = c ? c.action === 'add' : on;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'acc-cell' + (c ? ' acc-staged' : '');
    b.setAttribute('aria-pressed', String(will));
    b.textContent = c ? (c.action === 'add' ? '+' : '−') : (on ? '●' : '');
    b.dataset.pk = u.pk;
    b.dataset.group = g.name;
    var drift = u.drift.indexOf(g.name) >= 0;
    if (!g.managed) {
      b.disabled = true;
      b.title = g.name + ': not managed in Terraform (no users list) -- change it in Authentik';
    } else {
      b.title = (c ? 'Staged: ' + (c.action === 'add' ? 'joins ' : 'leaves ') + g.name + '. Click to undo'
                   : (on ? 'In ' + g.name + '. Click to stage leaving it' : 'Not in ' + g.name + '. Click to stage joining it')) +
                (drift ? '\n⚠ Authentik differs from ' + view.base + ' (merged but not applied, or edited in Authentik)' : '');
    }
    if (drift) { td.className = 'acc-drift'; }
    td.appendChild(b);
    return td;
  }

  // Two views: group membership (staged as a PR), and each app's own accounts (read-only).
  // Which view, and which way round App accounts is: remembered per browser.
  var PREF = 'nav.accessView';
  var pref = {};
  try { pref = JSON.parse(localStorage.getItem(PREF) || '{}') || {}; } catch (e) {}
  // A link (?admin=access&view=apps&pivot=1) wins over what this browser remembers.
  var want = h.want || {};
  var mode = (want.view || pref.mode) === 'apps' ? 'apps' : 'groups';
  var pivot = 'pivot' in want ? want.pivot === '1' : !!pref.pivot, apps = null;
  function savePref() {
    try { localStorage.setItem(PREF, JSON.stringify({ mode: mode, pivot: pivot })); } catch (e) {}
  }
  function place() { return { view: mode, pivot: mode === 'apps' && pivot }; }
  urlPageSet(place());
  // Back/Forward within the page: another view, or the other way round.
  h.onURL = function (w) {
    mode = w.view === 'apps' ? 'apps' : 'groups';
    pivot = w.pivot === '1';
    urlPageSet(place());
    if (!view) { return; }            // still loading: it draws the chosen view when done
    if (mode === 'apps' && !apps) { note.textContent = 'Reading each app…'; loadApps(false); } else { render(); }
  };

  function switcher() {
    var sw = div('acc-switch');
    [['groups', 'Groups'], ['apps', 'App accounts']].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = m[1]; b.dataset.view = m[0];
      b.setAttribute('aria-pressed', String(mode === m[0]));
      b.addEventListener('click', function () {
        if (mode === m[0]) { return; }
        mode = m[0];
        savePref();
        urlPage(place(), true);
        if (mode === 'apps' && !apps) { note.textContent = 'Reading each app…'; loadApps(false); } else { render(); }
      });
      sw.appendChild(b);
    });
    h.body.appendChild(sw);
  }

  // "As of 14:02 (3 min ago) · Refresh": the server keeps what it read for ten
  // minutes; Refresh reads Authentik, the repo and the apps again now.
  function freshness(at, text, again) {
    var line = div('note acc-asof', '');
    var info = document.createElement('span');
    info.className = 'tb-info acc-info';
    info.textContent = '\u24d8';
    info.title = text;
    info.setAttribute('role', 'img');
    info.setAttribute('aria-label', text);
    info.tabIndex = 0;
    line.appendChild(info);
    line.appendChild(document.createTextNode(' '));
    if (at) {
      var mins = Math.max(0, Math.round((Date.now() / 1000 - at) / 60));
      line.appendChild(document.createTextNode('As of ' + new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
        ' (' + (mins ? mins + ' min ago' : 'just now') + '). '));
    }
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'linkish acc-refresh'; b.textContent = 'Refresh';
    b.title = 'Read again now';
    b.addEventListener('click', again);
    line.appendChild(b);
    h.body.appendChild(line);
  }

  // Each cell is an indicator; the words are its hover text (and its label for
  // a screen reader). ACC_KEY is the legend above the grid.
  var ACC_KEY = [['admin', '★', 'Admin account'], ['user', '●', 'Account'],
                 ['disabled', '○', 'Disabled account'],
                 ['stale', '⚠', 'Account, but Authentik no longer lets them in'],
                 ['missing', '✕', 'No account, though Authentik lets them in'],
                 ['notyet', '◌', 'Not signed in yet (the app makes the account then)']];
  function ind(kind, title) {
    var k = ACC_KEY.filter(function (x) { return x[0] === kind; })[0];
    var sp = document.createElement('span');
    sp.className = 'acc-ind acc-ind-' + kind;
    sp.textContent = k[1];
    sp.title = title || k[2];
    sp.setAttribute('role', 'img');
    sp.setAttribute('aria-label', sp.title);
    return sp;
  }
  function appCell(p, a) {
    var td = document.createElement('td');
    td.className = 'acc-cellind';
    var c = p.cells[a.key];
    if (a.error) { td.classList.add('acc-na'); td.title = a.label + ' could not be read: ' + a.error; }
    else if (!c) { /* neither an account nor access */ }
    else if (c.status === 'missing') {
      td.appendChild(c.provision === 'first'
        ? ind('notyet', 'Authentik lets ' + p.name + ' open ' + a.label + '; the account appears at their first sign-in')
        : ind('missing', 'Authentik lets ' + p.name + ' open ' + a.label + ', but nobody has made them an account'));
    } else {
      var kind = c.status === 'stale' ? 'stale' : c.disabled ? 'disabled' : c.role === 'admin' ? 'admin' : 'user';
      td.appendChild(ind(kind, (c.status === 'stale' ? 'Leftover account: Authentik no longer lets ' + p.name + ' open ' + a.label
                                : (c.disabled ? 'Disabled ' : '') + (c.role === 'admin' ? 'Admin account' : 'Account')) +
        (c.login ? ' · ' + c.login : '') + (c.note ? ' · ' + c.note : '') + (c.status === 'stale' ? ' (' + c.role + (c.disabled ? ', disabled' : '') + ')' : '') +
        (c.last_seen ? ' · last seen ' + new Date(c.last_seen).toLocaleString() : '')));
    }
    return td;
  }
  // How people sign in to each app, as a small tag on its heading (hover: what it means).
  var SIGNIN = {
    header:   ['auto', 'Signed in automatically: the app trusts the gateway, no second login'],
    oidc:     ['SSO', 'Signs in with Authentik: the app\u2019s own \u201cSign in with Authentik\u201d (or straight there)'],
    own:      ['pw', 'Its own username and password: a second login, made in the app'],
    plex:     ['Plex', 'A plex.tv account shared this server, or a managed Plex Home profile picked on a device signed in as the owner (optional PIN)'],
    jellyfin: ['JF', 'A Jellyfin account (its username and password)']
  };
  function signinTag(m) {
    var s = SIGNIN[m];
    if (!s) { return null; }
    var t = document.createElement('span');
    t.className = 'acc-signin acc-signin-' + m;
    t.textContent = s[0];
    t.title = s[1];
    t.setAttribute('role', 'img');
    t.setAttribute('aria-label', s[1]);
    return t;
  }
  function appHead(a, tag) {
    var th = document.createElement(tag || 'th');
    th.textContent = a.label;
    var st = signinTag(a.signin);
    if (st) { th.appendChild(st); }
    if (a.error) {
      // Coloured, with a warning icon; the reason is its hover text.
      th.classList.add('acc-app-err');
      var d = document.createElement('span');
      d.className = 'acc-head-warn';
      d.textContent = '\u26a0';
      d.title = a.label + ' could not be read: ' + a.error;
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', d.title);
      th.appendChild(d);
      th.title = d.title;
    } else {
      th.title = a.count + ' account(s) · Authentik app: ' + a.apps.join(', ') +
        (a.provision === 'first' ? ' · accounts are made at first sign-in' : ' · an admin makes the accounts') +
        (SIGNIN[a.signin] ? ' · ' + SIGNIN[a.signin][1] : '');
    }
    return th;
  }
  function legend() {
    var l = div('acc-legend');
    ACC_KEY.forEach(function (k) {
      var item = document.createElement('span');
      item.appendChild(ind(k[0]));
      item.appendChild(document.createTextNode(' ' + k[2]));
      l.appendChild(item);
    });
    h.body.appendChild(l);
  }
  function personHead(p, tag) {
    var el = document.createElement(tag || 'td');
    el.className = 'acc-who';
    el.textContent = p.name;
    el.appendChild(div('note', p.email || ''));
    return el;
  }

  function renderApps() {
    save.hidden = true;
    note.textContent = '';
    freshness(apps.as_of, "Each app's own accounts, read with its key in User management, matched to Authentik " +
      'people by email, then username. Read-only.', function () { note.textContent = 'Reading each app…'; loadApps(true); });
    var flip = document.createElement('button');
    flip.type = 'button'; flip.id = 'acc-pivot'; flip.className = 'acc-pivot';
    flip.textContent = '⇄ ' + (pivot ? 'People across' : 'Apps across');
    flip.title = 'Swap rows and columns';
    flip.setAttribute('aria-pressed', String(pivot));
    flip.addEventListener('click', function () { pivot = !pivot; savePref(); urlPage(place(), false); render(); });
    h.body.appendChild(flip);
    legend();

    var t = document.createElement('table');
    t.className = 'acc-table acc-apps-table' + (pivot ? ' acc-pivoted' : '');
    var hr = document.createElement('tr');
    var th0 = document.createElement('th'); th0.textContent = pivot ? 'App' : 'Person'; hr.appendChild(th0);
    if (pivot) { apps.people.forEach(function (p) { hr.appendChild(personHead(p, 'th')); }); }
    else { apps.apps.forEach(function (a) { hr.appendChild(appHead(a)); }); }
    t.appendChild(document.createElement('thead')).appendChild(hr);
    var tb = document.createElement('tbody');
    if (pivot) {
      apps.apps.forEach(function (a) {
        var tr = document.createElement('tr');
        tr.appendChild(appHead(a, 'td'));
        apps.people.forEach(function (p) { tr.appendChild(appCell(p, a)); });
        tb.appendChild(tr);
      });
    } else {
      apps.people.forEach(function (p) {
        var tr = document.createElement('tr');
        tr.appendChild(personHead(p));
        apps.apps.forEach(function (a) { tr.appendChild(appCell(p, a)); });
        tb.appendChild(tr);
      });
    }
    t.appendChild(tb);
    h.body.appendChild(t);
    var keys = Object.keys(apps.orphans || {});
    if (keys.length) {
      var box = div('acc-orphans');
      box.appendChild(div('ts-lab', 'Accounts that match nobody in Authentik'));
      keys.forEach(function (k) {
        var a = apps.apps.filter(function (x) { return x.key === k; })[0];
        box.appendChild(div('note', (a ? a.label : k) + ': ' + apps.orphans[k].map(function (o) {
          return (o.login || o.email || '?') + (o.role === 'admin' ? ' (admin)' : '') + (o.disabled ? ' (disabled)' : '');
        }).join(', ')));
      });
      h.body.appendChild(box);
    }
  }

  var appsReading = null;
  function loadApps(fresh) {
    if (appsReading && !fresh) { return appsReading; }
    appsReading = connSend('GET', 'api/admin/access/apps' + (fresh ? '?fresh=1' : ''))
      .then(function (v) { apps = v; note.textContent = ''; render(); })
      .catch(function (e) { note.textContent = 'Could not read the apps: ' + e.message; })
      .then(function () { appsReading = null; });
    return appsReading;
  }

  function render() {
    h.body.innerHTML = '';
    switcher();
    if (mode === 'apps') {
      // Not read yet (first open, or cleared after a PR): read, then draw.
      if (!apps) { note.textContent = 'Reading each app…'; loadApps(false); return; }
      renderApps(); return;
    }
    if (!view.enabled) {
      h.body.appendChild(div('note', 'The Access panel is off: nav-api needs NAV_GITOPS_REPO and NAV_GITOPS_TOKEN.'));
      save.disabled = true;
      return;
    }
    freshness(view.as_of, 'Membership as it is on ' + view.repo + ' ' + view.base +
      '. Click a cell to stage a change; Open PR puts every staged change into one pull request. ' +
      'Nothing changes until it is merged and applied.',
      function () { note.textContent = 'Reading…'; apps = null; load(true).then(function () { note.textContent = ''; }); });
    if (view.last_pr) {
      var last = div('note');
      last.appendChild(document.createTextNode('Last pull request: '));
      var a = document.createElement('a');
      a.href = view.last_pr.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = view.last_pr.url.replace(/^https:\/\/github\.com\//, '');
      last.appendChild(a);
      h.body.appendChild(last);
    }
    var addp = document.createElement('button');
    addp.type = 'button'; addp.id = 'acc-add-person'; addp.className = 'acc-add-person';
    addp.textContent = '+ Add person';
    addp.title = 'Create someone in Authentik now, and stage their groups for the next pull request';
    addp.addEventListener('click', function () { addPersonDialog(view, h, function () { apps = null; load(true); }); });
    h.body.appendChild(addp);
    var t = document.createElement('table');
    t.className = 'acc-table';
    var hr = document.createElement('tr');
    function th(text, cls, title) {
      var h = document.createElement('th');
      h.textContent = text;
      if (cls) { h.className = cls; }
      if (title) { h.title = title; }
      hr.appendChild(h);
    }
    th('Person');
    view.groups.forEach(function (g) {
      th(g.name, g.managed ? '' : 'acc-unmanaged', g.managed ? g.path : g.path + ' -- membership not in Terraform');
    });
    th('Apps');
    t.appendChild(document.createElement('thead')).appendChild(hr);
    var tb = document.createElement('tbody');
    view.users.forEach(function (u) {
      var tr = document.createElement('tr');
      var who = document.createElement('td');
      who.className = 'acc-who';
      who.textContent = u.name;
      who.appendChild(div('note', u.email || u.username || ''));
      tr.appendChild(who);
      view.groups.forEach(function (g) { tr.appendChild(cell(u, g)); });
      var apps = document.createElement('td');
      apps.className = 'acc-apps';
      var now = document.createElement('span');
      now.textContent = u.apps.length + ' app' + (u.apps.length === 1 ? '' : 's');
      now.title = u.apps.map(function (x) { return x.name; }).join('\n') || 'none';
      apps.appendChild(now);
      if (u.gains.length) { apps.appendChild(div('acc-gain', '+ ' + u.gains.join(', '))); }
      if (u.losses.length) { apps.appendChild(div('acc-loss', '− ' + u.losses.join(', '))); }
      if (u.unknown.length && (u.gains.length || u.losses.length)) {
        apps.appendChild(div('note', "can't judge: " + u.unknown.join(', ')));
      }
      tr.appendChild(apps);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    h.body.appendChild(t);
    (view.pending_emails || []).forEach(function (e) {
      var line = div('note acc-edge-staged');
      line.appendChild(personInd('ok', 'Staged: ' + e.email + ' joins the outside-access allow-list in the next pull request'));
      line.appendChild(document.createTextNode(' Outside access: ' + e.email + ' (' + e.name + ')'));
      h.body.appendChild(line);
    });
    var n = (view.pending || []).length + (view.pending_emails || []).length;
    if (n) {
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.id = 'acc-clear';
      clear.textContent = 'Clear ' + n + ' staged change' + (n === 1 ? '' : 's');
      clear.addEventListener('click', function () {
        connSend('DELETE', 'api/admin/access/changes').then(function (r) {
          view.pending = r.pending; view.pending_emails = r.pending_emails || []; load();
        })
          .catch(function (e) { note.textContent = e.message; });
      });
      h.body.appendChild(clear);
    }
    // Only when there is something to open: an idle "Open PR" reads as a to-do.
    save.hidden = !n;
    save.disabled = !n;
    save.textContent = 'Open PR (' + n + ')';
    note.textContent = n ? n + ' staged' : '';
  }

  h.body.addEventListener('click', function onCell(e) {
    var b = e.target.closest('.acc-cell');
    if (!b || b.disabled) { return; }
    var pk = Number(b.dataset.pk), group = b.dataset.group;
    var u = view.users.filter(function (x) { return x.pk === pk; })[0];
    b.disabled = true;
    connSend('POST', 'api/admin/access/changes',
             { pk: pk, group: group, add: b.getAttribute('aria-pressed') !== 'true', name: u.username || u.name })
      .then(function () { return load(); })
      .catch(function (err) { note.textContent = err.message; b.disabled = false; });
  });

  function load(fresh) {
    return connSend('GET', 'api/admin/access' + (fresh ? '?fresh=1' : '')).then(function (v) { view = v; render(); });
  }

  save.onclick = function () {
    save.disabled = true;
    note.textContent = 'Opening the pull request…';
    connSend('POST', 'api/admin/access/pr').then(function (r) {
      // Opening the PR changes what is worth showing: read everything again.
      apps = null;
      return load(true).then(function () {
        note.textContent = '';
        var a = document.createElement('a');
        a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Pull request opened';
        note.appendChild(a);
      });
    }).catch(function (e) { note.textContent = e.message; save.disabled = false; });
  };

  // Open on the view used last (App accounts reads its apps first).
  load().catch(function (e) { note.textContent = 'Could not load access: ' + e.message; });
}


// --- + Add person ---------------------------------------------------------------
// The Authentik user is made at Create (users live in Authentik, not Terraform);
// their groups -- and, for an address outside the household domain, the edge's
// allow-list -- are staged for the same pull request as any membership change.

var PERSON_IND = { ok: ['\u2713', 'acc-ind-user'], warn: ['\u26a0', 'acc-ind-stale'], bad: ['\u2715', 'acc-ind-missing'],
                   info: ['\u24d8', 'acc-ind-notyet'] };
function personInd(kind, title) {
  var sp = document.createElement('span');
  sp.className = 'acc-ind ' + PERSON_IND[kind][1] + ' person-ind-' + kind;
  sp.textContent = PERSON_IND[kind][0];
  sp.title = title;
  sp.setAttribute('role', 'img');
  sp.setAttribute('aria-label', title);
  return sp;
}

function addPersonDialog(view, h, done) {
  var ap = view.add_person || { groups: [], home_domain: null, outside_access: false };
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.className = 'smalldlg person-dlg';
  box.id = 'person-dlg';
  back.appendChild(box);
  document.body.appendChild(back);
  var created = null, checkTimer = null, checked = { taken: [], outside: null }, dirty = false;

  function close(force) {
    if (!force && dirty && !created && !confirm('Discard this person? Nothing has been created yet.')) { return; }
    back.remove();
    document.removeEventListener('keydown', onKey);
    h.setDirty(false);
    if (created) { done(); }
  }
  function onKey(e) { if (e.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', function (e) { if (e.target === back) { close(); } });

  var head = document.createElement('strong');
  head.textContent = 'Add person';
  box.appendChild(head);

  function field(label, id, type, hint) {
    var lab = document.createElement('label');
    lab.className = 'person-field';
    lab.appendChild(document.createTextNode(label + ' '));
    var inp = document.createElement('input');
    inp.type = type || 'text'; inp.id = id; inp.autocomplete = 'off'; inp.spellcheck = false;
    lab.appendChild(inp);
    var st = document.createElement('span');
    st.className = 'person-st';
    lab.appendChild(st);
    if (hint) { inp.title = hint; }
    box.appendChild(lab);
    return { input: inp, status: st };
  }
  var fUser = field('Username', 'person-username', 'text', 'Lowercase letters, digits, ., _ or -. Some apps match on it, so pick one to keep.');
  var fName = field('Name', 'person-name', 'text', 'As shown in apps');
  var fEmail = field('Email', 'person-email', 'email', 'Their sign-in address; with Google sign-in it must be their Google address');

  // Sign-in way and groups: pressed buttons, the pressed state is the value.
  function choices(label, cls, items, multi, initial) {
    var row = div('person-row ' + cls);
    row.appendChild(div('person-lab', label));
    var on = multi ? initial.slice() : initial;
    var btns = items.map(function (it) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ts-t person-choice'; b.textContent = it[1]; b.title = it[2];
      b.dataset.value = it[0];
      b.addEventListener('click', function () {
        if (multi) {
          var i = on.indexOf(it[0]);
          if (i >= 0) { on.splice(i, 1); } else { on.push(it[0]); }
        } else { on = it[0]; }
        paint(); changed();
      });
      row.appendChild(b);
      return b;
    });
    function paint() {
      btns.forEach(function (b) {
        b.setAttribute('aria-pressed', String(multi ? on.indexOf(b.dataset.value) >= 0 : on === b.dataset.value));
      });
    }
    paint();
    box.appendChild(row);
    return { value: function () { return multi ? on.slice() : on; } };
  }
  var signin = choices('Signs in with', 'person-signin', [
    ['google', 'Google', 'Nothing to send: Google sign-in links them by their email address'],
    ['link', 'Set-password link', "A one-time link they use to choose their own password (needs Authentik's recovery flow)"],
    ['password', 'Starting password', 'nav makes one and shows it once; give it to them and they change it']], false, 'google');
  var managed = (view.groups || []).filter(function (g) { return g.managed; });
  var groups = choices('Groups', 'person-groups', managed.map(function (g) {
    return [g.name, g.name, 'Staged: joins ' + g.name + ' in the next pull request (' + g.path + ')'];
  }), true, ap.groups || []);

  var edge = div('note person-edge');
  box.appendChild(edge);
  var err = div('note person-err');
  box.appendChild(err);
  var foot = div('smalldlg-foot');
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.id = 'person-cancel';
  cancel.addEventListener('click', function () { close(); });
  var create = document.createElement('button');
  create.type = 'button'; create.textContent = 'Create'; create.id = 'person-create'; create.className = 'primary';
  create.disabled = true;
  foot.appendChild(cancel); foot.appendChild(create);
  box.appendChild(foot);

  var USER = /^[a-z0-9][a-z0-9._-]{1,62}$/, MAIL = /^[^@\s"<>,;]+@[^@\s"<>,;]+\.[^@\s"<>,;]+$/;
  function setStatus(f, kind, title) {
    f.status.innerHTML = '';
    if (kind) { f.status.appendChild(personInd(kind, title)); }
  }
  function valid() {
    return USER.test(fUser.input.value.trim()) && fName.input.value.trim() && MAIL.test(fEmail.input.value.trim()) &&
           checked.taken.length === 0 && checked.for === key();
  }
  function key() { return fUser.input.value.trim() + '\u0000' + fEmail.input.value.trim(); }
  function paintEdge() {
    edge.innerHTML = '';
    if (checked.outside !== true) { return; }
    var staged = ap.outside_access;
    edge.appendChild(personInd(staged ? 'info' : 'warn', staged
      ? 'Outside the household domain: the address is added to the outside-access allow-list in the same pull request'
      : 'Outside the household domain, and nav does not edit the outside-access allow-list: add ' +
        fEmail.input.value.trim() + ' there by hand' + (ap.outside_file ? ' (' + ap.outside_file + ')' : '')));
    edge.appendChild(document.createTextNode(staged ? ' Outside access: staged with the groups' : ' Outside access: by hand'));
  }
  function paint() {
    var u = fUser.input.value.trim(), e = fEmail.input.value.trim();
    setStatus(fUser, u ? (!USER.test(u) ? 'bad' : checked.for === key() && checked.taken.indexOf('username') >= 0 ? 'bad' : null) : null,
              !USER.test(u) ? 'Lowercase letters, digits, ., _ or -, 2 to 63 characters' : 'Already in Authentik');
    setStatus(fEmail, e ? (!MAIL.test(e) ? 'bad' : checked.for === key() && checked.taken.indexOf('email') >= 0 ? 'bad' : null) : null,
              !MAIL.test(e) ? 'Not an email address' : 'Already in Authentik');
    paintEdge();
    create.disabled = !valid();
  }
  function changed() {
    dirty = !!(fUser.input.value || fName.input.value || fEmail.input.value);
    h.setDirty(dirty);
    clearTimeout(checkTimer);
    var u = fUser.input.value.trim(), e = fEmail.input.value.trim();
    if (USER.test(u) || MAIL.test(e)) {
      var k = key();
      checkTimer = setTimeout(function () {
        connSend('POST', 'api/admin/access/people/check', { username: USER.test(u) ? u : '', email: MAIL.test(e) ? e : '' })
          .then(function (r) { if (k === key()) { checked = { taken: r.taken || [], outside: r.outside, for: k }; paint(); } })
          .catch(function (x) { err.textContent = x.message; });
      }, 300);
    }
    paint();
  }
  [fUser, fName, fEmail].forEach(function (f) { f.input.addEventListener('input', changed); });
  fUser.input.focus();

  create.addEventListener('click', function () {
    if (!valid()) { return; }
    create.disabled = true; cancel.disabled = true;
    err.textContent = 'Creating…';
    connSend('POST', 'api/admin/access/people', {
      username: fUser.input.value.trim(), name: fName.input.value.trim(), email: fEmail.input.value.trim(),
      signin: signin.value(), groups: groups.value()
    }).then(function (r) { created = r; h.setDirty(false); result(r); })
      .catch(function (x) { err.textContent = x.message; cancel.disabled = false; paint(); });
  });

  function result(r) {
    box.innerHTML = '';
    var hd = document.createElement('strong');
    hd.textContent = 'Added ' + r.name;
    box.appendChild(hd);
    function line(kind, title, text) {
      var l = div('person-line');
      l.appendChild(personInd(kind, title));
      l.appendChild(document.createTextNode(' ' + text));
      box.appendChild(l);
      return l;
    }
    line('ok', 'Created in Authentik as user ' + r.pk + ': active, internal', 'Authentik user ' + r.username + ' (' + r.pk + ')');
    var si = r.signin || {};
    if (si.error) {
      line('warn', 'The user exists, but setting up sign-in failed: ' + si.error, 'Sign-in: set it up in Authentik');
    } else if (si.way === 'google') {
      line('ok', 'Nothing to send: Google sign-in links them by ' + r.email, 'Signs in with Google');
    } else {
      var l = line('ok', si.way === 'link' ? 'A one-time link: they choose their own password'
                                           : 'Shown once: give it to them out of band; they change it',
                   si.way === 'link' ? 'Set-password link:' : 'Starting password:');
      var code = document.createElement('code');
      code.className = 'person-secret'; code.id = 'person-secret';
      code.textContent = si.link || si.password;
      l.appendChild(document.createTextNode(' '));
      l.appendChild(code);
      var copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'linkish'; copy.textContent = 'Copy';
      copy.addEventListener('click', function () {
        if (navigator.clipboard) { navigator.clipboard.writeText(code.textContent).then(function () { copy.textContent = 'Copied'; }); }
      });
      l.appendChild(document.createTextNode(' '));
      l.appendChild(copy);
    }
    if (r.groups.length) {
      line('info', 'Staged, not applied: they join when the pull request is merged and applied', 'Groups staged: ' + r.groups.join(', '));
    } else {
      line('warn', 'No groups: they can sign in but reach nothing until they get a group or a direct binding', 'No groups');
    }
    var e = r.edge || {};
    if (e.outside) {
      var t = { staged: ['info', 'Staged: ' + r.email + ' joins the outside-access allow-list in the same pull request', 'Outside access staged'],
                already: ['ok', r.email + ' is already on the outside-access allow-list', 'Outside access: already allowed'],
                manual: ['warn', 'nav did not edit the outside-access allow-list: add ' + r.email + ' by hand' +
                         (e.file ? ' (' + e.file + ')' : ''), 'Outside access: add by hand'] }[e.status] ||
              ['warn', 'Outside access: unknown', 'Outside access: check'];
      line(t[0], t[1], t[2]);
    }
    box.appendChild(div('note person-next', 'Next: Open PR, then merge it and run terraform apply.'));
    var f = div('smalldlg-foot');
    var ok = document.createElement('button');
    ok.type = 'button'; ok.textContent = 'Done'; ok.id = 'person-done'; ok.className = 'primary';
    ok.addEventListener('click', function () { close(true); });
    f.appendChild(ok);
    box.appendChild(f);
  }
}
