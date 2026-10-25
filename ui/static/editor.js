// editor.js -- The tile editor, icon handling, and the Site / About dialogs.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

// --- drag state -----------------------------------------------------
var DRAG = { slug: null, group: null };

// --- the editor ------------------------------------------------------
var editor = document.getElementById('editor');
var editorBody = document.getElementById('editor-body');
var EDITING = null;

function closeEditor() {
  document.body.classList.remove('editing');
  editor.classList.remove('wide');   // the widget designer widens it
  document.getElementById('editor-save').disabled = false;   // and may disable Save
  EDITING = null;
}
document.getElementById('editor-close').addEventListener('click', closeEditor);
document.getElementById('editor-cancel').addEventListener('click', closeEditor);
// Escape closes too, matching the menu.
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape' && EDITING) { closeEditor(); }
});

// Drag the dialog by its bar. Pointer events rather than mouse events so it
// works with a stylus or touch.
(function () {
  var bar = document.getElementById('editor-bar');
  var from = null;
  bar.addEventListener('pointerdown', function (ev) {
    // NOT when the press started on a control. setPointerCapture on the bar
    // redirects the pointerup to the bar, so the button inside it never
    // sees a click -- which is why the close X did nothing.
    if (ev.target.closest('button, input, select, a')) { return; }
    from = { x: ev.clientX, y: ev.clientY,
             left: editor.offsetLeft, top: editor.offsetTop };
    bar.setPointerCapture(ev.pointerId);
  });
  bar.addEventListener('pointermove', function (ev) {
    if (!from) { return; }
    // Clamped so the bar can never be dragged off-screen, which would leave
    // the dialog unmovable and unclosable on a small window.
    var x = Math.min(Math.max(0, from.left + ev.clientX - from.x), innerWidth - 80);
    var y = Math.min(Math.max(0, from.top + ev.clientY - from.y), innerHeight - 40);
    editor.style.left = x + 'px'; editor.style.top = y + 'px';
  });
  bar.addEventListener('pointerup', function (ev) {
    if (!from) { return; }
    from = null; bar.releasePointerCapture(ev.pointerId);
  });
})();

function field(label, value, placeholder) {
  var l = document.createElement('label');
  var t = document.createElement('span'); t.textContent = label;
  var i = document.createElement('input');
  i.type = 'text'; i.value = value || ''; i.placeholder = placeholder || '';
  i.className = i.value ? '' : 'inherited';
  i.addEventListener('input', function () { i.className = i.value ? '' : 'inherited'; });
  l.appendChild(t); l.appendChild(i);
  return { label: l, input: i };
}

// Each icon field carries its OWN preview and chooser, on its own line.
// Module scope, not nested in openEditor: the SITE dialog had its own
// hand-rolled version of this with one shared drop zone for both icons --
// the very thing the next sentence says does not work.
// A single shared drop zone answered "which field does this apply to?"
// with focus, which is invisible and guessable at best.
function iconRow(entry, fallback) {
  var input = entry.input;
  var pic = document.createElement('img');
  pic.style.cssText = 'width:28px; height:28px; object-fit:contain; flex:0 0 28px;';
  pic.alt = '';
  pic.onerror = function () { pic.style.visibility = 'hidden'; };
  function show(v) {
    var use = v || fallback;
    if (use && /^(https?:\/\/|data:image\/)/.test(use)) { pic.src = use; pic.style.visibility = ''; }
    else { pic.style.visibility = 'hidden'; }
  }
  show(input.value);

  var note = document.createElement('div');
  note.style.cssText = 'font-size:11px; color:var(--muted);';

  var picker = document.createElement('input');
  picker.type = 'file'; picker.accept = 'image/*'; picker.hidden = true;
  picker.addEventListener('change', function () {
    if (picker.files && picker.files[0]) { takeIcon(picker.files[0], input, note, show); }
  });
  var btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = 'Choose\u2026';
  btn.style.cssText = 'padding:5px 10px; font-size:12px; white-space:nowrap;';
  btn.addEventListener('click', function () { picker.click(); });

  var row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px; align-items:center;';
  input.style.flex = '1';
  input.addEventListener('input', function () { show(input.value.trim()); });
  // Pasting goes to whichever icon field has focus.
  input.addEventListener('focus', function () {
    PASTE_TARGET = { input: input, show: show, note: note };
  });
  row.addEventListener('dragover', function (ev) {
    ev.preventDefault(); row.style.outline = '2px dashed var(--accent)';
  });
  row.addEventListener('dragleave', function () { row.style.outline = ''; });
  row.addEventListener('drop', function (ev) {
    ev.preventDefault(); row.style.outline = '';
    var dt = ev.dataTransfer;
    if (dt.files && dt.files[0]) { takeIcon(dt.files[0], input, note, show); return; }
    var url = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (url) { input.value = url.trim(); input.className = ''; show(url.trim()); }
  });

  // appendChild REPARENTS: this moves the input out of the label on its
  // own. The explicit removeChild that used to follow therefore threw
  // NotFoundError -- the node was already gone -- and took every tile
  // click down with it, which is why the editor stopped opening.
  row.appendChild(pic); row.appendChild(input); row.appendChild(btn); row.appendChild(picker);
  entry.label.appendChild(row);
  entry.label.appendChild(note);
  return entry.label;
}

