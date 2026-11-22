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
  var mode = pref.mode === 'apps' ? 'apps' : 'groups', pivot = !!pref.pivot, apps = null;
  function savePref() {
    try { localStorage.setItem(PREF, JSON.stringify({ mode: mode, pivot: pivot })); } catch (e) {}
  }

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
        (c.login ? ' · ' + c.login : '') + (c.status === 'stale' ? ' (' + c.role + (c.disabled ? ', disabled' : '') + ')' : '') +
        (c.last_seen ? ' · last seen ' + new Date(c.last_seen).toLocaleString() : '')));
    }
    return td;
  }
  function appHead(a, tag) {
    var th = document.createElement(tag || 'th');
    th.textContent = a.label;
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
        (a.provision === 'first' ? ' · accounts are made at first sign-in' : ' · an admin makes the accounts');
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
    flip.addEventListener('click', function () { pivot = !pivot; savePref(); render(); });
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

  function loadApps(fresh) {
    return connSend('GET', 'api/admin/access/apps' + (fresh ? '?fresh=1' : ''))
      .then(function (v) { apps = v; note.textContent = ''; render(); })
      .catch(function (e) { note.textContent = 'Could not read the apps: ' + e.message; });
  }

  function render() {
    h.body.innerHTML = '';
    switcher();
    if (mode === 'apps') { renderApps(); return; }
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
    var n = (view.pending || []).length;
    if (n) {
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.id = 'acc-clear';
      clear.textContent = 'Clear ' + n + ' staged change' + (n === 1 ? '' : 's');
      clear.addEventListener('click', function () {
        connSend('DELETE', 'api/admin/access/changes').then(function (r) { view.pending = r.pending; load(); })
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
  load().then(function () { if (mode === 'apps') { note.textContent = 'Reading each app…'; return loadApps(false); } })
    .catch(function (e) { note.textContent = 'Could not load access: ' + e.message; });
}
