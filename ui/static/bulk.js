// bulk.js -- Bulk edit: staging, icon dialog, moves.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// --- bulk edit ------------------------------------------------------
// A table of every app with its fields exposed, edited in place. Nothing
// is written until Save: edits are staged into OVERRIDES (so the rest of
// the page already agrees with what you see) against a snapshot taken on
// entry, and Cancel puts the snapshot back and re-reads from the server.
// Save sends ONE transactional PUT of just the touched slugs.
//
// Icons are deliberately not here. They need a file picker, a preview and
// a drop target per mode, which is four controls in a table cell; they
// stay in the per-tile editor. The table shows the icon read-only so rows
// are still identifiable at a glance.
var BULK = { on: false, snapshot: null, dirty: {}, cats: null, catsBase: null, catsMoved: {} };

function bulkEnter() {
  BULK.on = true;
  BULK.dirty = {};
  // Deep copy. A shallow one shares the per-slug field objects, so Cancel
  // would restore a snapshot that had been edited along with the original.
  BULK.snapshot = JSON.parse(JSON.stringify(OVERRIDES));
  // Pin the heading order for the life of the session. categoriesOf()
  // falls back to first-seen order in APPS, so moving the first app into
  // another group made that group's heading jump to the top of the table
  // mid-drag. Group ORDER is the rail's job; this table only moves apps.
  BULK.cats = categoriesOf(APPS, true);
  BULK.catsBase = BULK.cats.slice();
  BULK.catsMoved = {};
  closeEditor();
  render();
}

function bulkExit(restore) {
  if (restore) { OVERRIDES = BULK.snapshot || {}; }
  BULK.on = false;
  BULK.dirty = {};
  BULK.snapshot = null;
  BULK.cats = null;
  BULK.catsBase = null;
  BULK.catsMoved = {};
  // refresh() rather than render(): staging mutates the app objects in
  // place for live preview, and only a re-read undoes that.
  refresh();
}

function bulkSave() {
  var slugs = Object.keys(BULK.dirty);
  var groups = bulkGroupsChanged();
  if (!slugs.length && !groups) { bulkExit(false); return; }

  // The app edits go first and go together (saveTiles), so that half is
  // all-or-nothing per layout. The heading order is a separate write and
  // cannot join that transaction, so a failure
  // between the two is possible and the message has to say so rather than
  // claim nothing was written.
  var wrote = false;
  var chain = Promise.resolve();
  if (slugs.length) {
    var payload = {};
    slugs.forEach(function (sl) { payload[sl] = OVERRIDES[sl] || {}; });
    chain = chain.then(function () {
      return saveTiles(payload)
        .then(function (r) { wrote = true; return r; });
    });
  }
  if (groups) {
    chain = chain.then(function () {
      return saveGroupsTo(BULK.cats, groupHiddenList());
    });
  }
  chain.then(function () { bulkExit(false); })
    .catch(function (e) {
      alert('Save failed: ' + e.message + (wrote
        ? '\n\nThe app changes were written; the group order was not.'
        : '\n\nNothing was written.'));
    });
}

