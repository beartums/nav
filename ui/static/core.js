// core.js -- Page basics: the #out element, view options (localStorage) and the View menu.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// NO OIDC HERE ANY MORE.
//
// This page used to run a PKCE flow against Authentik and call its API with
// the resulting token. It does not, because nav is now a GATED Pomerium
// route: every request that reaches this page is already authenticated, and
// nav-api reads the user from Pomerium's claim header.
//
// What that removes: the code verifier, the callback handling, token
// refresh, and a client id in the page. What it costs is on the server --
// nav-api holds an Authentik admin token to do the per-user lookup. See
// api/app.py.
var out = document.getElementById('out');

// A SIGNED-OUT SESSION, told apart from a down nav-api.
//
// When Pomerium's session ends, every api/ request is redirected to
// authenticate.example.com. fetch() cannot follow a cross-origin redirect
// without CORS, so it failed as a network error -- shown as "Could not reach
// nav-api", which sent people looking at the server. With redirect:'manual'
// the redirect arrives as an opaque response instead, which is unambiguous.
// A 401 means the same. Only our own api/ calls are wrapped.
//
// Recovery is a reload: a page load can follow the redirect, and Authentik's
// session usually signs it straight back in. Done for the viewer when they
// come back to the tab -- unless something is being edited, when it waits for
// the banner's button rather than throw the edit away.
var SIGNED_OUT = false;
(function () {
  var real = window.fetch && window.fetch.bind(window);
  if (!real) { return; }
  window.fetch = function (url, o) {
    if (!/^\/?api\//.test(String(url))) { return real(url, o); }
    return real(url, Object.assign({ redirect: 'manual' }, o || {})).then(function (r) {
      if (r.type === 'opaqueredirect' || r.status === 401) {
        signedOut();
        var e = new Error('your sign-in has expired -- reload the page');
        e.signedOut = true;
        throw e;
      }
      return r;
    });
  };
})();

function busyEditing() {
  return (typeof arranging === 'function' && arranging()) || document.body.classList.contains('editing');
}

function signedOut() {
  if (SIGNED_OUT) { return; }
  SIGNED_OUT = true;
  var bar = document.getElementById('signedout');
  if (bar) { bar.hidden = false; }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !busyEditing()) { location.reload(); }
  });
}

document.getElementById('signedout-reload').addEventListener('click', function () { location.reload(); });

/** The words for a failed api/ call: a sign-out is not an outage. */
function apiFailure(e) {
  return e && e.signedOut ? 'Signed out — reload to sign in again' : 'Could not reach nav-api: ' + e.message;
}

// View options live in localStorage FOR NOW, deliberately.
//
// They belong in a profile -- profiles are central so a new device can pick
// or duplicate one, which is why nav has a database at all. Until the
// profile UI exists, per-device storage is the honest interim: it works, it
// is obviously temporary, and nothing has to be migrated except moving the
// same keys server-side.
var DEFAULTS = { group: 'on', sort: 'name', flow: 'row', collapse: 'off', target: '_blank' };
var opts = load();

function load() {
  var o = {};
  for (var k in DEFAULTS) { o[k] = DEFAULTS[k]; }
  try {
    var raw = localStorage.getItem('nav.view');
    if (raw) { var p = JSON.parse(raw); for (var j in p) { if (j in o) { o[j] = p[j]; } } }
  } catch (e) { /* private window, blocked storage: defaults are fine */ }
  return o;
}
function save() {
  try { localStorage.setItem('nav.view', JSON.stringify(opts)); } catch (e) {}
}

var CONTROLS = [
  { key:'group',    label:'Grouping',
    choices:[['on','By category'],['tabs','Tabbed'],['off','Ungrouped']] },
  { key:'sort',     label:'Sort',
    choices:[['name','Alphabetical'],['defined','As defined'],
             ['mine','Most used by me'],['all','Most used by everyone']] },
  { key:'flow',     label:'Fill',
    choices:[['row','Row first'],['col','Column first']] },
  { key:'target',   label:'Open in',
    choices:[['_blank','New tab'],['_self','This tab'],['window','New window'],
             ['split','Half-width window']] },
  { key:'collapse', label:'Tile size',
    choices:[['off','Icon and text'],['on','Icons only (hover to expand)']] }
];

