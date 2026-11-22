// connections.js -- where nav's widgets reach each app, and with which key.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). The
// Connections tab of admin mode (admin-pages.js draws the page around it).
// The server half is /api/admin/connections (api/creds.py).
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

function connectionsPage(h) {
  var note = h.note;
  note.textContent = 'Loading…';
  h.body.innerHTML = '';
  var rows = [];

  // Save only when something differs from what is stored; leaving with a
  // difference asks first (admin-pages.js setDirty).
  function changed() {
    var dirty = rows.some(function (r) { return Object.keys(r.body()).length; });
    h.save.disabled = !dirty;
    h.setDirty(dirty);
  }

  function row(c, canStore) {
    var box = document.createElement('fieldset');
    box.className = 'conn';
    box.dataset.slug = c.slug;
    var legend = document.createElement('legend');
    legend.textContent = c.label;
    box.appendChild(legend);
    var state = div('note conn-state' + (c.key === 'unreadable' ? ' conn-bad' : ''), CONN_KEY_WORDS[c.key](c));
    box.appendChild(state);
    // What the key must be, for an app read for its accounts (Access → App accounts).
    if (c.note) { box.appendChild(div('note conn-need', 'Key: ' + c.note)); }
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
    // Say which address is in use: a grey placeholder read as "none".
    if (!c.custom) {
      var used = div('note conn-default');
      var showUsed = function () {
        var v = url.input.value.trim();
        used.textContent = v ? '' : c.default_url ? 'Using the default: ' + c.default_url
                                                  : 'No default address: enter the one nav should use.';
        used.classList.toggle('conn-bad', !v && !c.default_url);
      };
      url.input.addEventListener('input', showUsed);
      showUsed();
      url.label.after(used);
    }
    var bar = div('conn-actions');
    var test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Test';
    var out = div('note conn-test');
    // Tests what is in the boxes now, saved or not; a blank box means the saved value.
    test.addEventListener('click', function () {
      var tb = {};
      var u = url.input.value.trim(), k = key.input.value.trim();
      if (u) { tb.url = u; }
      if (k) { tb.key = k; }
      if (auth && auth.input.value.trim()) { tb.auth = auth.input.value.trim(); }
      out.textContent = Object.keys(tb).length ? 'Testing what is entered…' : 'Testing saved settings…';
      connSend('POST', 'api/admin/connections/' + c.slug + '/test', tb).then(function (r) {
        out.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail;
        out.classList.toggle('conn-bad', !r.ok);
        // It works: keep this connection's changes now (only this one's --
        // other connections' edits stay unsaved until Save).
        var b = me.body();
        if (!r.ok || !Object.keys(b).length) { return; }
        return connSend('PUT', 'api/admin/connections/' + c.slug, b).then(function () {
          if ('url' in b) { c.url_set = !!b.url; if (b.url) { c.url = b.url; } }
          if ('public_url' in b) { c.public_set = !!b.public_url; if (b.public_url) { c.public_url = b.public_url; } }
          if ('auth' in b) { c.auth = b.auth; }
          if ('key' in b) { c.key = b.key ? 'stored' : 'none'; c.hint = b.key ? '\u2026' + b.key.slice(-4) : null; key.input.value = ''; removing = false; }
          if (rm) { rm.textContent = 'Remove key'; }
          state.textContent = CONN_KEY_WORDS[c.key](c);
          out.textContent += ' \u2014 saved';
          changed();
        });
      }).catch(function (e) { out.textContent = e.message; out.classList.add('conn-bad'); });
    });
    bar.appendChild(test);
    var removing = false, rm = null, me = null;
    if (c.key === 'stored' || c.key === 'unreadable') {
      rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'danger';
      rm.textContent = 'Remove key';
      rm.addEventListener('click', function () {
        removing = !removing;
        rm.textContent = removing ? 'Keep key' : 'Remove key';
        state.textContent = removing ? 'Key will be removed on Save' : CONN_KEY_WORDS[c.key](c);
        changed();
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
    box.addEventListener('input', changed);
    rows.push(me = {
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
      h.body.innerHTML = '';
      note.textContent = '';
      h.save.disabled = true;
      h.setDirty(false);
      var intro = div('note', b.can_store
        ? 'Widgets use these to reach each app. Keys are encrypted in nav’s database and never shown again.'
        : 'Keys cannot be stored: nav-api has no NAV_SECRET_KEY. Addresses can still be set; keys can come from the server’s environment.');
      h.body.appendChild(intro);
      b.connections.forEach(function (c) { h.body.appendChild(row(c, b.can_store)); });
      h.body.appendChild(addForm(b.can_store));
    });
  }

  h.save.textContent = 'Save';
  h.save.disabled = true;
  h.save.onclick = function () {
    var todo = rows.map(function (r) { return { slug: r.slug, body: r.body() }; })
      .filter(function (r) { return Object.keys(r.body).length; });
    if (!todo.length) { note.textContent = 'Nothing changed.'; return; }
    note.textContent = 'Saving…';
    // One at a time, so the message names the connection that was refused.
    todo.reduce(function (p, r) {
      return p.then(function () {
        return connSend('PUT', 'api/admin/connections/' + r.slug, r.body).catch(function (e) {
          throw new Error(r.slug + ': ' + e.message);
        });
      });
    }, Promise.resolve()).then(function () {
      return load().then(function () { h.setDirty(false); h.save.disabled = true; note.textContent = 'Saved.'; });
    }).catch(function (e) { note.textContent = e.message; });
  };

  load().catch(function (e) { note.textContent = 'Could not load connections: ' + e.message; });
}
