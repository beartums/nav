// main.js -- Search, tabs, render() and refresh() -- and the boot call. Loads LAST.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// --- search ---------------------------------------------------------
// Filters the tiles that are already loaded. Everything the page can show
// is in APPS, so this needs no round trip and stays responsive while the
// list grows.
var SEARCH = '';

function searchMatch(a) {
  if (!SEARCH) { return true; }
  var hay = [a.name, a.description, a.category || 'Other', a.slug]
              .join(' ').toLowerCase();
  // Every term must appear somewhere, in any order -- "media sonarr"
  // should find it. Substring rather than prefix, because half the names
  // here are compounds ("qbittorrent", "bentopdf").
  return SEARCH.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
}

function filtered(list) {
  return SEARCH ? list.filter(searchMatch) : list;
}

(function () {
  var box = document.getElementById('search');
  box.addEventListener('input', function () {
    SEARCH = box.value.trim().toLowerCase();
    render();
  });
  box.addEventListener('keydown', function (ev) {
    // Escape clears rather than blurs: a stale filter with an empty-looking
    // page is the thing people report as "my tiles are gone".
    if (ev.key === 'Escape') { box.value = ''; SEARCH = ''; render(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) { return; }
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { return; }
    ev.preventDefault();
    box.focus();
    box.select();
  });
})();

function noMatches() {
  var m = document.createElement('div');
  m.className = 'msg';
  m.textContent = 'No tiles match \u201c' + SEARCH + '\u201d.';
  out.appendChild(m);
}

// Tabbed grouping: one category at a time, with swipe between them.
//
// The active tab is per DEVICE, like `collapsed` -- a phone and a desktop
// legitimately sit on different tabs, and it is a view position rather
// than anything an admin sets.
var TAB = null;
try { TAB = localStorage.getItem('nav.tab'); } catch (e) {}

var TAB = null;
try { TAB = localStorage.getItem('nav.tab'); } catch (e) {}

/** Categories that currently have a tab, in order. Recomputed per use --
 *  groups, search and admin mode all change it. */
function tabCats() {
  return pageCats(arranging()).filter(function (c) {
    if (groupHidden(c) && !arranging()) { return false; }
    var inCat = APPS.filter(function (a) { return (a.category || 'Other') === c; });
    // While searching, a tab with no matches is a dead end you can swipe
    // into and find empty. Widgets never match a search (widgetRow).
    return SEARCH ? filtered(inCat).length > 0 : inCat.length > 0 || widgetsIn(c).length > 0;
  });
}

function showTab(c) {
  TAB = c;
  try { localStorage.setItem('nav.tab', c); } catch (e) {}
  render();
  // Keep the chosen tab in view when there are more tabs than fit.
  var sel = out.querySelector('.tabs button[aria-selected="true"]');
  if (sel && sel.scrollIntoView) {
    sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function stepTab(delta) {
  var cats = tabCats();
  var i = cats.indexOf(TAB) + delta;
  if (i >= 0 && i < cats.length) { showTab(cats[i]); }
}

// 🔴 ATTACHED ONCE, at module scope, NOT inside renderTabs().
//
// These used to be wired up per render. showTab() re-renders, so every
// swipe left another listener behind: the first swipe advanced one tab,
// the next advanced two, then four. Worse, each stale listener had
// captured the `cats` array and `TAB` of the render that created it, so
// once a few had piled up the tabs appeared to jump between arbitrary
// positions -- reported as "swiping left gave me the second tab, then the
// fourth, then only the fourth and first".
//
// `out` survives every render (render() clears its children, not the node),
// so one listener here is correct and stays correct. Everything it needs
// is read at fire time rather than captured.
(function () {
  var sx = 0, sy = 0, tracking = false;
  out.addEventListener('touchstart', function (ev) {
    if (opts.group !== 'tabs') { return; }
    if (ev.touches.length !== 1) { tracking = false; return; }
    sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; tracking = true;
  }, { passive: true });
  out.addEventListener('touchend', function (ev) {
    if (!tracking || opts.group !== 'tabs') { return; }
    tracking = false;
    var t = ev.changedTouches && ev.changedTouches[0];
    if (!t) { return; }
    var dx = t.clientX - sx, dy = t.clientY - sy;
    // Thresholds: 40px of horizontal travel AND mostly horizontal, so a
    // diagonal scroll down the page does not jump tabs under your thumb.
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) { return; }
    stepTab(dx < 0 ? 1 : -1);      // swipe left = next tab
  }, { passive: true });
})();

// Tabbed grouping: one category at a time, with swipe between them.
//
// The active tab is per DEVICE, like `collapsed` -- a phone and a desktop
// legitimately sit on different tabs, and it is a view position rather
// than anything an admin sets.
function renderTabs() {
  out.className = 'tabbed';
  var cats = tabCats();
  if (!cats.length) {
    if (SEARCH) { noMatches(); }
    return;
  }
  if (cats.indexOf(TAB) === -1) { TAB = cats[0]; }

  var bar = document.createElement('div');
  bar.className = 'tabs';
  bar.setAttribute('role', 'tablist');
  cats.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c === TAB));
    b.textContent = c;
    var n = document.createElement('span');
    n.className = 'count';
    n.textContent = filtered(APPS.filter(function (a) {
      return (a.category || 'Other') === c;
    })).length;
    b.appendChild(n);
    b.addEventListener('click', function () { showTab(c); });
    bar.appendChild(b);
  });
  // The tab bar IS recreated each render, so its listener goes with it.
  bar.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowRight') { ev.preventDefault(); stepTab(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepTab(-1); }
  });
  out.appendChild(bar);

  var tabTiles = filtered(sorted(APPS.filter(function (a) {
    return (a.category || 'Other') === TAB;
  })));
  if (useGroupGrid()) {
    out.appendChild(groupGrid(TAB, tabTiles, SEARCH ? [] : widgetsIn(TAB)));
    return;
  }
  var wrow = widgetRow(widgetsIn(TAB));
  if (wrow) { out.appendChild(wrow); }
  out.appendChild(grid(tabTiles));
}

