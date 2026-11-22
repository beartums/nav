// admin-pages.js -- administrative mode's tabs: Templates, Access, Site settings, Connections.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after editor.js (sitePage), connections.js and access.js, before main.js.
//
// Templates is the page itself, annotated: the tiles, the sidebar of groups and
// the template toolbar. The other tabs are full pages drawn in #adminpage in
// place of the tiles, each by a function that takes a host:
//   { body, note, save }   the page's content box, its status line, its button
'use strict';

var ADMIN_TAB = 'templates';
// A page with changes not yet saved: leaving it (another tab, Done, closing
// the window) asks first. Pages report it through their host's setDirty().
var ADMIN_DIRTY = false;
function adminLeaveOk() {
  if (!ADMIN_DIRTY) { return true; }
  if (!confirm('You have unsaved changes on this page. Leave without saving them?')) { return false; }
  ADMIN_DIRTY = false;
  return true;
}
window.addEventListener('beforeunload', function (e) {
  if (ADMIN_DIRTY && ADMIN_MODE) { e.preventDefault(); e.returnValue = ''; }
});
var ADMIN_PAGES = {
  access: { title: 'Access', draw: function (h) { accessPage(h); } },
  site: { title: 'Site settings', draw: function (h) { sitePage(h); } },
  connections: { title: 'Connections', draw: function (h) { connectionsPage(h); } }
};

function adminHost() {
  var save = document.getElementById('adminpage-save');
  // A fresh button each time: pages set onclick, and one left over from the
  // last tab must not fire on this one.
  var fresh = save.cloneNode(true);
  save.replaceWith(fresh);
  fresh.textContent = 'Save';
  fresh.disabled = false;
  fresh.hidden = false;
  fresh.onclick = null;
  var note = document.getElementById('adminpage-note');
  note.textContent = '';
  ADMIN_DIRTY = false;
  return { body: document.getElementById('adminpage-body'), note: note, save: fresh,
           setDirty: function (on) { ADMIN_DIRTY = !!on; } };
}

function showAdminTab(tab) {
  ADMIN_TAB = ADMIN_PAGES[tab] ? tab : 'templates';
  var page = ADMIN_PAGES[ADMIN_TAB];
  document.body.classList.toggle('admin-page', !!page);
  document.querySelectorAll('#admintabs [data-tab]').forEach(function (b) {
    b.setAttribute('aria-selected', String(b.dataset.tab === ADMIN_TAB));
  });
  var box = document.getElementById('adminpage');
  box.hidden = !page;
  PASTE_TARGET = null;
  if (!page) { return; }
  closeEditor();
  document.getElementById('adminpage-title').textContent = page.title;
  page.draw(adminHost());
}

document.getElementById('admintabs').addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-tab]');
  if (b && ADMIN_MODE && b.dataset.tab !== ADMIN_TAB && adminLeaveOk()) { showAdminTab(b.dataset.tab); }
});
