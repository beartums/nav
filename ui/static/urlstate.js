// urlstate.js -- where you are, in the address bar: refresh keeps it, and a
// link opens the same place.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// early; everything here reads the other scripts' globals only when called.
//
// Query parameters only (no paths: Pomerium drops encoded slashes):
//   /?dashboard=5                         a dashboard (what tiles and text links use)
//   /?admin=templates&template=3          admin mode, a template
//   /?admin=access&view=apps&pivot=1      the Access page, App accounts, pivoted
//   /?admin=users&conn=plex               User management, the Plex connection
// The URL wins over this browser's remembered choices (nav.accessView, ...);
// those still apply when the URL says nothing. Moving somewhere new pushes a
// history entry (Back returns); a small toggle (pivot) replaces it.
'use strict';

// The place asked for when the page loaded, applied once nav-api has said
// whether this is an admin (urlStartApplied, from refresh()).
var URL_START = new URLSearchParams(location.search);
var URL_STARTED = false;
// While applying a URL (load, Back/Forward), moves don't write one of their own.
var URL_APPLYING = 0;
// The current admin page's own place, set by the page: {view, pivot} or {conn}.
var URL_PAGE = {};
// The admin page's names for its place, so a link carries only those.
var URL_PAGE_KEYS = ['view', 'pivot', 'conn'];

function urlFor() {
  var q = new URLSearchParams();
  if (ADMIN_MODE) {
    q.set('admin', ADMIN_TAB);
    if (ADMIN_TAB === 'templates' && ADMIN_TEMPLATE != null) { q.set('template', String(ADMIN_TEMPLATE)); }
    URL_PAGE_KEYS.forEach(function (k) {
      var v = URL_PAGE[k];
      if (v != null && v !== '' && v !== false) { q.set(k, v === true ? '1' : String(v)); }
    });
  } else if (!IMPERSONATING && USER_LAYOUT != null) {
    q.set('dashboard', String(USER_LAYOUT));
  }
  var s = q.toString();
  return location.pathname + (s ? '?' + s : '') + location.hash;
}

/** Write where we are into the address bar: push = a new history entry. */
function syncURL(push) {
  if (URL_APPLYING || !URL_STARTED) { return; }
  var u = urlFor();
  if (u === location.pathname + location.search + location.hash) { return; }
  try { history[push ? 'pushState' : 'replaceState'](null, '', u); } catch (e) { /* fine */ }
}

/** An admin page says where it is while drawing (showAdminTab writes the URL). */
function urlPageSet(place) {
  URL_PAGE = Object.assign({}, URL_PAGE, place);
}

/** An admin page records its own place (and writes the URL). */
function urlPage(place, push) {
  URL_PAGE = Object.assign({}, URL_PAGE, place);
  syncURL(push);
}

/** {view, pivot, conn} as the URL gives them. */
function urlPageWant(q) {
  var want = {};
  URL_PAGE_KEYS.forEach(function (k) { if (q.has(k)) { want[k] = q.get(k); } });
  return want;
}

function urlLayoutId(v) {
  return v == null || v === '' || v === 'default' ? null : /^\d+$/.test(v) ? Number(v) : null;
}

/** First answer from nav-api: open the admin place the URL names (true: the
 *  caller stops, setAdminMode() refreshes), else tidy the URL to what is shown
 *  -- a non-admin's ?admin= link just opens the dashboard. */
function urlStartApplied() {
  if (URL_STARTED) { return false; }
  URL_STARTED = true;
  var tab = URL_START.get('admin');
  if (tab && IS_ADMIN && !IMPERSONATING) {
    URL_APPLYING++;
    try {
      if (tab === 'templates' && URL_START.has('template')) { setAdminTemplate(urlLayoutId(URL_START.get('template'))); }
      setAdminMode(true, tab, urlPageWant(URL_START));
    } finally { URL_APPLYING--; }
    syncURL(false);
    return true;
  }
  syncURL(false);
  return false;
}

// Back / Forward: go where the URL now says. Leaving an admin page with
// unsaved changes asks first; staying puts the URL back.
window.addEventListener('popstate', function () {
  if (!URL_STARTED) { return; }
  var q = new URLSearchParams(location.search);
  var tab = q.get('admin');
  var stay = false;
  URL_APPLYING++;
  try {
    if (tab && IS_ADMIN && !IMPERSONATING) {
      var want = urlPageWant(q);
      var tpl = urlLayoutId(q.get('template'));
      if (!ADMIN_MODE) {
        if (tab === 'templates') { setAdminTemplate(tpl); }
        setAdminMode(true, tab, want);
      } else if (tab !== ADMIN_TAB) {
        if (adminLeaveOk()) {
          var newTpl = tab === 'templates' && tpl !== ADMIN_TEMPLATE;
          if (newTpl) { setAdminTemplate(tpl); }
          showAdminTab(tab, want);
          if (newTpl) { refresh(); }
        } else { stay = true; }
      } else if (tab === 'templates') {
        if (tpl !== ADMIN_TEMPLATE) { setAdminTemplate(tpl); refresh(); }
      } else if (ADMIN_HOST && ADMIN_HOST.onURL) {
        ADMIN_HOST.onURL(want);
      }
    } else {
      if (ADMIN_MODE) {
        if (adminLeaveOk()) { setAdminMode(false); } else { stay = true; }
      }
      if (!stay) {
        var id = urlLayoutId(q.get('dashboard'));
        if (id !== USER_LAYOUT && !IMPERSONATING) { openDashboard(id == null ? 'default' : id); }
      }
    }
  } finally { URL_APPLYING--; }
  // Stayed (unsaved changes), or the URL named somewhere we can't go: show
  // the real place again.
  var real = urlFor();
  if (real !== location.pathname + location.search + location.hash) {
    try { history[stay ? 'pushState' : 'replaceState'](null, '', real); } catch (e) { /* fine */ }
  }
});
