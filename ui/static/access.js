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
  var mode = 'groups', apps = null;
  function switcher() {
    var sw = div('acc-switch');
    [['groups', 'Groups'], ['apps', 'App accounts']].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = m[1]; b.dataset.view = m[0];
      b.setAttribute('aria-pressed', String(mode === m[0]));
      b.addEventListener('click', function () {
        if (mode === m[0]) { return; }
        mode = m[0];
        if (mode === 'apps' && !apps) { note.textContent = 'Reading each app…'; loadApps(false); } else { render(); }
      });
      sw.appendChild(b);
    });
    h.body.appendChild(sw);
  }

  function renderApps() {
    save.hidden = true;
    note.textContent = '';
    var intro = div('note', "Each app's own accounts, read from the app with its key in Connections, matched to " +
      'Authentik people by email, then username. Read-only. Up to a minute old. ');
    var again = document.createElement('button');
    again.type = 'button'; again.className = 'linkish'; again.textContent = 'Refresh';
    again.addEventListener('click', function () { note.textContent = 'Reading each app…'; loadApps(true); });
    intro.appendChild(again);
    h.body.appendChild(intro);
    var t = document.createElement('table');
    t.className = 'acc-table acc-apps-table';
    var hr = document.createElement('tr');
    var th0 = document.createElement('th'); th0.textContent = 'Person'; hr.appendChild(th0);
    apps.apps.forEach(function (a) {
      var th = document.createElement('th');
      th.textContent = a.label;
      if (a.error) {
        th.className = 'acc-app-err';
        th.appendChild(div('acc-err', '\u26a0 ' + a.error));
      } else {
        th.title = a.count + ' account(s) · Authentik app: ' + a.apps.join(', ') +
          (a.provision === 'first' ? ' · accounts are made at first sign-in' : ' · an admin makes the accounts');
      }
      hr.appendChild(th);
    });
    t.appendChild(document.createElement('thead')).appendChild(hr);
    var tb = document.createElement('tbody');
    apps.people.forEach(function (p) {
      var tr = document.createElement('tr');
      var who = document.createElement('td');
      who.className = 'acc-who';
      who.textContent = p.name;
      who.appendChild(div('note', p.email || ''));
      tr.appendChild(who);
      apps.apps.forEach(function (a) {
        var td = document.createElement('td');
        var c = p.cells[a.key];
        if (a.error) { td.className = 'acc-na'; }
        else if (!c) { td.textContent = ''; }
        else if (c.status === 'missing') {
          td.className = c.provision === 'first' ? 'acc-notyet' : 'acc-missing';
          td.textContent = c.provision === 'first' ? 'not signed in' : 'no account';
          td.title = c.provision === 'first'
            ? 'Authentik lets them open ' + a.label + '; the account appears at their first sign-in'
            : 'Authentik lets them open ' + a.label + ', but nobody has made them an account';
        } else {
          td.className = c.status === 'stale' ? 'acc-stale' : (c.role === 'admin' ? 'acc-admin' : 'acc-user');
          td.textContent = (c.status === 'stale' ? '\u26a0 ' : '') + c.role + (c.disabled ? ' (disabled)' : '');
          td.title = (c.login ? 'Account: ' + c.login : 'Account') +
            (c.last_seen ? ' · last seen ' + c.last_seen : '') +
            (c.status === 'stale' ? ' · Authentik no longer lets them open ' + a.label + ': a leftover account' : '');
          if (c.disabled) { td.classList.add('acc-disabled'); }
        }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
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
    var intro = div('note', 'Membership as it is on ' + view.repo + ' ' + view.base +
      '. Click a cell to stage a change; Open PR puts every staged change into one pull request. ' +
      'Nothing changes until it is merged and applied. Apps are as Authentik had them up to a minute ago. ');
    var again = document.createElement('button');
    again.type = 'button'; again.id = 'acc-refresh'; again.className = 'linkish';
    again.textContent = 'Refresh';
    again.title = 'Read Authentik and the repo again now';
    again.addEventListener('click', function () { note.textContent = 'Reading…'; load(true).then(function () { note.textContent = 'Up to date.'; }); });
    intro.appendChild(again);
    h.body.appendChild(intro);
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
      return load().then(function () {
        note.textContent = '';
        var a = document.createElement('a');
        a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Pull request opened';
        note.appendChild(a);
      });
    }).catch(function (e) { note.textContent = e.message; save.disabled = false; });
  };

  load().catch(function (e) { note.textContent = 'Could not load access: ' + e.message; });
}
