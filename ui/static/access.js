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
    b.dataset.cell = u.pk + '|' + g.name;
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
  var VIEWS = ['groups', 'apps', 'admins'];
  var mode = VIEWS.indexOf(want.view || pref.mode) > 0 ? (want.view || pref.mode) : 'groups';
  // Per view: which way round (pivots[view]) and the two filters (filters[view]).
  // An older remembered `pivot: true` was App accounts'.
  var pivots = pref.pivots || { apps: !!pref.pivot };
  var filters = pref.filters || {};
  if ('pivot' in want) { pivots[mode] = want.pivot === '1'; }
  var pivot = !!pivots[mode], apps = null;
  function savePref() {
    pivots[mode] = pivot;
    try { localStorage.setItem(PREF, JSON.stringify({ mode: mode, pivots: pivots, filters: filters })); } catch (e) {}
  }
  function place() { return { view: mode, pivot: pivot }; }
  urlPageSet(place());
  // Back/Forward within the page: another view, or the other way round.
  h.onURL = function (w) {
    mode = VIEWS.indexOf(w.view) > 0 ? w.view : 'groups';
    pivot = 'pivot' in w ? w.pivot === '1' : !!pivots[mode];
    urlPageSet(place());
    if (!view) { return; }            // still loading: it draws the chosen view when done
    if (mode !== 'groups' && !apps) { note.textContent = 'Reading each app…'; loadApps(false); } else { render(); }
  };

  function switcher() {
    var sw = div('acc-switch');
    [['groups', 'Groups'], ['apps', 'App accounts'], ['admins', 'Admins']].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = m[1]; b.dataset.view = m[0];
      b.setAttribute('aria-pressed', String(mode === m[0]));
      b.addEventListener('click', function () {
        if (mode === m[0]) { return; }
        savePref();
        mode = m[0];
        pivot = !!pivots[mode];
        urlPage(place(), true);
        if (mode !== 'groups' && !apps) { note.textContent = 'Reading each app…'; loadApps(false); } else { render(); }
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
        (c.login ? ' · ' + c.login : '') + (c.note ? ' · ' + c.note : '') + (c.linked ? ' · matched by hand' : '') + (c.status === 'stale' ? ' (' + c.role + (c.disabled ? ', disabled' : '') + ')' : '') +
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
    var todo = canMake(p);
    if (todo.length) {
      var mk = document.createElement('button');
      mk.type = 'button'; mk.className = 'fg-btn acc-make'; mk.textContent = '+';
      mk.title = 'Accounts for ' + p.name + ': ' + todo.map(function (a) { return a.label; }).join(', ');
      mk.setAttribute('aria-label', mk.title);
      mk.addEventListener('click', function () {
        createAccountsDialog(p, todo, function () { apps = null; loadApps(true); });
      });
      el.appendChild(mk);
    }
    el.appendChild(div('note', p.email || ''));
    return el;
  }
  /** Apps this person has no account in where nav can make one, or an unmatched
   *  account there could be theirs. Each carries its unmatched accounts as `existing`. */
  function canMake(p) {
    return apps.apps.map(function (a) {
      return Object.assign({}, a, { existing: (apps.orphans || {})[a.key] || [] });
    }).filter(function (a) {
      var c = p.cells && p.cells[a.key];
      return !a.error && (!c || c.status === 'missing') && (a.create || a.existing.length);
    });
  }

  // --- shared by the three views: filters, pivot, and a table that scrolls inside the page
  // Filters: comma-separated words, any of which may match (case-insensitive) a
  // person's name, email or username, or a column's name. Typing redraws only the
  // table, so the box keeps its focus.
  function words(q) { return (q || '').toLowerCase().split(',').map(function (x) { return x.trim(); }).filter(Boolean); }
  function hits(q, texts) {
    var w = words(q);
    if (!w.length) { return true; }
    var hay = texts.filter(Boolean).join(' ').toLowerCase();
    return w.some(function (x) { return hay.indexOf(x) >= 0; });
  }
  function personHits(p) { return hits((filters[mode] || {}).people, [p.name, p.email, p.username]); }
  function colHits(texts) { return hits((filters[mode] || {}).cols, texts); }
  /** The bar above every view's table: two filters and the pivot. `redraw` draws the table again. */
  function gridBar(colNoun, redraw) {
    var bar = div('acc-gridbar');
    var f = filters[mode] = filters[mode] || {};
    function box(key, ph, title) {
      var i = document.createElement('input');
      i.type = 'search'; i.className = 'acc-filter'; i.id = 'acc-filter-' + key;
      i.placeholder = ph; i.title = title; i.value = f[key] || '';
      i.setAttribute('aria-label', ph);
      i.addEventListener('input', function () { f[key] = i.value; savePref(); redraw(); });
      bar.appendChild(i);
    }
    box('people', 'Filter people\u2026', 'Name, email or username; commas for several (any may match)');
    box('cols', 'Filter ' + colNoun + '\u2026', colNoun.charAt(0).toUpperCase() + colNoun.slice(1) + ' by name; commas for several');
    var flip = document.createElement('button');
    flip.type = 'button'; flip.id = 'acc-pivot'; flip.className = 'acc-pivot';
    flip.textContent = '\u21c4 ' + (pivot ? 'People across' : colNoun.charAt(0).toUpperCase() + colNoun.slice(1) + ' across');
    flip.title = 'Swap rows and columns';
    flip.setAttribute('aria-pressed', String(pivot));
    flip.addEventListener('click', function () { pivot = !pivot; savePref(); urlPage(place(), false); render(); });
    bar.appendChild(flip);
    h.body.appendChild(bar);
    return bar;
  }
  /** A people x columns table, either way round, inside a box that scrolls on its own
   *  (the page never gets wider; the headings and the first column stay put).
   *  o: {people, cols, corner, personHead(p, tag), colHead(c, tag), cell(p, c),
   *      extra: {label, cell(p)} -- one more column (or, pivoted, row) per person, cls} */
  function gridTable(o) {
    var people = o.people.filter(personHits), cols = o.cols.filter(function (c) { return colHits(o.colText(c)); });
    var wrap = div('acc-scroll');
    var t = document.createElement('table');
    t.className = 'acc-table ' + (o.cls || '') + (pivot ? ' acc-pivoted' : '');
    var hr = document.createElement('tr');
    var th0 = document.createElement('th'); th0.className = 'acc-corner';
    th0.textContent = pivot ? o.corner : 'Person'; hr.appendChild(th0);
    var tb = document.createElement('tbody');
    if (pivot) {
      people.forEach(function (p) { hr.appendChild(o.personHead(p, 'th')); });
      cols.forEach(function (c) {
        var tr = document.createElement('tr');
        tr.appendChild(o.colHead(c, 'td'));
        people.forEach(function (p) { tr.appendChild(o.cell(p, c)); });
        tb.appendChild(tr);
      });
      if (o.extra) {
        var er = document.createElement('tr');
        var eh = document.createElement('td'); eh.className = 'acc-who'; eh.textContent = o.extra.label; er.appendChild(eh);
        people.forEach(function (p) { er.appendChild(o.extra.cell(p)); });
        tb.appendChild(er);
      }
    } else {
      cols.forEach(function (c) { hr.appendChild(o.colHead(c, 'th')); });
      if (o.extra) { var x = document.createElement('th'); x.textContent = o.extra.label; hr.appendChild(x); }
      people.forEach(function (p) {
        var tr = document.createElement('tr');
        tr.appendChild(o.personHead(p, 'td'));
        cols.forEach(function (c) { tr.appendChild(o.cell(p, c)); });
        if (o.extra) { tr.appendChild(o.extra.cell(p)); }
        tb.appendChild(tr);
      });
    }
    t.appendChild(document.createElement('thead')).appendChild(hr);
    t.appendChild(tb);
    wrap.appendChild(t);
    if (!people.length || !cols.length) {
      wrap.appendChild(div('note acc-none', 'Nothing matches the filter' + (!people.length ? ' (no people)' : ' (no ' + o.corner.toLowerCase() + 's)') + '.'));
    }
    return wrap;
  }
  /** Put `node` where the last table was (or at the end). */
  function placeTable(slot, node) {
    if (slot.firstChild) { slot.replaceChild(node, slot.firstChild); } else { slot.appendChild(node); }
  }

  function renderApps() {
    save.hidden = true;
    note.textContent = '';
    freshness(apps.as_of, "Each app's own accounts, read with its key in User management, matched to Authentik " +
      'people by email, then username. Read-only.', function () { note.textContent = 'Reading each app…'; loadApps(true); });
    var slot = div('acc-slot');
    var bar = gridBar('apps', function () { placeTable(slot, appsTable()); });
    var jf = apps.apps.filter(function (a) { return a.key === 'jellyfin'; })[0];
    if (apps.jellyfin_only && jf && !jf.error) {
      var jo = document.createElement('button');
      jo.type = 'button'; jo.id = 'acc-jf-only'; jo.className = 'acc-pivot';
      jo.textContent = '+ Jellyfin-only';
      jo.title = 'A Jellyfin account for someone with no Authentik account: Jellyfin\u2019s own sign-in, ' +
        'from outside the house too (jf address, port 8920). Nothing else on the network.';
      jo.addEventListener('click', function () { jellyfinOnlyDialog(function () { apps = null; loadApps(true); }); });
      bar.appendChild(jo);
    }
    legend();

    function appsTable() {
      return gridTable({ people: apps.people, cols: apps.apps, corner: 'App', cls: 'acc-apps-table',
                         colText: function (a) { return [a.label, a.key]; },
                         personHead: personHead, colHead: appHead, cell: appCell });
    }
    h.body.appendChild(slot);
    placeTable(slot, appsTable());
    var only = (apps.app_only || {}).jellyfin || [];
    if (only.length) {
      var ob = div('acc-orphans acc-app-only');
      ob.appendChild(div('ts-lab', 'Jellyfin-only accounts (no Authentik account; Jellyfin\u2019s own sign-in)'));
      only.forEach(function (o) {
        var row = div('acc-orphan');
        var st = o.gone ? ['missing', '\u2715', 'Jellyfin no longer has this account']
               : o.disabled ? ['disabled', '\u25cb', 'Disabled in Jellyfin'] : ['user', '\u25cf', 'Account'];
        var sp = document.createElement('span');
        sp.className = 'acc-ind acc-ind-' + st[0]; sp.textContent = st[1];
        sp.title = st[2] + (o.last_seen ? ' \u00b7 last seen ' + new Date(o.last_seen).toLocaleString() : ' \u00b7 never signed in') +
          ' \u00b7 made by ' + o.by + ' ' + new Date(o.at).toLocaleDateString();
        sp.setAttribute('role', 'img'); sp.setAttribute('aria-label', sp.title);
        row.appendChild(sp);
        row.appendChild(document.createTextNode(' ' + (o.login || o.account) + (o.note ? ' \u2014 ' + o.note : '') + ' '));
        var x = document.createElement('button');
        x.type = 'button'; x.className = 'fg-btn acc-jf-remove'; x.textContent = '\u00d7';
        x.title = o.gone ? 'Forget it (Jellyfin no longer has it)' : 'Delete ' + (o.login || o.account) + ' from Jellyfin';
        x.addEventListener('click', function () {
          if (!o.gone && !confirm('Delete ' + (o.login || o.account) + ' from Jellyfin? Their watch history goes too.')) { return; }
          x.disabled = true;
          connSend('DELETE', 'api/admin/access/apps/jellyfin-only?account=' + encodeURIComponent(o.account))
            .then(function (r) { note.textContent = (o.login || o.account) + ': ' + r.detail; apps = null; return loadApps(true); })
            .catch(function (e) { note.textContent = 'Removing failed: ' + e.message; x.disabled = false; });
        });
        row.appendChild(x);
        ob.appendChild(row);
      });
      h.body.appendChild(ob);
    }
    var keys = Object.keys(apps.orphans || {});
    var hand = [];
    apps.people.forEach(function (p) {
      Object.keys(p.cells || {}).forEach(function (k) { if (p.cells[k].linked) { hand.push({ p: p, app: k, c: p.cells[k] }); } });
    });
    if (keys.length || hand.length) {
      var box = div('acc-orphans');
      var label = function (k) { var a = apps.apps.filter(function (x) { return x.key === k; })[0]; return a ? a.label : k; };
      if (keys.length) {
        box.appendChild(div('ts-lab', 'Accounts that match nobody in Authentik: say who they are'));
        keys.forEach(function (k) {
          apps.orphans[k].forEach(function (o) {
            var row = div('acc-orphan');
            row.appendChild(document.createTextNode(label(k) + ': ' + (o.login || o.email || '?') +
              (o.role === 'admin' ? ' (admin)' : '') + (o.disabled ? ' (disabled)' : '') + ' '));
            var sel = document.createElement('select');
            sel.className = 'acc-orphan-who';
            sel.setAttribute('aria-label', 'Who is ' + (o.login || o.email || 'this account') + ' in ' + label(k));
            sel.title = o.note || 'Match this account to a person by hand';
            var none = document.createElement('option'); none.value = ''; none.textContent = 'is\u2026';
            sel.appendChild(none);
            apps.people.forEach(function (p) {
              if (p.cells && p.cells[k] && p.cells[k].status !== 'missing') { return; }   // already has one here
              var op = document.createElement('option'); op.value = String(p.pk); op.textContent = p.name;
              sel.appendChild(op);
            });
            sel.addEventListener('change', function () {
              if (!sel.value) { return; }
              sel.disabled = true;
              linkAccount(k, o.key, Number(sel.value));
            });
            row.appendChild(sel);
            box.appendChild(row);
          });
        });
      }
      if (hand.length) {
        box.appendChild(div('ts-lab', 'Matched by hand'));
        hand.forEach(function (m) {
          var row = div('acc-orphan');
          row.appendChild(document.createTextNode(label(m.app) + ': ' + (m.c.login || m.c.linked) + ' \u2192 ' + m.p.name + ' '));
          var x = document.createElement('button');
          x.type = 'button'; x.className = 'fg-btn acc-unlink'; x.textContent = '\u00d7';
          x.title = 'Undo: ' + (m.c.login || m.c.linked) + ' is not ' + m.p.name;
          x.addEventListener('click', function () { x.disabled = true; linkAccount(m.app, m.c.linked, null); });
          row.appendChild(x);
          box.appendChild(row);
        });
      }
      h.body.appendChild(box);
    }
  }
  // --- Admins: who is admin in each app, toggled here and applied all at once -------
  // A pressed cell = admin. Clicking stages the opposite (outlined, + / −); Apply
  // makes every staged in-app change in one go and reads the apps again. Apps whose
  // sign-in sets admin from an Authentik group (a.admin.how === 'group') share one
  // toggle per person and group: Apply STAGES that group change for the Groups view's
  // Open PR, as a change in the app would be undone at the next sign-in.
  var adminWant = {};      // toggle key -> wanted admin (only where it differs from now)
  var adminRes = {};       // toggle key -> {ok, detail} from the last Apply
  function adminApps() { return apps.apps.filter(function (a) { return a.admin && !a.error; }); }
  function tkey(p, a) { return p.pk + '|' + (a.admin.how === 'group' ? 'group:' + a.admin.group : a.key); }
  function viewUser(p) { return view && (view.users || []).filter(function (u) { return u.pk === p.pk; })[0]; }
  // Now: in the app (its account's role), or for a group app, in the group (with any
  // change already staged for the next PR).
  function adminNow(p, a) {
    if (a.admin.how === 'group') {
      var u = viewUser(p);
      var c = view ? staged(p.pk, a.admin.group) : null;
      return { admin: c ? c.action === 'add' : !!(u && u.groups.indexOf(a.admin.group) >= 0), staged: !!c, known: !!u };
    }
    var cell = p.cells && p.cells[a.key];
    return { admin: !!(cell && cell.role === 'admin'), known: !!(cell && cell.key && cell.status !== 'missing'), key: cell && cell.key };
  }
  function adminPending() {
    return Object.keys(adminWant).length;
  }
  function adminCell(p, a) {
    var td = document.createElement('td');
    td.className = 'acc-cellind';
    var now = adminNow(p, a), k = tkey(p, a);
    if (!now.known) { td.title = a.label + ': ' + p.name + ' has no account here'; return td; }
    var change = k in adminWant;
    var will = change ? adminWant[k] : now.admin;
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.cell = p.pk + '|' + a.key;
    b.className = 'acc-cell adm-cell' + (change ? ' acc-staged' : '') + (now.staged ? ' adm-in-pr' : '');
    b.setAttribute('aria-pressed', String(will));
    b.textContent = change ? (will ? '+\u2605' : '\u2212') : (will ? '\u2605' : '');
    var grp = a.admin.how === 'group';
    var also = grp && a.admin.also && a.admin.also.length ? ' (also admin in ' + a.admin.also.join(', ') + ')' : '';
    var note = will ? a.admin.grant : a.admin.revoke;
    b.title = (change ? (will ? 'Will be made admin' : 'Admin will be removed') + ' in ' + a.label + ' on Apply. Click to undo'
                      : (will ? 'Admin in ' : 'Not admin in ') + a.label + '. Click to ' + (will ? 'remove admin' : 'make admin')) +
      (grp ? '\nComes from the Authentik group ' + a.admin.group + also + ': Apply stages that change for Open PR on Groups' : '') +
      (now.staged ? '\nAlready staged in ' + a.admin.group + ' for the next pull request' : '') +
      (change && note ? '\n' + note : '');
    b.addEventListener('click', function () {
      if (change) { delete adminWant[k]; } else { adminWant[k] = !now.admin; }
      delete adminRes[k];
      render();
    });
    td.appendChild(b);
    var r = adminRes[k];
    if (r && !r.ok) {
      var w = document.createElement('span');
      w.className = 'acc-ind acc-ind-missing adm-fail';
      w.textContent = '\u26a0';
      w.title = 'Not done: ' + r.detail;
      w.setAttribute('role', 'img');
      w.setAttribute('aria-label', w.title);
      td.appendChild(w);
    }
    return td;
  }
  function renderAdmins() {
    save.hidden = true;
    var n = adminPending();
    h.setDirty(n > 0);
    freshness(apps.as_of, 'Who is admin in each app. Click to change; nothing happens until Apply, which makes ' +
      'every change at once. Apps whose sign-in sets admin from an Authentik group stage that group instead ' +
      '(Groups -> Open PR).', function () { note.textContent = 'Reading each app…'; loadApps(true); });
    var bar = div('acc-admin-bar');
    var apply = document.createElement('button');
    apply.type = 'button'; apply.id = 'adm-apply'; apply.className = 'primary';
    apply.textContent = n ? 'Apply (' + n + ')' : 'Apply';
    apply.disabled = !n;
    apply.title = n ? 'Make these ' + n + ' change(s) now' : 'Nothing to apply: click cells to change who is admin';
    var undo = document.createElement('button');
    undo.type = 'button'; undo.id = 'adm-discard'; undo.textContent = 'Discard';
    undo.disabled = !n;
    undo.addEventListener('click', function () { adminWant = {}; render(); });
    apply.addEventListener('click', applyAdmins);
    bar.appendChild(apply); bar.appendChild(undo);
    h.body.appendChild(bar);
    var list = adminApps();
    if (!list.length) {
      h.body.appendChild(div('note', 'No app here lets nav change who is admin.'));
      return;
    }
    function adminHead(a, tag) {
      var th = appHead(a, tag);
      if (a.admin.how === 'group') {
        var g = document.createElement('span');
        g.className = 'acc-signin adm-group';
        g.textContent = 'group';
        g.title = 'Admin comes from the Authentik group ' + a.admin.group +
          (a.admin.also && a.admin.also.length ? ' (also: ' + a.admin.also.join(', ') + ')' : '');
        g.setAttribute('role', 'img'); g.setAttribute('aria-label', g.title);
        th.appendChild(g);
      }
      return th;
    }
    function nameHead(p, tag) { var w = document.createElement(tag); w.className = 'acc-who'; w.textContent = p.name; return w; }
    var slot = div('acc-slot');
    function adminsTable() {
      return gridTable({ people: apps.people, cols: list, corner: 'App', cls: 'acc-apps-table acc-admins-table',
                         colText: function (a) { return [a.label, a.key, a.admin.group]; },
                         personHead: nameHead, colHead: adminHead, cell: adminCell });
    }
    gridBar('apps', function () { placeTable(slot, adminsTable()); });
    h.body.appendChild(slot);
    placeTable(slot, adminsTable());
  }
  function applyAdmins() {
    var inApp = [], groups = [], keyOf = {};
    apps.people.forEach(function (p) {
      adminApps().forEach(function (a) {
        var k = tkey(p, a);
        if (!(k in adminWant) || keyOf[k]) { return; }
        keyOf[k] = true;
        if (a.admin.how === 'group') { groups.push({ k: k, body: { pk: p.pk, group: a.admin.group, add: adminWant[k], name: p.name } }); }
        else { inApp.push({ k: k, body: { app: a.key, account: adminNow(p, a).key, admin: adminWant[k] } }); }
      });
    });
    note.textContent = 'Applying\u2026';
    var b = document.getElementById('adm-apply'); if (b) { b.disabled = true; }
    var res = {};
    var chain = Promise.resolve();
    if (inApp.length) {
      chain = connSend('POST', 'api/admin/access/apps/admins', { changes: inApp.map(function (c) { return c.body; }) })
        .then(function (r) {
          (r.results || []).forEach(function (x) {
            var c = inApp.filter(function (y) { return y.body.app === x.app && y.body.account === x.account; })[0];
            if (c) { res[c.k] = { ok: x.ok, detail: x.detail }; }
          });
        }, function (e) { inApp.forEach(function (c) { res[c.k] = { ok: false, detail: e.message }; }); });
    }
    groups.forEach(function (g) {
      chain = chain.then(function () {
        return connSend('POST', 'api/admin/access/changes', g.body)
          .then(function () { res[g.k] = { ok: true, detail: 'staged' }; },
                function (e) { res[g.k] = { ok: false, detail: e.message }; });
      });
    });
    chain.then(function () {
      var keys = Object.keys(res);
      var bad = keys.filter(function (k) { return !res[k].ok; });
      // Done ones leave the staged set; failures stay staged, marked, to retry or discard.
      keys.forEach(function (k) { if (res[k].ok) { delete adminWant[k]; } });
      adminRes = res;
      var staged = groups.filter(function (g) { return res[g.k] && res[g.k].ok; }).length;
      var done = keys.length - bad.length - staged;
      var msg = (done ? done + ' applied. ' : '') + (staged ? staged + ' group change(s) staged: Groups \u2192 Open PR. ' : '') +
                (bad.length ? bad.length + ' not done (\u26a0 on the cell says why).' : '');
      return Promise.all([load(true).catch(function () {}), loadApps(true)]).then(function () { note.textContent = msg.trim(); });
    });
  }

  function linkAccount(app, account, pk) {
    connSend('PUT', 'api/admin/access/apps/links', { app: app, account: account, pk: pk })
      .then(function () { return loadApps(false); })
      .catch(function (e) { note.textContent = 'Matching failed: ' + e.message; render(); });
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

  // A redraw (a toggle, Apply, a re-read) keeps the grid where it was and the focus on
  // the same cell; only switching views starts at the top.
  var drawn = null;
  function render() {
    var old = h.body.querySelector('.acc-scroll'), act = document.activeElement;
    var keep = drawn === mode && old ? { t: old.scrollTop, l: old.scrollLeft, x: window.scrollX, y: window.scrollY,
                                         cell: act && h.body.contains(act) && act.dataset ? act.dataset.cell : null } : null;
    drawn = mode;
    draw();
    if (!keep) { return; }
    var grid = h.body.querySelector('.acc-scroll');
    if (grid) { grid.scrollTop = keep.t; grid.scrollLeft = keep.l; }
    window.scrollTo(keep.x, keep.y);
    var f = keep.cell && [].filter.call(h.body.querySelectorAll('[data-cell]'), function (e) { return e.dataset.cell === keep.cell; })[0];
    if (f) { f.focus({ preventScroll: true }); }
  }
  function draw() {
    h.body.innerHTML = '';
    switcher();
    if (mode !== 'groups') {
      // Not read yet (first open, or cleared after a PR): read, then draw.
      if (!apps) { note.textContent = 'Reading each app…'; loadApps(false); return; }
      if (mode === 'admins') { renderAdmins(); } else { renderApps(); }
      return;
    }
    h.setDirty(adminPending() > 0);
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
    function groupHead(g, tag) {
      var x = document.createElement(tag);
      x.textContent = g.name;
      if (!g.managed) { x.className = 'acc-unmanaged'; }
      x.title = g.managed ? g.path : g.path + ' -- membership not in Terraform';
      return x;
    }
    function userHead(u, tag) {
      var who = document.createElement(tag);
      who.className = 'acc-who';
      who.textContent = u.name;
      who.appendChild(div('note', u.email || u.username || ''));
      return who;
    }
    function appsCell(u) {
      var apps = document.createElement('td');
      apps.className = 'acc-apps';
      var now = document.createElement('span');
      now.textContent = u.apps.length + ' app' + (u.apps.length === 1 ? '' : 's');
      now.title = u.apps.map(function (x) { return x.name; }).join('\n') || 'none';
      apps.appendChild(now);
      if (u.gains.length) { apps.appendChild(div('acc-gain', '+ ' + u.gains.join(', '))); }
      if (u.losses.length) { apps.appendChild(div('acc-loss', '\u2212 ' + u.losses.join(', '))); }
      if (u.unknown.length && (u.gains.length || u.losses.length)) {
        apps.appendChild(div('note', "can't judge: " + u.unknown.join(', ')));
      }
      return apps;
    }
    var slot = div('acc-slot');
    function groupsTable() {
      return gridTable({ people: view.users, cols: view.groups, corner: 'Group',
                         colText: function (g) { return [g.name]; },
                         personHead: userHead, colHead: groupHead, cell: cell,
                         extra: { label: 'Apps', cell: appsCell } });
    }
    gridBar('groups', function () { placeTable(slot, groupsTable()); });
    h.body.appendChild(slot);
    placeTable(slot, groupsTable());
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
    var b = e.target.closest('.acc-cell[data-group]');
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


// --- Create accounts (App accounts, + beside a person) ------------------------------
// Pressed buttons choose the apps (pressed = make it); one password serves every app
// that needs one, and each app names the account by username or email as it needs.
function createAccountsDialog(p, todo, done) {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.className = 'smalldlg person-dlg';
  box.id = 'make-dlg';
  back.appendChild(box);
  document.body.appendChild(back);
  var made = false;
  function close() { back.remove(); document.removeEventListener('keydown', onKey); if (made) { done(); } }
  function onKey(e) { if (e.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', function (e) { if (e.target === back) { close(); } });
  function el(tag, cls, text) { var x = document.createElement(tag); if (cls) { x.className = cls; } if (text) { x.textContent = text; } return x; }

  box.appendChild(el('h3', null, 'Accounts for ' + p.name));
  // One row per app: its ways (pressed buttons, at most one) and, where accounts
  // match nobody, "is…" to say one of those is this person. choice[key] =
  // {mode: id} to make one, or {link: account key} for an existing one.
  var choice = {};
  var rows = todo.map(function (a) {
    var c = p.cells && p.cells[a.key];
    var row = el('div', 'person-row make-app');
    row.dataset.app = a.key;
    var lab = el('span', 'person-lab', a.label);
    var skip = el('span', 'make-skip-tag', 'ignored');
    skip.title = 'Nothing will be done in ' + a.label + ': press a way, or pick an existing account';
    lab.title = c ? 'Authentik lets ' + p.name + ' open ' + a.label : 'Authentik does not let ' + p.name + ' open ' + a.label + ' yet';
    row.appendChild(lab);
    var btns = (a.create || []).map(function (m) {
      var b = el('button', 'ts-t person-choice', m.label);
      b.type = 'button'; b.dataset.mode = m.id;
      b.title = (m.login === 'email' ? p.email : m.login === 'name' ? p.name : p.username) +
        (m.needs === 'password' ? ' · the password below' : '') + (m.hint ? ' · ' + m.hint : '');
      b.addEventListener('click', function () {
        choice[a.key] = choice[a.key] && choice[a.key].mode === m.id ? null : { mode: m.id };
        if (sel) { sel.value = ''; }
        paint();
      });
      row.appendChild(b);
      return b;
    });
    // Admin, where nav sets it in the app (pressed = make them admin too).
    var adm = null;
    if (a.admin && a.admin.how === 'app') {
      adm = el('button', 'ts-t person-choice make-admin', '\u2605 Admin');
      adm.type = 'button';
      adm.title = 'Also make ' + p.name + ' an admin in ' + a.label + (a.admin.grant ? '. ' + a.admin.grant : '');
      adm.setAttribute('aria-pressed', 'false');
      adm.addEventListener('click', function () {
        adm.setAttribute('aria-pressed', String(adm.getAttribute('aria-pressed') !== 'true'));
      });
    }
    var sel = null;
    if (a.existing.length) {
      sel = el('select', 'make-existing');
      sel.setAttribute('aria-label', p.name + ' is an existing ' + a.label + ' account');
      sel.title = 'Already has one: pick it (an account nobody is matched to)';
      var none = el('option', null, 'is existing\u2026'); none.value = '';
      sel.appendChild(none);
      a.existing.forEach(function (o) {
        var op = el('option', null, (o.login || o.email || o.name || '?') + (o.note ? ' (' + o.note.split(' (')[0] + ')' : ''));
        op.value = o.key;
        sel.appendChild(op);
      });
      sel.addEventListener('change', function () { choice[a.key] = sel.value ? { link: sel.value } : null; paint(); });
      row.appendChild(sel);
    }
    if (adm) { row.appendChild(adm); }
    row.appendChild(skip);
    // Default: where Authentik already lets them in, the first way to make one.
    if (c && c.status === 'missing' && a.create && a.create.length) { choice[a.key] = { mode: a.create[0].id }; }
    box.appendChild(row);
    return { a: a, btns: btns, sel: sel, row: row, adm: adm };
  });
  var pwRow = el('label', 'person-row make-pw');
  pwRow.appendChild(el('span', 'person-lab', 'Password'));
  var pw = el('input');
  pw.type = 'password'; pw.id = 'make-password'; pw.autocomplete = 'new-password';
  pw.title = 'One password for every app here that needs one (at least 8 characters). nav never stores it.';
  pwRow.appendChild(pw);
  var show = el('button', 'ts-t', 'Show');
  show.type = 'button'; show.title = 'Show the password';
  show.addEventListener('click', function () {
    pw.type = pw.type === 'password' ? 'text' : 'password';
    show.setAttribute('aria-pressed', String(pw.type === 'text'));
  });
  pwRow.appendChild(show);
  box.appendChild(pwRow);
  var out = el('div', 'make-results');
  box.appendChild(out);
  var foot = el('div', 'smalldlg-foot');
  var cancel = el('button', null, 'Close');
  cancel.type = 'button'; cancel.addEventListener('click', close);
  var go = el('button', 'primary', 'Create');
  go.type = 'button'; go.id = 'make-create';
  foot.appendChild(cancel); foot.appendChild(go);
  box.appendChild(foot);

  function modeOf(a) {
    var ch = choice[a.key];
    return ch && ch.mode ? (a.create || []).filter(function (m) { return m.id === ch.mode; })[0] : null;
  }
  function needsPw() {
    return rows.some(function (r) { var m = modeOf(r.a); return m && m.needs === 'password'; });
  }
  function any() { return rows.some(function (r) { return choice[r.a.key]; }); }
  function paint() {
    rows.forEach(function (r) {
      var ch = choice[r.a.key];
      r.btns.forEach(function (b) { b.setAttribute('aria-pressed', String(!!(ch && ch.mode === b.dataset.mode))); });
      if (r.adm) { r.adm.hidden = !(ch && ch.mode); }
      // Unpressed: greyed, and says it is ignored.
      r.row.classList.toggle('make-ignored', !ch && !r.row.classList.contains('make-done'));
    });
    pwRow.hidden = !needsPw();
    go.disabled = !any() || (needsPw() && pw.value.length < 8);
  }
  pw.addEventListener('input', paint);
  paint();

  function report(a, ok, detail, warn) {
    var line = el('div', 'make-result');
    line.appendChild(personInd(!ok ? 'bad' : warn ? 'warn' : 'ok', detail));
    line.appendChild(document.createTextNode(' ' + a.label + ': ' + detail));
    out.appendChild(line);
    if (ok) {
      choice[a.key] = null;
      var r = rows.filter(function (x) { return x.a.key === a.key; })[0];
      r.btns.forEach(function (b) { b.disabled = true; });
      if (r.sel) { r.sel.disabled = true; }
      if (r.adm) { r.adm.disabled = true; }
      r.row.classList.add('make-done');
    }
  }
  go.addEventListener('click', function () {
    go.disabled = true;
    out.textContent = 'Working\u2026';
    var make = {}, links = [], admins = [];
    rows.forEach(function (r) {
      var ch = choice[r.a.key];
      if (ch && ch.mode) {
        make[r.a.key] = ch.mode;
        if (r.adm && r.adm.getAttribute('aria-pressed') === 'true') { admins.push(r.a.key); }
      }
      else if (ch && ch.link) { links.push({ a: r.a, account: ch.link }); }
    });
    var lines = [];
    var chain = Promise.resolve();
    links.forEach(function (l) {
      chain = chain.then(function () {
        return connSend('PUT', 'api/admin/access/apps/links', { app: l.a.key, account: l.account, pk: p.pk })
          .then(function (r) { lines.push([l.a, true, 'matched to ' + l.account + (r && r.detail ? '; ' + r.detail : '')]); },
                function (e) { lines.push([l.a, false, e.message]); });
      });
    });
    chain.then(function () {
      if (!Object.keys(make).length) { return null; }
      return connSend('POST', 'api/admin/access/apps/create', { pk: p.pk, apps: make, password: needsPw() ? pw.value : '', admins: admins })
        .then(function (r) {
          rows.forEach(function (x) { var res = (r.results || {})[x.a.key]; if (res) { lines.push([x.a, res.ok, res.detail, res.warn]); } });
        }, function (e) { lines.push([{ label: 'Create' }, false, e.message]); });
    }).then(function () {
      made = true;
      out.innerHTML = '';
      lines.forEach(function (l) { report(l[0], l[1], l[2], l[3]); });
      pw.value = '';
      paint();
    });
  });
  setTimeout(function () { (needsPw() ? pw : go).focus(); }, 0);
}


// --- Jellyfin-only account (App accounts, + Jellyfin-only) --------------------------
// For someone with no Authentik account: a regular Jellyfin user, reachable from
// outside on Jellyfin's own sign-in. Libraries: all (pressed) or the ones pressed.
function jellyfinOnlyDialog(done) {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.className = 'smalldlg person-dlg';
  box.id = 'jfo-dlg';
  back.appendChild(box);
  document.body.appendChild(back);
  var made = false;
  function close() { back.remove(); document.removeEventListener('keydown', onKey); if (made) { done(); } }
  function onKey(e) { if (e.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', function (e) { if (e.target === back) { close(); } });
  function el(tag, cls, text) { var x = document.createElement(tag); if (cls) { x.className = cls; } if (text) { x.textContent = text; } return x; }
  function field(label, id, type, title) {
    var row = el('label', 'person-row');
    row.appendChild(el('span', 'person-lab', label));
    var i = el('input'); i.id = id; i.type = type; i.title = title;
    if (type === 'password') { i.autocomplete = 'new-password'; }
    row.appendChild(i);
    box.appendChild(row);
    return i;
  }
  box.appendChild(el('h3', null, 'Jellyfin-only account'));
  box.appendChild(el('p', 'admin-why', 'For someone with no Authentik account. They sign in to Jellyfin with this ' +
    'username and password, at home or from outside (allowed countries only). A regular user: locked out after ' +
    'repeated wrong passwords. Nothing else on the network.'));
  var user = field('Username', 'jfo-user', 'text', '2-32 letters, digits, . _ or - (what they type to sign in)');
  var pw = field('Password', 'jfo-pw', 'password', 'At least 8 characters. nav never stores it.');
  var who = field('Who is it for', 'jfo-note', 'text', 'Optional: a note shown in the list (e.g. "Grandma")');
  var libRow = el('div', 'person-row jfo-libs');
  libRow.appendChild(el('span', 'person-lab', 'Libraries'));
  var allB = el('button', 'ts-t person-choice', 'All');
  allB.type = 'button'; allB.setAttribute('aria-pressed', 'true');
  allB.title = 'Every library, including ones added later. Click to choose instead';
  libRow.appendChild(allB);
  var libBtns = [];
  var libWrap = el('span', 'jfo-liblist');
  libRow.appendChild(libWrap);
  box.appendChild(libRow);
  connSend('GET', 'api/admin/access/apps/jellyfin-only/libraries').then(function (r) {
    (r.libraries || []).forEach(function (l) {
      var b = el('button', 'ts-t person-choice jfo-lib', l.name);
      b.type = 'button'; b.dataset.id = l.id; b.setAttribute('aria-pressed', 'true'); b.disabled = true;
      b.title = 'Pressed: they see ' + l.name;
      b.addEventListener('click', function () { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); paint(); });
      libWrap.appendChild(b);
      libBtns.push(b);
    });
    paint();
  }, function (e) { libWrap.textContent = 'Could not list libraries: ' + e.message; });
  allB.addEventListener('click', function () {
    allB.setAttribute('aria-pressed', String(allB.getAttribute('aria-pressed') !== 'true'));
    paint();
  });
  var out = el('div', 'make-results');
  box.appendChild(out);
  var foot = el('div', 'smalldlg-foot');
  var cancel = el('button', null, 'Close');
  cancel.type = 'button'; cancel.addEventListener('click', close);
  var go = el('button', 'primary', 'Create');
  go.type = 'button'; go.id = 'jfo-create';
  foot.appendChild(cancel); foot.appendChild(go);
  box.appendChild(foot);
  var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
  function chosen() {
    if (allB.getAttribute('aria-pressed') === 'true') { return null; }
    return libBtns.filter(function (b) { return b.getAttribute('aria-pressed') === 'true'; }).map(function (b) { return b.dataset.id; });
  }
  function paint() {
    var all = allB.getAttribute('aria-pressed') === 'true';
    libBtns.forEach(function (b) { b.disabled = all || made; });
    var libs = chosen();
    go.disabled = made || !NAME.test(user.value.trim()) || pw.value.length < 8 || (libs !== null && !libs.length);
  }
  [user, pw].forEach(function (i) { i.addEventListener('input', paint); });
  paint();
  go.addEventListener('click', function () {
    go.disabled = true;
    out.textContent = 'Working\u2026';
    connSend('POST', 'api/admin/access/apps/jellyfin-only',
             { username: user.value.trim(), password: pw.value, note: who.value.trim(), libraries: chosen() })
      .then(function (r) { made = true; return { ok: true, detail: r.detail }; }, function (e) { return { ok: false, detail: e.message }; })
      .then(function (r) {
        out.innerHTML = '';
        var line = el('div', 'make-result');
        line.appendChild(personInd(r.ok ? 'ok' : 'bad', r.detail));
        line.appendChild(document.createTextNode(' ' + r.detail));
        out.appendChild(line);
        if (r.ok) { pw.value = ''; [user, pw, who, allB].forEach(function (x) { x.disabled = true; }); }
        paint();
      });
  });
  setTimeout(function () { user.focus(); }, 0);
}
