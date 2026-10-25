// tiles.js -- Tiles: sorting, rendering one tile, opening, reordering, the grid.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

var APPS = [];

function sorted(list) {
  var copy = list.slice();
  // Admin mode ALWAYS sorts by position, whatever the viewer's sort is.
  // Dragging sets `order`; under any other sort the render that follows
  // re-sorts by name or clicks and the tile snaps straight back to where
  // it was. The write succeeded, the payload was right, and the drag
  // looked completely broken -- reported three times before anyone
  // thought to check the sort. Reordering only means anything here.
  if (arranging() || opts.sort === 'defined') {
    // Explicit positions first, in order; anything never dragged falls to
    // the end alphabetically rather than to an arbitrary spot.
    copy.sort(function (a, b) {
      var ao = a.order == null ? Infinity : a.order;
      var bo = b.order == null ? Infinity : b.order;
      return (ao - bo) || a.name.localeCompare(b.name);
    });
  } else if (opts.sort === 'mine') {
    copy.sort(function (a, b) { return (b.clicks_mine - a.clicks_mine) || a.name.localeCompare(b.name); });
  } else if (opts.sort === 'all') {
    copy.sort(function (a, b) { return (b.clicks_all - a.clicks_all) || a.name.localeCompare(b.name); });
  } else {
    copy.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  return copy;
}

/** An app's icon element: its own icon (light or dark), else icons/<slug>.svg,
 *  else its first letter. Shared by tiles and the widgets panel. */
function tileIcon(a) {
  // meta_icon wins only when absolute: Authentik serves uploaded icons as
  // /media/... paths, which resolve against nav's origin and 404.
  // Dark is the stored `icon` -- every existing value is one -- and light
  // falls back to it, so an app with a single icon needs no second field.
  var wantLight = window.matchMedia &&
                  window.matchMedia('(prefers-color-scheme: light)').matches;
  var chosen = (wantLight && a.icon_light) ? a.icon_light : a.icon;

  // data: MUST be accepted here. Uploaded icons are stored as data URIs, and
  // an http-only test silently fell them back to icons/<slug>.svg -- so an
  // upload appeared to do nothing while having saved perfectly.
  //
  // Scoped to data:image/ rather than bare data:, and safe in an <img>:
  // scripts inside an SVG do not execute when it is loaded as an image.
  var src = (chosen && /^(https?:\/\/|data:image\/)/.test(chosen))
              ? chosen
              : 'icons/' + a.slug + '.svg';
  var img = document.createElement('img');
  img.className = 'icon'; img.alt = ''; img.loading = 'lazy'; img.src = src;
  img.onerror = function () {
    var f = document.createElement('div');
    f.className = 'icon letter';
    f.textContent = (a.name || a.slug || '?').charAt(0);
    if (img.parentNode) { img.parentNode.replaceChild(f, img); }
  };
  return img;
}

function tile(a, o) {
  o = o || {};
  var li = document.createElement('li');
  var link = document.createElement('a');
  // `added` comes from the server: a tile the chosen groups grant that
  // the chosen person does not already have. The delta is the answer.
  link.className = a.added ? 'app added' : 'app';
  link.href = a.url;
  link.rel = 'noopener';
  var mode = opts.target;

  if (mode === 'window' || mode === 'split') {
    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      count(a.slug);
      openWindow(a.url, mode === 'split');
    });
  } else {
    link.target = mode;
    link.addEventListener('click', function () { count(a.slug); });
  }

  link.appendChild(tileIcon(a));
  // Its colour and picture (style.js): the colour mixed into the card, the
  // picture under a veil of it, so the name stays readable on either.
  if (a.colour || a.image) {
    paintBg(link, { c: a.colour, img: a.image }, 22, '--card', 0.62);
    if (a.colour) { link.style.borderColor = colourMix(a.colour, 45, '--card'); }
  }

  var text = document.createElement('div');
  text.className = 'text';
  var n = document.createElement('div');
  n.className = 'name'; n.textContent = a.name || a.slug;
  text.appendChild(n);
  if (a.description) {
    var d = document.createElement('div');
    d.className = 'desc'; d.textContent = a.description;
    text.appendChild(d);
  }
  // On the whole tile, so a collapsed (icons-only) tile still explains
  // itself on hover -- which is the mode where the label is not visible.
  link.title = a.description ? (a.name + ' \u2014 ' + a.description) : (a.name || a.slug);
  link.appendChild(text);
  link.dataset.host = hostOf(a.url);
  paintHealth(link);
  li.appendChild(link);

  // In admin mode a tile is an editing target, not a link. Navigating away
  // from the page you are arranging would be the wrong default.
  //
  // Attached AFTER the icon and label are built, not instead of them: an
  // earlier version returned here first and every admin tile was an empty
  // box. The listener below runs before the navigation one and cancels it.
  if (arranging()) {
    // The href goes entirely. preventDefault only stops a plain click --
    // middle-click, ctrl-click and "open in new tab" all still navigated,
    // which is the last thing wanted while arranging the page.
    link.removeAttribute('href');
    link.removeAttribute('target');
    link.style.cursor = 'pointer';
    link.draggable = true;
    link.addEventListener('click', function (ev) {
      ev.preventDefault();
      openEditor(a, ev.clientX + 12, ev.clientY + 12);
    });
    link.addEventListener('dragstart', function (ev) {
      DRAG.slug = a.slug;
      // A dragend that never fired must not linger.
      DRAG.group = null; DRAG.widget = null; DRAG.def = null;
      link.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', a.slug);
    });
    link.addEventListener('dragend', function () {
      DRAG.slug = null; link.classList.remove('dragging');
      Array.prototype.forEach.call(document.querySelectorAll('.dropbefore'),
        function (n) { n.classList.remove('dropbefore'); });
    });
    // In the shared group grid (group-grid.js) the GRID is the drop target,
    // for tiles and widgets alike; these per-tile handlers would double up.
    if (o.unified) { return li; }
    // dragenter AND dragover both preventDefault. dragover alone is what
    // the spec describes, but Chrome will not treat an element as a drop
    // target unless dragenter is cancelled too -- and the failure is
    // silent: the drag runs, nothing accepts it, no drop event fires.
    li.addEventListener('dragenter', function (ev) {
      if (!DRAG.slug || DRAG.slug === a.slug) { return; }
      ev.preventDefault();
    });
    li.addEventListener('dragover', function (ev) {
      if (!DRAG.slug || DRAG.slug === a.slug) { return; }
      ev.preventDefault();
      // dragstart set effectAllowed='move'; without a matching dropEffect
      // the browser can compute 'none' and reject the drop having shown a
      // perfectly normal drag cursor the whole way.
      if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'move'; }
      li.classList.add('dropbefore');
    });
    li.addEventListener('dragleave', function (ev) {
      // dragleave also fires moving onto a CHILD of this li -- the <a>
      // fills it -- so only clear when the pointer has actually left.
      if (ev.relatedTarget && li.contains(ev.relatedTarget)) { return; }
      li.classList.remove('dropbefore');
    });
    li.addEventListener('drop', function (ev) {
      li.classList.remove('dropbefore');
      if (!DRAG.slug || DRAG.slug === a.slug) { return; }
      ev.preventDefault();
      reorder(DRAG.slug, a);
    });
  }

  return li;
}