var menuBtn = document.getElementById('menu-btn');
var menuList = document.getElementById('menu-list');

function labelFor(c) {
  for (var i = 0; i < c.choices.length; i++) {
    if (c.choices[i][0] === opts[c.key]) { return c.choices[i][1]; }
  }
  return '';
}

function buildMenu() {
  menuList.innerHTML = '';
  CONTROLS.forEach(function (c) {
    var li = document.createElement('li');
    li.className = 'has-sub';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'true');
    var t = document.createElement('span');
    // The current value on the parent row, so the menu answers "what is it
    // set to" without opening every submenu.
    t.textContent = c.label + ': ' + labelFor(c);
    var caret = document.createElement('span');
    caret.className = 'caret'; caret.textContent = '\u25b8';
    trigger.appendChild(t); trigger.appendChild(caret);
    li.appendChild(trigger);

    var sub = document.createElement('ul');
    sub.className = 'submenu';
    c.choices.forEach(function (ch) {
      var sli = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      var tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = opts[c.key] === ch[0] ? '\u2713' : '';
      var lbl = document.createElement('span');
      lbl.textContent = ch[1];
      b.appendChild(tick); b.appendChild(lbl);
      b.addEventListener('click', function () {
        opts[c.key] = ch[0];
        save();
        buildMenu();     // refresh ticks and the parent row's summary
        render();
        // Close on choose. Leaving it open means the menu covers the very
        // change it was used to make.
        closeMenu();
      });
      sli.appendChild(b);
      sub.appendChild(sli);
    });
    li.appendChild(sub);
    menuList.appendChild(li);
  });

  dashboardMenu(menuList);

  var sep0 = document.createElement('li');
  sep0.style.cssText = 'border-top:1px solid var(--line); margin:4px 0;';
  menuList.appendChild(sep0);
  var abtLi = document.createElement('li');
  var abtB = document.createElement('button');
  abtB.type = 'button';
  abtB.textContent = 'About\u2026';
  abtB.addEventListener('click', function () { closeMenu(); aboutDialog(); });
  abtLi.appendChild(abtB);
  menuList.appendChild(abtLi);

  // Same rule as the admin entry: the server decides, this only draws.
  if (MAY_IMPERSONATE) {
    var isep = document.createElement('li');
    isep.style.cssText = 'border-top:1px solid var(--line); margin:4px 0;';
    menuList.appendChild(isep);
    var ili = document.createElement('li');
    var ib = document.createElement('button');
    ib.type = 'button';
    ib.id = 'menu-impersonate';
    ib.textContent = 'View as\u2026';
    ib.addEventListener('click', function () { closeMenu(); impersonateDialog(); });
    ili.appendChild(ib);
    menuList.appendChild(ili);
  }

  // Admin entry last, and only when the SERVER says so. Hiding it is
  // presentation; /api/admin/* re-checks on every write.
  if (IS_ADMIN) {
    var sep = document.createElement('li');
    sep.style.cssText = 'border-top:1px solid var(--line); margin:4px 0;';
    menuList.appendChild(sep);
    var ali = document.createElement('li');
    var ab = document.createElement('button');
    ab.type = 'button';
    ab.textContent = 'Administration\u2026';
    ab.addEventListener('click', function () { closeMenu(); setAdminMode(!ADMIN_MODE); });
    ali.appendChild(ab);
    menuList.appendChild(ali);
  }
}

function closeMenu() {
  menuList.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

menuBtn.addEventListener('click', function (ev) {
  ev.stopPropagation();
  var open = menuList.hidden;
  menuList.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
});
// Click-away and Escape. Without these the menu is a trap on touch, where
// there is no hover to move off.
document.addEventListener('click', function (ev) {
  if (!menuList.hidden && !menuList.contains(ev.target) && ev.target !== menuBtn) {
    closeMenu();
  }
});
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && !menuList.hidden) { closeMenu(); menuBtn.focus(); }
});