function render() {
  if (typeof closePeek === 'function') { closePeek(); }
  out.className = '';
  out.innerHTML = '';
  if (BULK.on && ADMIN_MODE) { out.appendChild(bulkTable()); return; }
  if (!APPS.length) {
    out.className = 'msg';
    out.textContent = 'No applications are available to you. That is Authentik’s answer, ' +
                      'not an error — it means no policy binding grants you one.';
    return;
  }
  if (opts.group === 'tabs') { renderTabs(); return; }
  if (opts.group === 'on') {
    var byCat = {};
    APPS.forEach(function (a) {
      var c = a.category || 'Other';
      (byCat[c] = byCat[c] || []).push(a);
    });
    // pageCats, not categoriesOf: a group holding only widgets still renders.
    pageCats(arranging()).forEach(function (c) {
      var placed = widgetsIn(c);
      if (!byCat[c] && !placed.length) { return; }
      byCat[c] = byCat[c] || [];
      // A hidden group stays visible in admin mode -- otherwise hiding one
      // removes it from the only view that can bring it back.
      if (groupHidden(c) && !arranging()) { return; }
      // While searching, a heading with nothing under it is noise -- and
      // worse, it reads as "this group has no matches" in a layout where
      // every other empty group has already been dropped.
      if (SEARCH && !filtered(byCat[c]).length) { return; }
      var h = document.createElement('h2');
      h.className = 'cat' + (collapsed[c] ? ' closed' : '');
      var chev = document.createElement('span');
      chev.className = 'chev'; chev.textContent = '\u25be';
      var label = document.createElement('span');
      label.textContent = c;
      h.appendChild(chev); h.appendChild(label);
      h.setAttribute('role', 'button');
      h.setAttribute('aria-expanded', String(!collapsed[c]));
      // Collapsed does not mean empty. Tiles marked above-the-fold stay
      // visible, which is the point of the flag -- the two or three things
      // wanted at a glance without expanding the section they live in.
      var all = filtered(sorted(byCat[c]));
      var shown = collapsed[c] ? all.filter(function (x) { return x.above_fold; }) : all;
      // The shared grid holds tiles AND widgets; a collapsed group or a
      // search shows neither widget (widgets never match a search).
      var gridded = useGroupGrid();
      var wshown = gridded && !collapsed[c] && !SEARCH ? placed : [];
      var body = gridded ? groupGrid(c, shown, wshown) : grid(shown);
      // In admin mode an empty group stays a visible drop target.
      body.hidden = shown.length === 0 && !wshown.length && !(gridded && arranging() && !collapsed[c]);
      if (collapsed[c] && shown.length) {
        var pin = document.createElement('span');
        pin.className = 'count';
        pin.textContent = shown.length + ' of ' + all.length;
        pin.style.cssText = 'margin-left:auto; color:var(--muted); font-size:12px;';
        h.appendChild(pin);
      }
      h.addEventListener('click', function () {
        collapsed[c] = !collapsed[c];
        saveCollapsed();
        // Re-render rather than toggling `hidden`: which tiles belong in a
        // collapsed section is a different set, not the same set concealed.
        render();
      });
      out.appendChild(h);
      // Outside the shared grid, widgets lead their group in their own row,
      // and fold away with it.
      var wrow = gridded || collapsed[c] ? null : widgetRow(placed);
      if (wrow) { out.appendChild(wrow); }
      out.appendChild(body);
    });
    if (SEARCH && !out.querySelector('a.app')) { noMatches(); }
  } else {
    var flat = arranging() ? APPS : APPS.filter(function (a) {
      return !groupHidden(a.category || 'Other');
    });
    var shownFlat = filtered(sorted(flat));
    // No groups to put them in: every placed widget once, at the top.
    var once = {};
    var frow = widgetRow(WIDGETS.placements.filter(function (p) {
      if (once[p.def_id]) { return false; }
      once[p.def_id] = 1;
      return arranging() || !groupHidden(p.category);
    }));
    if (frow) { out.appendChild(frow); }
    if (SEARCH && !shownFlat.length) { noMatches(); } else { out.appendChild(grid(shownFlat)); }
  }
}

