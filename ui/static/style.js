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
  if (bg.img && /^https:\/\//.test(bg.img)) {
    var veil = 'color-mix(in srgb, var(' + surface + ') ' + Math.round(scrim * 100) + '%, transparent)';
    el.style.background = 'linear-gradient(' + veil + ', ' + veil + '), url("' + bg.img.replace(/"/g, '%22') +
                          '") center / cover no-repeat' + (base ? ', ' + base : '');
  } else if (base) {
    el.style.background = base;
  }
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
    lab.textContent = 'Image (https:// link)';
    var url = document.createElement('input');
    url.type = 'url';
    url.placeholder = 'https://…';
    url.value = cur.img || '';
    url.addEventListener('change', function () {
      var v = url.value.trim();
      if (v && !/^https:\/\//.test(v)) { url.setCustomValidity('An https:// link'); url.reportValidity(); return; }
      url.setCustomValidity('');
      cur = Object.assign({}, cur, { img: v || undefined });
      if (!cur.img) { delete cur.img; }
      onPick(cur.c || cur.img ? cur : null);
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
