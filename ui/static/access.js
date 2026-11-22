// access.js -- who is in which group, staged as a pull request.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Reuses
// the editor dialog, like connections.js. Server half: /api/admin/access
// (api/access.py). Nothing here changes access directly: a click stages a
// membership change, "Open PR" turns every staged change into one pull request
// on the GitOps repo, and access changes when that is merged and applied.
'use strict';

function accessDialog() {
  EDITING = '__access__';
  PASTE_TARGET = null;
  document.getElementById('editor-title').textContent = 'Access';
  var note = document.getElementById('editor-note');
  var save = document.getElementById('editor-save');
  note.textContent = 'Loading…';
  editorBody.innerHTML = '';
  editor.classList.add('wide', 'acc-wide');
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

  function render() {
    editorBody.innerHTML = '';
    if (!view.enabled) {
      editorBody.appendChild(div('note', 'The Access panel is off: nav-api needs NAV_GITOPS_REPO and NAV_GITOPS_TOKEN.'));
      save.disabled = true;
      return;
    }
    editorBody.appendChild(div('note', 'Membership as it is on ' + view.repo + ' ' + view.base +
      '. Click a cell to stage a change; Open PR puts every staged change into one pull request. ' +
      'Nothing changes until it is merged and applied.'));
    if (view.last_pr) {
      var last = div('note');
      last.appendChild(document.createTextNode('Last pull request: '));
      var a = document.createElement('a');
      a.href = view.last_pr.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = view.last_pr.url.replace(/^https:\/\/github\.com\//, '');
      last.appendChild(a);
      editorBody.appendChild(last);
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
    editorBody.appendChild(t);
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
      editorBody.appendChild(clear);
    }
    save.disabled = !n;
    save.textContent = n ? 'Open PR (' + n + ')' : 'Open PR';
    note.textContent = n ? n + ' staged' : '';
  }

  editorBody.addEventListener('click', function onCell(e) {
    if (EDITING !== '__access__') { editorBody.removeEventListener('click', onCell); return; }
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

  function load() {
    return connSend('GET', 'api/admin/access').then(function (v) { view = v; render(); });
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
  document.body.classList.add('editing');
  editor.style.left = Math.max(12, innerWidth / 2 - 380) + 'px';
  editor.style.top = '60px';
}
document.getElementById('admin-access-btn').addEventListener('click', accessDialog);