function openEditor(a, atX, atY) {
  EDITING = a.slug;
  PASTE_TARGET = null;
  var ov = OVERRIDES[a.slug] || {};
  // `base` arrives only when the server honoured include_hidden. Falling
  // back to the merged app keeps the editor usable instead of throwing on
  // `a.base.name` and showing nothing at all -- the placeholders are then
  // the current values rather than the seeded ones, which is a degraded
  // editor rather than no editor.
  var base = a.base || a;
  document.getElementById('editor-title').textContent = base.name || a.slug;
  document.getElementById('editor-note').textContent = '';
  editorBody.innerHTML = '';

  var f = {
    name: field('Name', ov.name, base.name || ''),
    description: field('Description', ov.description, base.description || ''),
    // A picker, not free text: an exact-string category means a typo
    // silently makes a second group that looks like the first.
    category: groupPicker('Category', ov.category, base.category || 'Other'),
    icon: field('Icon \u2014 dark mode', ov.icon, 'inherited'),
    icon_light: field('Icon \u2014 light mode', ov.icon_light, 'falls back to dark')
  };
  ['name', 'description', 'category'].forEach(function (k) {
    editorBody.appendChild(f[k].label);
  });

  editorBody.appendChild(iconRow(f.icon, a.icon));
  editorBody.appendChild(iconRow(f.icon_light, ov.icon || a.icon));

  var flags = document.createElement('div');
  flags.className = 'flags';
  flags.style.cssText = 'display:flex; gap:16px; align-items:center;';
  // Size: S is a square, icon over name, description on hover; M is the
  // usual tile; L has room for the whole description. Also set by dragging
  // a tile's corner in admin mode (group-grid.js).
  var sizeSel = document.createElement('select');
  sizeSel.id = 'editor-size';
  [['XS', 'Icon only'], ['S', 'Small \u2014 icon over name'], ['M', 'Medium (default)'], ['L', 'Large \u2014 full description']]
    .forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0]; opt.textContent = o[1];
      sizeSel.appendChild(opt);
    });
  // A span from a free page ("5x2") is offered as itself, so saving the
  // editor doesn't snap it back to a named size.
  if (ov.size && !/^(XS|S|M|L)$/.test(ov.size)) {
    var cust = document.createElement('option');
    cust.value = ov.size; cust.textContent = 'As resized (' + ov.size.replace('x', ' \u00d7 ') + ')';
    sizeSel.appendChild(cust);
  }
  sizeSel.value = ov.size || 'M';
  var sizeLab = document.createElement('label');
  sizeLab.textContent = 'Size';
  sizeLab.appendChild(sizeSel);
  editorBody.appendChild(sizeLab);

  var hid = checkbox('Hidden', !!ov.hidden);
  var abv = checkbox('Above the fold', !!ov.above_fold);
  abv.input.title = 'Stays visible when its group is collapsed.';
  flags.style.flexWrap = 'wrap';
  flags.appendChild(hid.label); flags.appendChild(abv.label);
  editorBody.appendChild(flags);

  // Colour (style.js): the theme colours or any; None is no colour.
  var colour = ov.colour || '';
  var cl = document.createElement('div');
  cl.className = 'editor-colour';
  var clLab = document.createElement('span');
  clLab.textContent = 'Colour';
  cl.appendChild(clLab);
  var clBtn = document.createElement('button');
  clBtn.type = 'button';
  clBtn.id = 'editor-colour';
  function showColour() {
    clBtn.textContent = colour || 'None';
    clBtn.style.background = colourMix(colour, 35, '--card') || '';
  }
  showColour();
  clBtn.addEventListener('click', function () {
    bgPicker(clBtn, colour ? { c: colour } : null, { title: 'Tile colour' }, function (bg) {
      colour = (bg && bg.c) || '';
      showColour();
    });
  });
  cl.appendChild(clBtn);
  editorBody.appendChild(cl);

  document.getElementById('editor-save').textContent = 'Save';
  document.getElementById('editor-save').onclick = function () {
    var fields = {};
    ['name', 'description', 'category', 'icon', 'icon_light'].forEach(function (k) {
      if (f[k].input.value.trim()) { fields[k] = f[k].input.value.trim(); }
    });
    if (hid.input.checked) { fields.hidden = true; }
    if (abv.input.checked) { fields.above_fold = true; }
    if (ov.order != null) { fields.order = ov.order; }   // keep position
    // ...and on a free page its cells and its group: the save REPLACES the
    // row, so whatever isn't carried over is lost (the tile would leave the page).
    if (ov.x != null) { fields.x = ov.x; }
    if (ov.y != null) { fields.y = ov.y; }
    if (/^fg:/.test(ov.category || '') && !fields.category) { fields.category = ov.category; }
    if (colour) { fields.colour = colour; }
    // The default is stored as no size, so a later change of default reaches
    // every tile nobody deliberately sized.
    if (sizeSel.value !== 'M') { fields.size = sizeSel.value; }
    var one = {}; one[a.slug] = fields;
    saveTiles(one)
      .then(function () { closeEditor(); refresh(); })
      .catch(function (e) { document.getElementById('editor-note').textContent = e.message; });
  };
  // Resetting lives in the body, not the footer. The footer is Cancel and
  // Save -- two actions people expect there -- and "Revert" sitting where
  // Cancel belongs read as "discard my edits" when it actually deletes
  // every stored override for the app.
  var reset = document.createElement('button');
  // On your own dashboard, "default" is the template it was copied from.
  reset.textContent = ownDashboard() ? 'Reset to the template' : 'Reset to seeded default';
  reset.style.cssText = 'background:none; border:0; padding:4px 0; text-align:left;' +
                        'color:var(--muted); text-decoration:underline; font-size:12px;';
  reset.title = ownDashboard()
    ? 'Forget your changes to this tile, so it is as the template has it. Not the same as Cancel.'
    : 'Delete every override for this app, so it falls back to what Terraform ' +
      'seeded in Authentik. Not the same as Cancel.';
  reset.addEventListener('click', function () {
    clearTile(a.slug)
      .then(function () { closeEditor(); refresh(); })
      .catch(function (e) { document.getElementById('editor-note').textContent = e.message; });
  });
  editorBody.appendChild(reset);

  document.body.classList.add('editing');
  editor.style.left = Math.min(atX, innerWidth - 350) + 'px';
  editor.style.top = Math.min(atY, innerHeight - 320) + 'px';
}

