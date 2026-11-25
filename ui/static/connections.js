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

// Two pages over the same connections (admin-pages.js): `integrations`, what
// widgets use (plus custom ones for remote widgets), and `users`, the apps
// read for their accounts. One read for both (Seerr, Mealie, choreboard) is on
// both pages: the same key, so a change on either is the change.
function connectionsPage(h, which) {
  which = which || 'integrations';
  var note = h.note;
  note.textContent = 'Loading…';
  h.body.innerHTML = '';
  var rows = [];

  // Save only when something differs from what is stored; leaving with a
  // difference asks first (admin-pages.js setDirty).
  function changed() {
    var dirty = false;
    rows.forEach(function (r) {
      var d = Object.keys(r.body()).length > 0;
      if (items[r.slug]) { items[r.slug].dirty(d); }
      dirty = dirty || d;
    });
    h.save.disabled = !dirty;
    h.setDirty(dirty);
  }

  // --- the sidebar: every connection's state at a glance; its card on click.
  // Cards stay built (hidden) when another is chosen, so unsaved edits of one
  // survive looking at another; the sidebar marks the ones with edits.
  var items = {}, cards = {}, order = [], sel = null, md = null;
  var NEW = '_new';     // the Add form's place in the URL (no slug starts with "_")
  function narrow() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 700px)').matches);
  }
  function sideItem(slug, label) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'conn-item';
    b.dataset.slug = slug;
    var name = document.createElement('span');
    name.className = 'conn-item-name';
    name.textContent = label;
    var key = document.createElement('span');
    key.className = 'conn-ind';
    key.setAttribute('role', 'img');
    var dot = document.createElement('span');
    dot.className = 'conn-dot';
    dot.setAttribute('role', 'img');
    dot.hidden = true;
    var dirty = document.createElement('span');
    dirty.className = 'conn-dirty';
    dirty.textContent = '\u25cf';
    dirty.title = 'Unsaved changes';
    dirty.setAttribute('role', 'img');
    dirty.setAttribute('aria-label', dirty.title);
    dirty.hidden = true;
    b.appendChild(key); b.appendChild(name); b.appendChild(dirty); b.appendChild(dot);
    b.addEventListener('click', function () { select(slug, true); });
    li.appendChild(b);
    return {
      li: li, button: b,
      paintKey: function (c) {
        var words = CONN_KEY_WORDS[c.key](c);
        key.className = 'conn-ind conn-key-' + c.key;
        key.textContent = c.key === 'stored' || c.key === 'env' ? '\u2713' : c.key === 'unreadable' ? '\u2715' : '\u25cb';
        key.title = words;
        key.setAttribute('aria-label', words);
      },
      paintHealth: function (hl) {
        b.classList.toggle('conn-healthy', hl.tries > 0 && hl.errors === 0);
        dot.hidden = !hl.errors;
        dot.title = hl.errors ? hl.errors + ' of the last ' + hl.tries + ' tries failed. Latest: ' + hl.last_error.detail
          : '';
        dot.setAttribute('aria-label', dot.title);
        b.title = hl.tries && !hl.errors ? 'The last ' + hl.tries + ' tries worked' : '';
      },
      dirty: function (on) { dirty.hidden = !on; }
    };
  }
  /** Show one connection's card (null: the list alone, on a narrow screen). */
  function select(slug, push) {
    if (slug != null && !cards[slug]) { slug = null; }
    if (slug == null && !narrow()) { slug = order[0] || null; }
    sel = slug;
    Object.keys(cards).forEach(function (k) { cards[k].hidden = k !== slug; });
    Object.keys(items).forEach(function (k) { items[k].button.setAttribute('aria-current', String(k === slug)); });
    if (md) { md.classList.toggle('conn-has-sel', !!slug); }
    urlPage({ conn: slug }, push);
  }
  // Back/Forward between connections: move, don't rebuild (edits stay).
  h.onURL = function (w) { select(w.conn || null, false); };

  function row(c, canStore, item) {
    var box = document.createElement('fieldset');
    box.className = 'conn';
    box.dataset.slug = c.slug;
    var legend = document.createElement('legend');
    legend.textContent = c.label;
    box.appendChild(legend);
    var state = div('conn-state', '');
    // The key as a badge: green when one is set, grey when not, red when it no longer opens.
    function paintKey() {
      state.className = 'conn-state conn-key-' + c.key;
      state.textContent = (c.key === 'stored' ? '\u2713 ' : c.key === 'unreadable' ? '\u2715 ' : '') + CONN_KEY_WORDS[c.key](c);
      if (item) { item.paintKey(c); }
    }
    paintKey();
    box.appendChild(state);
    // How it has been doing (nav-api remembers the last few uses): a green
    // border when they all worked, a red dot when any failed lately.
    var dot = document.createElement('span');
    dot.className = 'conn-dot';
    legend.appendChild(dot);
    function paintHealth(hl) {
      hl = hl || { tries: 0, errors: 0 };
      box.classList.toggle('conn-healthy', hl.tries > 0 && hl.errors === 0);
      dot.hidden = !hl.errors;
      dot.title = hl.errors ? hl.errors + ' of the last ' + hl.tries + ' tries failed. Latest: ' +
        hl.last_error.detail + ' (' + new Date(hl.last_error.at * 1000).toLocaleString() + ')' : '';
      dot.setAttribute('aria-label', dot.title);
      box.title = hl.tries && !hl.errors ? 'The last ' + hl.tries + ' tries worked' : '';
      if (item) { item.paintHealth(hl); }
    }
    paintHealth(c.health);
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
    var keep = canStore ? (c.key === 'none' ? '' : 'leave blank to keep') : 'needs NAV_SECRET_KEY';
    // An app with no API keys (Navidrome, AFFiNE, Pingvin): an admin's login and
    // password, stored together as the key "<login>:<password>".
    var who = null, key;
    if (c.login) {
      who = field(c.login === 'email' ? 'Admin email' : 'Admin username', '', keep || c.login);
      who.input.autocomplete = 'off';
      who.input.disabled = !canStore;
      key = field('Password', '', keep || 'their password');
    } else {
      key = field('API key', '', keep || 'paste a key');
    }
    key.input.type = 'password';
    key.input.autocomplete = 'off';
    key.input.disabled = !canStore;
    pwShow(key.input);
    [url, pub, auth, who, key].forEach(function (f) { if (f) { box.appendChild(f.label); } });
    // The key as typed: '' when nothing (or only half a login) is entered.
    function typedKey() {
      var k = key.input.value.trim();
      if (!who) { return k; }
      var w = who.input.value.trim();
      return w && k ? w + ':' + key.input.value : '';
    }
    function halfLogin() { return !!who && !!who.input.value.trim() !== !!key.input.value.trim(); }
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
      var u = url.input.value.trim(), k = typedKey();
      if (halfLogin()) { out.textContent = '✗ enter both the login and the password'; out.classList.add('conn-bad'); return; }
      if (u) { tb.url = u; }
      if (k) { tb.key = k; }
      if (auth && auth.input.value.trim()) { tb.auth = auth.input.value.trim(); }
      out.textContent = Object.keys(tb).length ? 'Testing what is entered…' : 'Testing saved settings…';
      connSend('POST', 'api/admin/connections/' + c.slug + '/test', tb).then(function (r) {
        out.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail;
        out.classList.toggle('conn-bad', !r.ok);
        // A test of what is saved counts as a try: repaint from the server's tally.
        connSend('GET', 'api/admin/connections').then(function (all) {
          var mine = (all.connections || []).filter(function (x) { return x.slug === c.slug; })[0];
          if (mine) { paintHealth(mine.health); }
        }).catch(function () {});
        // It works: keep this connection's changes now (only this one's --
        // other connections' edits stay unsaved until Save).
        var b = me.body();
        if (!r.ok || !Object.keys(b).length) { return; }
        return connSend('PUT', 'api/admin/connections/' + c.slug, b).then(function () {
          if ('url' in b) { c.url_set = !!b.url; if (b.url) { c.url = b.url; } }
          if ('public_url' in b) { c.public_set = !!b.public_url; if (b.public_url) { c.public_url = b.public_url; } }
          if ('auth' in b) { c.auth = b.auth; }
          if ('key' in b) { c.key = b.key ? 'stored' : 'none'; c.hint = !b.key ? null : who ? 'as ' + b.key.split(':')[0] : '\u2026' + b.key.slice(-4); key.input.value = ''; if (who) { who.input.value = ''; } removing = false; }
          if (rm) { rm.textContent = 'Remove key'; }
          paintKey();
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
        if (removing) { state.textContent = 'Key will be removed on Save'; state.className = 'conn-state'; } else { paintKey(); }
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
        var u = url.input.value.trim(), p = pub.input.value.trim(), k = typedKey();
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
    var box = document.createElement('fieldset');
    box.className = 'conn-add';
    var sum = document.createElement('legend');
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
    pwShow(f.key.input);
    Object.keys(f).forEach(function (k) { box.appendChild(f[k].label); });
    var add = document.createElement('button');
    add.type = 'button';
    add.id = 'conn-add-btn';
    add.textContent = 'Add';
    add.addEventListener('click', function () {
      var body = {};
      Object.keys(f).forEach(function (k) { var v = f[k].input.value.trim(); if (v) { body[k] = v; } });
      connSend('POST', 'api/admin/connections', body)
        .then(function () {
          sel = body.slug || sel;
          return load().then(function () { note.textContent = 'Added.'; });
        })
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
      var intro = div('note', !b.can_store
        ? 'Keys cannot be stored: nav-api has no NAV_SECRET_KEY. Addresses can still be set; keys can come from the server’s environment.'
        : which === 'users'
          ? 'Apps read for their accounts (Access → App accounts). Most keys must belong to an admin; each says what it needs. ' +
            'Test checks what is typed and, when it works, keeps it. Keys are encrypted and never shown again.'
          : 'Widgets use these to reach each app. Test checks what is typed and, when it works, keeps it. ' +
            'Keys are encrypted in nav’s database and never shown again.');
      h.body.appendChild(intro);
      items = {}; cards = {}; order = [];
      md = div('conn-md');
      var side = document.createElement('nav');
      side.className = 'conn-side';
      side.setAttribute('aria-label', 'Connections');
      var list = document.createElement('ul');
      list.className = 'conn-list';
      side.appendChild(list);
      var detail = div('conn-detail');
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'conn-back';
      back.textContent = '\u2190 All connections';
      back.addEventListener('click', function () { select(null, true); });
      detail.appendChild(back);
      md.appendChild(side);
      md.appendChild(detail);
      h.body.appendChild(md);
      var want = which === 'users' ? 'accounts' : 'widgets';
      b.connections.forEach(function (c) {
        var uses = c.uses || (c.custom ? ['widgets'] : ['widgets']);
        if (uses.indexOf(want) === -1) { return; }
        var it = sideItem(c.slug, c.label);
        list.appendChild(it.li);
        items[c.slug] = it;
        var box = row(c, b.can_store, it);
        if (uses.length > 1) {
          box.querySelector('legend').appendChild(document.createTextNode(
            which === 'users' ? ' \u00b7 also used by widgets' : ' \u00b7 also read for its accounts'));
        }
        box.hidden = true;
        detail.appendChild(box);
        cards[c.slug] = box;
        order.push(c.slug);
      });
      if (which === 'integrations') {
        var add = sideItem(NEW, '+ Add a connection');
        add.button.classList.add('conn-item-add');
        add.button.querySelector('.conn-ind').remove();
        list.appendChild(add.li);
        items[NEW] = add;
        var form = addForm(b.can_store);
        form.hidden = true;
        detail.appendChild(form);
        cards[NEW] = form;
      }
      // Where to start: the one in the URL, else the one shown before a reload
      // (Save, Add), else the first -- or, on a narrow screen, the list.
      var start = sel || (h.want || {}).conn || null;
      select(start, false);
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