// NOT `load()`: that name already belongs to the view-options reader above,
// and a duplicate function declaration in the same scope silently replaces
// it -- `var opts = load()` then returns a Promise and every option reads
// undefined. Nothing errors; the menu just goes blank.
function refresh() {
  // include_hidden only in admin mode: hiding a tile must not remove it
  // from the one screen that can unhide it. The server ignores the flag for
  // non-admins regardless.
  // Impersonation wins over admin: you are looking at someone else's
  // dashboard, and include_hidden would show tiles they cannot see.
  var url = 'api/apps';
  if (IMPERSONATING) {
    var qs = [];
    if (IMPERSONATING.user) { qs.push('as_user=' + encodeURIComponent(IMPERSONATING.user)); }
    (IMPERSONATING.groups || []).forEach(function (g) {
      qs.push('as_group=' + encodeURIComponent(g));
    });
    url += '?' + qs.join('&');
  } else if (arranging()) {
    // Hidden tiles too, to unhide them: every one for an admin, and for a
    // user only those of their own dashboard (the server decides).
    url += '?include_hidden=true' + layoutQuery('&');
  } else {
    url += layoutQuery('?');
  }
  var asked = viewLayoutId();
  return Promise.all([
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        // The template this device was editing has been deleted (here or
        // elsewhere): back to the default rather than an error page.
        if (r.status === 404 && asked != null) { return { retry: true }; }
        if (!r.ok) { throw new Error('nav-api returned ' + r.status); }
        return r.json();
      }),
    // Site settings are needed for the title in both modes; the override
    // map only for editing, but one round trip is cheaper than branching.
    fetch('api/site').then(function (r) { return r.ok ? r.json() : {}; })
                     .catch(function () { return {}; }),
    // Never fails: a widget problem costs the widgets, not the page.
    loadWidgets(),
    arranging() && !Object.keys(WIDGET_TYPE_TITLES).length ? loadWidgetTypeTitles() : null,
    // Always: the View menu lists the dashboards to switch between.
    IMPERSONATING ? null : loadLayouts()
  ])
    .then(function (both) {
      var data = both[0];
      if (data.retry) {
        if (ADMIN_MODE) { setAdminTemplate(null); } else { setUserLayout(null); }
        return refresh();
      }
      SITE = both[1] || {};
      LAYOUT = data.layout || null;
      // Off the layout since templates; the site keys are an older API's.
      GROUP_ORDER = LAYOUT ? groupOrder()
        : Array.isArray(SITE.group_order) ? SITE.group_order : [];
      applySite();
      document.getElementById('who').textContent = data.user || '';
      IS_ADMIN = !!data.admin;
      MAY_IMPERSONATE = !!data.may_impersonate;
      // The SERVER's answer, not the local guess. If it declined -- the
      // subject vanished, the group emptied, membership was revoked -- the
      // banner must come down rather than mislabel a real dashboard as
      // somebody else's.
      IMPERSONATING = data.impersonating || null;
      applyImpersonation();
      APPS = data.apps || [];
      OVERRIDES = {};
      APPS.forEach(function (a) { if (a.override) { OVERRIDES[a.slug] = a.override; } });
      if (!IS_ADMIN && ADMIN_MODE) { setAdminMode(false); return; }
      buildMenu();
      // Edit mode needs a dashboard of the caller's own: one deleted elsewhere
      // ends it rather than editing the shared template by accident.
      if (EDIT_MODE && !ownDashboard()) { EDIT_MODE = false; document.body.classList.remove('edit-mode'); }
      if (ADMIN_MODE) { buildTemplatePicker(); }
      if (EDIT_MODE) { buildEditBar(); }
      if (arranging()) { buildGroups(); buildWidgetLibrary(); }
      render();
      loadHealth();
    })
    .catch(function (err) {
      out.className = 'msg err';
      // Name the component. "Failed to load" sent people to Authentik last
      // time when the fault was one layer nearer.
      out.textContent = apiFailure(err);
    });
}