// --- is it up? ------------------------------------------------------------------
//
// nav-api probes each app's backend every minute (api/health.py); the
// page only asks for its own tiles' hosts. A tile that is DOWN fades and
// carries a red dot; UNKNOWN (no route to check) a grey one; UP shows nothing
// -- forty green dots are noise nobody reads. The reason is in the tooltip
// and the label, never the colour alone.

var HEALTH = {};        // host -> {state, detail, at}
var HEALTH_EVERY = 60000;

function hostOf(url) {
  try { return new URL(url, location.href).host.toLowerCase(); } catch (e) { return ''; }
}

function healthWords(h) {
  if (h.state === 'down') { return 'Down: ' + h.detail; }
  if (h.state === 'unknown') { return 'Status unknown: ' + h.detail; }
  var ago = h.at ? Math.max(0, Math.round(Date.now() / 1000 - h.at)) : null;
  return 'Up' + (ago != null ? ' (checked ' + (ago < 90 ? ago + 's' : Math.round(ago / 60) + 'm') + ' ago)' : '');
}

function paintHealth(link) {
  var h = HEALTH[link.dataset.host];
  link.classList.remove('health-down', 'health-unknown');
  var dot = link.querySelector('.h-dot');
  if (!h || h.state === 'up') {
    if (dot) { dot.parentNode.removeChild(dot); }
    if (h) { link.dataset.health = healthWords(h); } else { delete link.dataset.health; }
    return;
  }
  link.classList.add('health-' + h.state);
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'h-dot';
    link.appendChild(dot);
  }
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', healthWords(h));
  dot.title = healthWords(h);
  link.dataset.health = healthWords(h);
}

