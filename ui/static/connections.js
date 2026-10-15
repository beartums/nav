// connections.js -- where nav's widgets reach each app, and with which key.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after editor.js, whose dialog it reuses. Admin only; the server half is
// /api/admin/connections (api/creds.py).
//
// A key goes IN and never comes back: the server answers whether one is set
// and its last four characters. So the key box is always empty -- blank means
// "keep what is there", and removing one is its own button.
'use strict';

function connSend(method, path, body) {
  return fetch(path, {
    method: method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (b) {
      if (!r.ok) {
        throw new Error((typeof b.detail === 'string' && b.detail) || method + ' failed: ' + r.status);
      }
      return b;
    });
  });
}

var CONN_KEY_WORDS = {
  stored: function (c) { return 'Key stored ' + (c.hint || ''); },
  env: function () { return 'Key from the server’s environment'; },
  none: function () { return 'No key'; },
  unreadable: function () { return 'Stored key cannot be decrypted (the master key changed) — enter it again'; }
};

function connectionsDialog() {
  EDITING = '__connections__';
  PASTE_TARGET = null;
  document.getElementById('editor-title').textContent = 'Connections';
  var note = document.getElementById('editor-note');
  note.textContent = 'Loading…';
  editorBody.innerHTML = '';
  editor.classList.add('wide');
  var rows = [];

  function row(c, canStore) {
    var box = document.createElement('fieldset');
    box.className = 'conn';
    box.dataset.slug = c.slug;
    var legend = document.createElement('legend');
    legend.textContent = c.label;
    box.appendChild(legend);
    var state = div('note conn-state' + (c.key === 'unreadable' ? ' conn-bad' : ''), CONN_KEY_WORDS[c.key](c));
    box.appendChild(state);
    var url = field(c.custom ? 'Base URL (its key is sent only under this)' : 'Address nav uses',
                    c.url_set ? c.url : '', c.default_url);
    var pub = field('Link address for people', c.public_set ? c.public_url : '', c.public_url);
    var auth = null;
    if (c.custom) {
      legend.textContent = c.label + ' (' + c.slug + ')';
      auth = field('Sent as', c.auth, 'bearer, x-api-key, or header:<Name>');
    }
    var key = field('API key', '', canStore ? (c.key === 'none' ? 'paste a key' : 'leave blank to keep') : 'needs NAV_SECRET_KEY');
    key.input.type = 'password';
    key.input.autocomplete = 'off';
    key.input.disabled = !canStore;
    [url, pub, auth, key].forEach(function (f) { if (f) { box.appendChild(f.label); } });
    var bar = div('conn-actions');
    var test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test';
    var out = div('note conn-test');
    test.addEventListener('click', function () {
      out.textContent = 'Testing saved settings…';
      connSend('POST', 'api/admin/connections/' + c.slug + '/test').then(function (r) {
        out.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail;
        out.classList.toggle('conn-bad', !r.ok);
      }).catch(function (e) { out.textContent = e.message; });
    });
    bar.appendChild(test);
    var removing = false;
    if (c.key === 'stored' || c.key === 'unreadable') {
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'danger';
      rm.textContent = 'Remove key';
      rm.addEventListener('click', function () {
        removing = !removing;
        rm.textContent = removing ? 'Keep key' : 'Remove key';
        state.textContent = removing ? 'Key will be removed on Save' : CONN_KEY_WORDS[c.key](c);
      });
      bar.appendChild(rm);
    }
    if (c.custom) {
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Delete connection';
      del.addEventListener('click', function () {
        if (!confirm('Delete the \u201c' + c.label + '\u201d connection and its key? Remote widgets ' +
                     'that name it will show an error.')) { return; }
        connSend('DELETE', 'api/admin/connections/' + c.slug)
          .then(load).catch(function (e) { note.textContent = e.message; });
      });
      bar.appendChild(del);
    }
    bar.appendChild(out);
    box.appendChild(bar);
    rows.push({
      slug: c.slug,
      // Only what changed: a field left out is unchanged on the server.
      body: function () {
        var b = {};
        var u = url.input.value.trim(), p = pub.input.value.trim(), k = key.input.value.trim();
        if (u !== (c.url_set ? c.url : '')) { b.url = u; }
        if (p !== (c.public_set ? c.public_url : '')) { b.public_url = p; }
        if (auth && auth.input.value.trim() !== c.auth) { b.auth = auth.input.value.trim(); }
        if (k) { b.key = k; } else if (removing) { b.key = ''; }
        return b;
      }
    });
    return box;
  }

  // A custom connection, for remote widgets (docs/widgets.md). Created at
  // once, not on Save: it needs a name before anything can refer to it.
  function addForm(canStore) {
    var box = document.createElement('details');
    box.className = 'conn-add';
    var sum = document.createElement('summary');
    sum.textContent = 'Add a connection for a remote widget';
    box.appendChild(sum);
    var f = {
      slug: field('Name', '', 'lower-case, e.g. printer'),
      label: field('Label', '', 'shown here'),
      url: field('Base URL', '', 'https://service.lan/api'),
      auth: field('Sent as', 'bearer', 'bearer, x-api-key, or header:<Name>'),
      key: field('Key', '', canStore ? 'optional' : 'needs NAV_SECRET_KEY')
    };
    f.key.input.type = 'password';
    f.key.input.autocomplete = 'off';
    f.key.input.disabled = !canStore;
    Object.keys(f).forEach(function (k) { box.appendChild(f[k].label); });
    var add = document.createElement('button');
    add.type = 'button';
    add.id = 'conn-add-btn';
    add.textContent = 'Add';
    add.addEventListener('click', function () {
      var body = {};
      Object.keys(f).forEach(function (k) { var v = f[k].input.value.trim(); if (v) { body[k] = v; } });
      connSend('POST', 'api/admin/connections', body)
        .then(function () { return load().then(function () { note.textContent = 'Added.'; }); })
        .catch(function (e) { note.textContent = e.message; });
    });
    box.appendChild(add);
    return box;
  }

  function load() {
    rows = [];
    return connSend('GET', 'api/admin/connections').then(function (b) {
      editorBody.innerHTML = '';
      note.textContent = '';
      var intro = div('note', b.can_store
        ? 'Widgets use these to reach each app. Keys are encrypted in nav’s database and never shown again.'
        : 'Keys cannot be stored: nav-api has no NAV_SECRET_KEY. Addresses can still be set; keys can come from the server’s environment.');
      editorBody.appendChild(intro);
      b.connections.forEach(function (c) { editorBody.appendChild(row(c, b.can_store)); });
      editorBody.appendChild(addForm(b.can_store));
    });
  }

  document.getElementById('editor-save').textContent = 'Save';
  document.getElementById('editor-save').onclick = function () {
    var todo = rows.map(function (r) { return { slug: r.slug, body: r.body() }; })
      .filter(function (r) { return Object.keys(r.body).length; });
    if (!todo.length) { closeEditor(); return; }
    note.textContent = 'Saving…';
    // One at a time, so the message names the connection that was refused.
    todo.reduce(function (p, r) {
      return p.then(function () {
        return connSend('PUT', 'api/admin/connections/' + r.slug, r.body).catch(function (e) {
          throw new Error(r.slug + ': ' + e.message);
        });
      });
    }, Promise.resolve()).then(function () {
      return load().then(function () { note.textContent = 'Saved. Use Test to check each one.'; });
    }).catch(function (e) { note.textContent = e.message; });
  };

  load().catch(function (e) { note.textContent = 'Could not load connections: ' + e.message; });
  document.body.classList.add('editing');
  editor.style.left = Math.max(12, innerWidth / 2 - 280) + 'px';
  editor.style.top = '70px';
}
document.getElementById('admin-connections-btn').addEventListener('click', connectionsDialog);