refresh();
// Health is re-read on its own clock, not by re-rendering the page.
setInterval(function () { if (!document.hidden) { loadHealth(); } }, HEALTH_EVERY);

// --- has a new version landed? -------------------------------------------------
//
// The page and the API ship in one image, but a browser can hold an old page
// across a rollout: version.json is the page's build (stamped by the image),
// /api/version the server's. Both are read at load and re-read every few
// minutes; when either differs, a note offers a reload.

var PAGE_VERSION = null, API_VERSION = null;

function readVersions() {
  return Promise.all([
    fetch('/static/version.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (v) { return v.page || null; }).catch(function () { return null; }),
    fetch('api/version').then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (v) { return v.version && v.version !== 'unknown' ? v.version : null; })
      .catch(function () { return null; })
  ]);
}

function versionNote(what) {
  var n = document.getElementById('new-version');
  if (!n) {
    n = document.createElement('button');
    n.type = 'button';
    n.id = 'new-version';
    n.addEventListener('click', function () { location.reload(); });
    document.body.appendChild(n);
  }
  n.textContent = 'New ' + what + ' \u2014 reload';
}

readVersions().then(function (v) { PAGE_VERSION = v[0]; API_VERSION = v[1]; });
setInterval(function () {
  if (document.hidden) { return; }
  readVersions().then(function (v) {
    // A failed read is no news: only a real, different answer counts.
    var page = v[0] && PAGE_VERSION && v[0] !== PAGE_VERSION;
    var api = v[1] && API_VERSION && v[1] !== API_VERSION;
    if (page || api) { versionNote(page && api ? 'page and nav-api' : page ? 'page' : 'nav-api'); }
  });
}, 3 * 60000);
