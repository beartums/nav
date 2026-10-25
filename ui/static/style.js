// style.js -- backgrounds: the page's, a group's, a tile's colour (docs/free-layout.md).
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after layouts.js and before tiles.js.
//
// A colour is a THEME NAME, drawn from the series palette so it follows light
// and dark mode, or "#rrggbb". It is always MIXED into the surface it sits on
// (the card for tiles and groups, the page for the page), never painted at
// full strength: text stays legible on any choice. An image is an https URL
// to a picture hosted elsewhere; text over it gets a scrim of the page colour.
'use strict';

// layouts.py COLOURS, in that order: name -> palette slot.
var BG_COLOURS = ['blue', 'orange', 'green', 'amber', 'pink', 'leaf', 'violet', 'red'];

function colourVar(c) {
  var i = BG_COLOURS.indexOf(c);
  if (i >= 0) { return 'var(--series-' + (i + 1) + ')'; }
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c : null;
}

/** A colour mixed `pct`% into a surface variable, or null. */
function colourMix(c, pct, surface) {
  var v = colourVar(c);
  return v ? 'color-mix(in srgb, ' + v + ' ' + pct + '%, var(' + surface + '))' : null;
}

/** Paint a {c, img} background onto an element. `scrim`: how much of the
 *  surface lies over an image (0-1), so what sits on it stays readable. */