// Paste anywhere while the editor is open.
document.addEventListener('paste', function (ev) {
  if (!EDITING || !PASTE_TARGET) { return; }
  var items = (ev.clipboardData && ev.clipboardData.items) || [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image/') === 0) {
      takeIcon(items[i].getAsFile(), PASTE_TARGET.input, PASTE_TARGET.note, PASTE_TARGET.show);
      ev.preventDefault();
      return;
    }
  }
  var text = ev.clipboardData && ev.clipboardData.getData('text');
  if (text && /^https?:\/\//.test(text.trim())) {
    PASTE_TARGET.input.value = text.trim();
    PASTE_TARGET.input.className = '';
    if (PASTE_TARGET.show) { PASTE_TARGET.show(text.trim()); }
    ev.preventDefault();
  }
});

var PASTE_TARGET = null;

var ICON_CAP = 128 * 1024;
function takeIcon(file, input, statusEl, onSet) {
  readIcon(file, function (err, uri) {
    if (err) { if (statusEl) { statusEl.textContent = err; } return; }
    input.value = uri; input.className = '';
    if (onSet) { onSet(uri); }
    if (statusEl) {
      statusEl.textContent = 'Attached \u2014 ' + Math.round(uri.length / 1024) + ' KB. Save to apply.';
    }
  });
}