function loadHealth() {
  var hosts = {};
  APPS.forEach(function (a) { var h = hostOf(a.url); if (h) { hosts[h] = true; } });
  var list = Object.keys(hosts);
  if (!list.length) { return Promise.resolve(); }
  return fetch('api/health?' + list.map(function (h) { return 'host=' + encodeURIComponent(h); }).join('&'))
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (got) {
      // A failed check changes nothing: no answer is not "down".
      if (!got || !got.hosts) { return; }
      HEALTH = got.hosts;
      Array.prototype.forEach.call(document.querySelectorAll('a.app[data-host]'), paintHealth);
    });
}

function openWindow(url, split) {
  // "Split" is an APPROXIMATION and cannot be more than that: a script may
  // only move or resize a window it opened itself, so nav's own window
  // stays where it is. What this does is put the app in a half-width window
  // against the right edge, which lands correctly when nav is maximised --
  // the case it is actually for.
  var feat = 'noopener';
  if (split && window.screen && screen.availWidth) {
    var w = Math.floor(screen.availWidth / 2);
    // Parenthesised: `'left=' + a + b` concatenates left to right and
    // would emit left=0640 rather than left=640.
    feat += ',width=' + w + ',height=' + screen.availHeight +
            ',left=' + ((screen.availLeft || 0) + w) +
            ',top=' + (screen.availTop || 0);
  } else {
    feat += ',width=1280,height=900';
  }
  window.open(url, '_blank', feat);
}

function reorder(movedSlug, before) {
  // Renumber the WHOLE destination category, not just the two tiles that
  // moved: positions only mean anything relative to each other, and
  // patching one leaves gaps and ties that the next drag inherits.
  var cat = before.category || 'Other';
  // sorted() FIRST. APPS is in whatever order the API returned; the grid
  // shows sorted(byCat[c]). Renumbering the raw filter assigns positions
  // along a sequence nobody has ever seen, so dropping one tile silently
  // rewrote the order of every other tile in the category -- "I moved the
  // 12th to 2nd and the old 2nd went somewhere random". It did not go
  // anywhere random; it went to its index in the API response.
  var list = sorted(APPS.filter(function (x) { return (x.category || 'Other') === cat; }))
                 .filter(function (x) { return x.slug !== movedSlug; });
  var moved = APPS.filter(function (x) { return x.slug === movedSlug; })[0];
  if (!moved) { return; }
  var at = list.indexOf(before);
  list.splice(at < 0 ? list.length : at, 0, moved);

  var payload = {};
  list.forEach(function (x, i) {
    var f = Object.assign({}, OVERRIDES[x.slug] || {}, { order: i });
    // Moving a tile into a category is also a category change.
    if (x.slug === movedSlug) { f.category = cat; }
    payload[x.slug] = f;
    // Apply locally FIRST. /api/apps makes two Authentik calls, so waiting
    // for the round trip before redrawing is a visible hesitation after
    // every drop. The server is still the authority -- a failure re-reads.
    OVERRIDES[x.slug] = f;
    x.order = i;
    if (x.slug === movedSlug) { x.category = cat; }
  });
  render();
  saveTiles(payload)
    .catch(function (e) { alert('Reorder failed: ' + e.message); refresh(); });
}

function count(slug) {
  // Fire and forget: a failed counter must never delay or block the click
  // it is counting. keepalive so it survives the navigation.
  try {
    fetch('api/apps/' + encodeURIComponent(slug) + '/click',
          { method: 'POST', keepalive: true });
  } catch (e) {}
}

function grid(list) {
  var ul = document.createElement('ul');
  ul.className = 'tiles';
  if (opts.collapse === 'on') { ul.className = 'tiles collapsed'; }
  else if (opts.flow === 'col') {
    ul.className = 'tiles colfirst';
    // grid-auto-flow: column needs a row count or everything lands in one
    // row. Roughly square, which is what "column first" is asked for.
    ul.style.gridTemplateRows = 'repeat(' + Math.ceil(Math.sqrt(list.length)) + ', auto)';
  }
  list.forEach(function (a) { ul.appendChild(tile(a)); });
  return ul;
}