function paintBg(el, bg, pct, surface, scrim) {
  el.style.background = '';
  if (!bg) { return; }
  var base = colourMix(bg.c, pct, surface) || '';
  if (bg.img && imageUrlOk(bg.img)) {
    var veil = 'color-mix(in srgb, var(' + surface + ') ' + Math.round(scrim * 100) + '%, transparent)';
    el.style.background = 'linear-gradient(' + veil + ', ' + veil + '), url("' + bg.img.replace(/"/g, '%22') +
                          '") center / cover no-repeat' + (base ? ', ' + base : '');
  } else if (base) {
    el.style.background = base;
  }
}

/** An image a background may use: an https link, or one uploaded to nav. */
function imageUrlOk(u) { return /^https:\/\//.test(u || '') || /^api\/images\/[0-9a-f]{64}$/.test(u || ''); }

var IMG_LONG_SIDE = 2400;       // px: plenty for a background on a big screen

/** A picture made small enough to send: its longest side at most
 *  IMG_LONG_SIDE, re-encoded as JPEG. A phone photo is several MB and
 *  4000px; this makes it a few hundred KB, and the server's 3 MB cap is
 *  then a guard rather than a wall. Rejects what the browser can't decode. */
function shrinkImage(file) {
  var load = window.createImageBitmap ? createImageBitmap(file) : new Promise(function (ok, fail) {
    var img = new Image();
    img.onload = function () { ok(img); };
    img.onerror = function () { fail(new Error('this browser cannot read that picture')); };
    img.src = URL.createObjectURL(file);
  });
  return load.then(function (img) {
    var w = img.width, h = img.height, k = Math.min(1, IMG_LONG_SIDE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise(function (ok, fail) {
      c.toBlob(function (b) { if (b) { ok(b); } else { fail(new Error('could not encode the picture')); } },
               'image/jpeg', 0.85);
    });
  }, function () { throw new Error('this browser cannot read that picture (HEIC? save it as JPEG first)'); });
}

/** Upload a picture; resolves to its URL (api/images/<sha>). */
function uploadImage(file) {
  return shrinkImage(file).then(function (blob) {
    return fetch('api/images', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (b) {
      if (!r.ok) { throw new Error((b && typeof b.detail === 'string' && b.detail) || 'upload failed: ' + r.status); }
      return b.url;
    });
  });
}

/** The page's own background, from the layout on screen. */
function applyPageBg() {
  var bg = LAYOUT && LAYOUT.style && LAYOUT.style.bg;
  paintBg(document.body, bg || null, 14, '--bg', 0.55);
  if (bg && bg.img) { document.body.style.backgroundAttachment = 'fixed'; }
}

function savePageBg(bg) {
  LAYOUT.style = bg ? { bg: bg } : {};
  applyPageBg();
  return api('PUT', layoutPath('/style'), { bg: bg })
    .catch(function (e) { alert('Saving the background failed: ' + e.message); refresh(); });
}

/** A small picker by `anchor`: none, the theme colours, a custom one, and
 *  (opts.image) an image URL. Calls onPick(bg) with {c?, img?} or null as
 *  you choose -- each click is a choice; there is no Save. */
function bgPicker(anchor, cur, opts, onPick) {
  closeBgPicker();
  cur = cur || {};
  var box = document.createElement('div');
  box.className = 'bg-picker';
  box.id = 'bg-picker';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', opts.title || 'Background');
  var h = document.createElement('div');
  h.className = 'bg-picker-h';
  h.textContent = opts.title || 'Background';
  box.appendChild(h);
  var row = document.createElement('div');
  row.className = 'bg-swatches';
  function pick(c) {
    cur = Object.assign({}, cur, { c: c || undefined });
    if (!cur.c) { delete cur.c; }
    Array.prototype.forEach.call(row.children, function (b) { b.classList.toggle('on', (b.dataset.c || '') === (c || '')); });
    onPick(cur.c || cur.img ? cur : null);
  }
  [''].concat(BG_COLOURS).forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'bg-sw' + ((cur.c || '') === c ? ' on' : '');
    b.dataset.c = c;
    b.title = c || 'None';
    b.setAttribute('aria-label', c || 'No colour');
    if (c) { b.style.background = colourVar(c); } else { b.textContent = '∅'; }
    b.addEventListener('click', function () { pick(c); });
    row.appendChild(b);
  });
  var custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'bg-custom';
  custom.title = 'Any colour';
  custom.value = /^#/.test(cur.c || '') ? cur.c : '#888888';
  custom.addEventListener('change', function () { pick(custom.value.toLowerCase()); });
  row.appendChild(custom);
  box.appendChild(row);
  if (opts.image) {
    var lab = document.createElement('label');
    lab.className = 'bg-img';
    lab.textContent = 'Image — upload one, or an https:// link';
    var url = document.createElement('input');
    url.type = 'text';
    url.placeholder = 'https://…';
    url.value = cur.img || '';
    function setImg(v) {
      cur = Object.assign({}, cur, { img: v || undefined });
      if (!cur.img) { delete cur.img; }
      onPick(cur.c || cur.img ? cur : null);
    }
    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'bg-upload';
    up.textContent = 'Upload image…';
    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    var note = document.createElement('span');
    note.className = 'bg-note';
    up.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) { return; }
      up.disabled = true;
      note.textContent = 'Uploading…';
      uploadImage(f).then(function (u) {
        url.value = u;
        note.textContent = '';
        setImg(u);
      }).catch(function (e) { note.textContent = e.message; })
        .then(function () { up.disabled = false; file.value = ''; });
    });
    box.appendChild(up);
    box.appendChild(file);
    box.appendChild(note);
    url.addEventListener('change', function () {
      var v = url.value.trim();
      if (v && !imageUrlOk(v)) { url.setCustomValidity('An https:// link'); url.reportValidity(); return; }
      url.setCustomValidity('');
      setImg(v);
    });
    lab.appendChild(url);
    box.appendChild(lab);
  }
  document.body.appendChild(box);
  var r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
  box.style.top = (r.bottom + 6) + 'px';
  setTimeout(function () { document.addEventListener('mousedown', outside); }, 0);
  document.addEventListener('keydown', esc);
  function outside(ev) { if (!box.contains(ev.target) && ev.target !== anchor) { closeBgPicker(); } }
  function esc(ev) { if (ev.key === 'Escape') { closeBgPicker(); } }
  box._off = function () { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
  return box;
}

function closeBgPicker() {
  var b = document.getElementById('bg-picker');
  if (b) { if (b._off) { b._off(); } b.parentNode.removeChild(b); }
}

(function () {
  Array.prototype.forEach.call(document.querySelectorAll('.page-bg-btn'), function (b) {
    b.addEventListener('click', function () {
      bgPicker(b, LAYOUT && LAYOUT.style && LAYOUT.style.bg, { image: true, title: 'Page background' }, savePageBg);
    });
  });
})();