function readIcon(file, cb) {
  // SVG is kept as-is; rasterising it would be worse. Anything else is
  // drawn to a 128px canvas first -- an untouched phone photo is megabytes
  // and this value is fetched by every user on every page load.
  if (!file) { cb('nothing to read'); return; }
  if (file.type === 'image/svg+xml') {
    if (file.size > ICON_CAP) { cb('SVG is ' + Math.round(file.size / 1024) + ' KB; cap is 128 KB'); return; }
    var r = new FileReader();
    r.onload = function () { cb(null, r.result); };
    r.onerror = function () { cb('could not read the file'); };
    r.readAsDataURL(file);
    return;
  }
  var img = new Image();
  var url = URL.createObjectURL(file);
  img.onload = function () {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    var ctx = c.getContext('2d');
    var scale = Math.min(128 / img.width, 128 / img.height);
    var w = img.width * scale, h = img.height * scale;
    ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
    URL.revokeObjectURL(url);
    var out = c.toDataURL('image/png');
    if (out.length > ICON_CAP) { cb('still too large after downscaling'); return; }
    cb(null, out);
  };
  img.onerror = function () { URL.revokeObjectURL(url); cb('not a readable image'); };
  img.src = url;
}

function checkbox(label, checked) {
  var l = document.createElement('label');
  // display:flex explicitly: `#editor label` is display:grid, and a bare
  // flex-direction on a grid container is ignored -- which stacked the box
  // above its label instead of beside it.
  l.style.cssText = 'display:flex; flex-direction:row; align-items:center; gap:7px;';
  var i = document.createElement('input');
  i.type = 'checkbox'; i.checked = checked;
  var t = document.createElement('span'); t.textContent = label;
  l.appendChild(i); l.appendChild(t);
  return { label: l, input: i };
}

function applySite() {
  var name = SITE.title || 'nav';
  document.querySelector('h1').textContent = name;
  // The tab, not just the page. A renamed dashboard that still says "nav"
  // in the tab strip is half-renamed.
  document.title = name;

  var wantLight = window.matchMedia &&
                  window.matchMedia('(prefers-color-scheme: light)').matches;
  var ico = (wantLight && SITE.icon_light) ? SITE.icon_light : SITE.icon;
  if (!ico || !/^(https?:\/\/|data:image\/)/.test(ico)) { return; }

  var link = document.getElementById('favicon');
  if (link) { link.href = ico; }

  // Swap the inline SVG mark for the chosen image, once. Replacing the
  // node rather than hiding it keeps the header layout identical.
  var mark = document.getElementById('mark');
  if (mark && mark.tagName.toLowerCase() === 'svg') {
    var img = document.createElement('img');
    img.id = 'mark'; img.className = 'mark'; img.alt = '';
    img.style.objectFit = 'contain';
    img.onerror = function () { img.style.visibility = 'hidden'; };
    mark.parentNode.replaceChild(img, mark);
    mark = img;
  }
  if (mark) { mark.src = ico; }
}

// Re-evaluate icons when the system flips between light and dark, rather
// than only at load. Both the tiles and the branding depend on it.
if (window.matchMedia) {
  var mq = window.matchMedia('(prefers-color-scheme: light)');
  var onScheme = function () { applySite(); render(); };
  if (mq.addEventListener) { mq.addEventListener('change', onScheme); }
  else if (mq.addListener) { mq.addListener(onScheme); }
}