// Both icons are editable here. A swatch is a button showing exactly what
// that theme will render -- dark plate with a light edge, light plate with
// a dark edge -- so a logo that only reads on one background is visible in
// the table rather than after it ships. Clicking one opens the picker.
function iconDialog(a, key, current, fallback, onApply) {
  var back = document.createElement('div');
  back.className = 'icondlg-back';
  back.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:60;' +
                       'display:flex; align-items:center; justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--card); color:var(--fg); border:1px solid var(--line);' +
                      'border-radius:10px; padding:16px; width:min(420px, 92vw);' +
                      'display:flex; flex-direction:column; gap:10px;';
  var h = document.createElement('strong');
  h.textContent = (key === 'icon' ? 'Dark mode icon' : 'Light mode icon') +
                  ' — ' + ((a.base || a).name || a.slug);
  box.appendChild(h);

  var prev = document.createElement('span');
  prev.className = 'swatch ' + (key === 'icon' ? 'dark' : 'light');
  prev.style.cssText = 'width:64px; height:64px; cursor:default; align-self:center;';
  var pimg = document.createElement('img');
  prev.appendChild(pimg);
  box.appendChild(prev);

  var note = document.createElement('div');
  note.style.cssText = 'font-size:11px; color:var(--muted); min-height:14px;';

  var input = document.createElement('input');
  input.type = 'text';
  input.value = current || '';
  input.placeholder = key === 'icon' ? 'URL or paste an image' : 'falls back to the dark icon';
  input.style.cssText = 'width:100%; padding:6px 8px; font:inherit; background:var(--bg);' +
                        'color:var(--fg); border:1px solid var(--line); border-radius:5px;';

  function show() {
    var v = input.value.trim() || fallback;
    if (v && /^(https?:\/\/|data:image\/)/.test(v)) { pimg.src = v; pimg.style.visibility = ''; }
    else { pimg.removeAttribute('src'); pimg.style.visibility = 'hidden'; }
  }
  pimg.onerror = function () { pimg.style.visibility = 'hidden'; };
  input.addEventListener('input', show);
  show();

  var picker = document.createElement('input');
  picker.type = 'file'; picker.accept = 'image/*'; picker.hidden = true;
  picker.addEventListener('change', function () {
    if (picker.files && picker.files[0]) { takeIcon(picker.files[0], input, note, show); }
  });
  var choose = document.createElement('button');
  choose.type = 'button'; choose.textContent = 'Choose…';
  choose.addEventListener('click', function () { picker.click(); });

  var drop = document.createElement('div');
  drop.style.cssText = 'display:flex; gap:8px; align-items:center;';
  drop.appendChild(input); drop.appendChild(choose); drop.appendChild(picker);
  drop.addEventListener('dragover', function (ev) {
    ev.preventDefault(); if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'copy'; }
    drop.style.outline = '2px dashed var(--accent)';
  });
  drop.addEventListener('dragleave', function () { drop.style.outline = ''; });
  drop.addEventListener('drop', function (ev) {
    ev.preventDefault(); drop.style.outline = '';
    var dt = ev.dataTransfer;
    if (dt.files && dt.files[0]) { takeIcon(dt.files[0], input, note, show); return; }
    var url = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (url) { input.value = url.trim(); show(); }
  });
  box.appendChild(drop);
  box.appendChild(note);

  function onPaste(ev) {
    var items = (ev.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        takeIcon(items[i].getAsFile(), input, note, show);
        ev.preventDefault();
        return;
      }
    }
  }
  document.addEventListener('paste', onPaste);

  var row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px; justify-content:flex-end;';
  var clear = document.createElement('button');
  clear.type = 'button'; clear.textContent = 'Clear';
  clear.style.marginRight = 'auto';
  var cancel = document.createElement('button');
  cancel.type = 'button'; cancel.textContent = 'Cancel';
  var apply = document.createElement('button');
  apply.type = 'button'; apply.textContent = 'Apply';
  row.appendChild(clear); row.appendChild(cancel); row.appendChild(apply);
  box.appendChild(row);

  function close() {
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('keydown', onKey);
    if (back.parentNode) { back.parentNode.removeChild(back); }
  }
  function onKey(ev) { if (ev.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey);
  // Apply only STAGES it, like every other cell in the table -- the Save
  // button is still the only thing that writes.
  apply.addEventListener('click', function () { onApply(input.value.trim()); close(); });
  clear.addEventListener('click', function () { onApply(''); close(); });
  cancel.addEventListener('click', close);
  back.addEventListener('click', function (ev) { if (ev.target === back) { close(); } });

  back.appendChild(box);
  document.body.appendChild(back);
  input.focus();
}

// Staging only: update the override and the merged model, touch nothing
// else. bulkTable's set() wraps this to repaint one row; the row drag
// wraps it to move many at once and then re-renders the whole table.
function bulkStage(a, key, v) {
  var base = a.base || a;
  var ov = OVERRIDES[a.slug] = Object.assign({}, OVERRIDES[a.slug] || {});
  var blank = v === '' || v === false || v == null || (typeof v === 'number' && isNaN(v));
  // A value identical to the seeded one is not an override. Storing it
  // anyway pins the app to today's Authentik value and it silently stops
  // tracking upstream renames.
  if (blank || (typeof v === 'string' && v === (base[key] || ''))) { delete ov[key]; }
  else { ov[key] = v; }
  a[key] = blank ? base[key] : v;
}

// Dropping a row stages a move; it does not write. Same contract as every
// other cell in this table -- Save is the only thing that writes.
function bulkMove(movedSlug, before, cat) {
  var moved = null;
  APPS.forEach(function (x) { if (x.slug === movedSlug) { moved = x; } });
  if (!moved || (before && before.slug === movedSlug)) { return; }
  var from = moved.category || 'Other';
  cat = cat || (before ? (before.category || 'Other') : from);

  var list = sorted(APPS.filter(function (x) { return (x.category || 'Other') === cat; }))
                 .filter(function (x) { return x.slug !== movedSlug; });
  var at = before ? list.indexOf(before) : -1;
  list.splice(at < 0 ? list.length : at, 0, moved);

  if (cat !== from) { bulkStage(moved, 'category', cat); }
  list.forEach(function (x, i) { bulkStage(x, 'order', i); });
  // Renumber the group it LEFT as well. Skipping this leaves a hole, and
  // the next drop into that group inherits the gap and lands wrong.
  if (cat !== from) {
    sorted(APPS.filter(function (x) { return (x.category || 'Other') === from; }))
      .forEach(function (x, i) { bulkStage(x, 'order', i); });
  }
  buildGroups();   // the rail shows per-group counts; a move changes two
  render();
}

function bulkGroupsChanged() {
  return !!(BULK.cats && BULK.catsBase &&
            JSON.stringify(BULK.cats) !== JSON.stringify(BULK.catsBase));
}

// Reordering headings is staged too, so the table has ONE Save. It writes
// the layout's group order, which is the same value the rail edits -- the two are
// different editors for the same value, not two orderings.
function bulkMoveGroup(moved, target, placeAfter) {
  var list = (BULK.cats || []).filter(function (c) { return c !== moved; });
  var at = target ? list.indexOf(target) : -1;
  if (at < 0) { at = list.length; } else if (placeAfter) { at += 1; }
  list.splice(at, 0, moved);
  BULK.cats = list;
  BULK.catsMoved[moved] = 1;
  // Restoring the original order leaves nothing staged, so drop the marks
  // with it -- otherwise a heading stays flagged after being put back.
  if (!bulkGroupsChanged()) { BULK.catsMoved = {}; }
  buildGroups();
  render();
}