function aboutDialog() {
  EDITING = '__about__';
  PASTE_TARGET = null;
  document.getElementById('editor-title').textContent = 'About';
  document.getElementById('editor-note').textContent = '';
  editorBody.innerHTML = '';
  // Reuses the movable dialog rather than adding a second kind of window.
  document.getElementById('editor-save').textContent = 'Close';
  document.getElementById('editor-save').onclick = closeEditor;

  var box = document.createElement('div');
  box.style.cssText = 'font-size:13px; display:grid; gap:6px;';
  box.textContent = 'Loading\u2026';
  editorBody.appendChild(box);

  fetch('api/version').then(function (r) { return r.json(); }).then(function (v) {
    box.innerHTML = '';
    function line(k, val, title) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:10px;';
      var a = document.createElement('span');
      a.style.cssText = 'color:var(--muted); min-width:96px;';
      a.textContent = k;
      var b = document.createElement('span');
      b.textContent = val;
      if (title) { b.title = title; }
      row.appendChild(a); row.appendChild(b);
      box.appendChild(row);
    }

    // Short sha, full one on hover. Seven characters is enough to find a
    // commit and short enough to read aloud.
    line('Page', PAGE_VERSION || 'unknown', 'The build this page was loaded from');
    var sha = v.version && v.version !== 'unknown' ? v.version : '';
    line('API', sha ? sha.slice(0, 7) : 'unknown', sha || '');

    // The server sends UTC because it cannot know the reader's timezone.
    // Formatting happens here, where the browser does know.
    var when = 'unknown';
    var iso = v.built_at;
    if (iso && iso !== 'unknown') {
      var d = new Date(iso);
      when = isNaN(d.getTime()) ? iso : d.toLocaleString();
    }
    line('API built', when, iso || '');

    var note = document.createElement('div');
    note.style.cssText = 'color:var(--muted); font-size:11px; margin-top:6px;';
    // Said plainly: one number cannot cover both, and pretending otherwise
    // would make the version wrong every time the page alone changes.
    note.textContent = 'The page and nav-api ship separately: the page from a ConfigMap ' +
                       '(about a minute after a push), nav-api from an image CI builds.';
    box.appendChild(note);
  }).catch(function (e) {
    box.textContent = 'Could not read the version: ' + e.message;
  });

  document.body.classList.add('editing');
  editor.style.left = Math.max(12, innerWidth / 2 - 165) + 'px';
  editor.style.top = '90px';
}

function siteDialog() {
  EDITING = '__site__';
  PASTE_TARGET = null;
  document.getElementById('editor-title').textContent = 'Site';
  document.getElementById('editor-note').textContent = '';
  editorBody.innerHTML = '';

  var f = {
    title: field('Site name', SITE.title, 'nav'),
    icon: field('Site icon \u2014 dark mode', SITE.icon, 'the built-in mark'),
    icon_light: field('Site icon \u2014 light mode', SITE.icon_light, 'falls back to dark')
  };
  editorBody.appendChild(f.title.label);

  // The same iconRow() the tile editor uses: one preview, one Choose\u2026
  // and one drop target PER MODE. This dialog used to have a single shared
  // drop zone captioned "applies to the icon field you last clicked in",
  // which is the arrangement the tile editor abandoned -- the target was
  // focus, which is invisible, and pasting a light icon while the dark
  // field happened to hold focus quietly replaced the wrong one.
  editorBody.appendChild(iconRow(f.icon, ''));
  editorBody.appendChild(iconRow(f.icon_light, SITE.icon || ''));

  document.getElementById('editor-save').textContent = 'Save';
  document.getElementById('editor-save').onclick = function () {
    // One PUT per key, in parallel: site_settings is key-addressed and
    // three of them is not worth a bulk endpoint.
    Promise.all(['title', 'icon', 'icon_light'].map(function (k) {
      return api('PUT', 'api/site/' + k, { value: f[k].input.value.trim() || null });
    })).then(function () { closeEditor(); refresh(); })
      .catch(function (e) { document.getElementById('editor-note').textContent = e.message; });
  };

  document.body.classList.add('editing');
  editor.style.left = Math.max(12, innerWidth / 2 - 165) + 'px';
  editor.style.top = '90px';
}
document.getElementById('admin-site-btn').addEventListener('click', siteDialog);
// Also on the admin bar, not only inside Bulk edit. Creating a tile writes
// immediately rather than staging, so it never depended on being in the
// table -- and the table is not where anyone looks for "add a thing".
// newTileDialog is declared further down; function declarations hoist.
document.getElementById('admin-newtile-btn')
  .addEventListener('click', function () { newTileDialog(null); });
