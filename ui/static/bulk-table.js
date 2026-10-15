// bulk-table.js -- The bulk-edit table.
//
// One of nav's page scripts, split out of index.html on 2026-10-10. These are
// CLASSIC scripts, not modules: top-level names are shared page globals, so
// the <script> order in index.html is load order and matters. jsdom (the
// test harness) cannot run type=module, which is why.
'use strict';

function bulkTable() {
  var frag = document.createDocumentFragment();

  var bar = document.createElement('div');
  bar.className = 'bulkbar';
  var count = document.createElement('span');
  count.className = 'pending';
  var save = document.createElement('button');
  save.id = 'bulk-save'; save.textContent = 'Save';
  var cancel = document.createElement('button');
  cancel.id = 'bulk-cancel'; cancel.textContent = 'Cancel';
  function status() {
    var n = Object.keys(BULK.dirty).length;
    var g = bulkGroupsChanged();
    var bits = [];
    if (n) { bits.push(n + (n === 1 ? ' app' : ' apps')); }
    if (g) { bits.push('the group order'); }
    count.textContent = bits.length ? bits.join(' and ') + ' changed, not yet saved' : '';
    save.disabled = !n && !g;
  }
  save.addEventListener('click', bulkSave);
  cancel.addEventListener('click', function () { bulkExit(true); });
  var add = document.createElement('button');
  add.id = 'bulk-add'; add.textContent = '+ New tile';
  add.title = 'A link to something that is not an Authentik application';
  // NOT `addEventListener('click', newTileDialog)` -- that hands the
  // MouseEvent to the `existing` parameter, so New opens in edit mode for
  // an event object: the slug field fills with the string "undefined"
  // and, because editing pins the slug, stops tracking the name.
  add.addEventListener('click', function () { newTileDialog(null); });
  bar.appendChild(save); bar.appendChild(cancel); bar.appendChild(add);
  bar.appendChild(count);
  frag.appendChild(bar);

  // Anything created since entry is appended rather than sorted in, so
  // the table never reorders itself under the person editing it.
  var cats = (BULK.cats || []).slice();
  categoriesOf(APPS, true).forEach(function (c) {
    if (cats.indexOf(c) < 0) { cats.push(c); }
  });
  // Write the merged list back: it is the staged order from here on, so a
  // group that appeared mid-session keeps its place across the next drag.
  BULK.cats = cats;

  var wrap = document.createElement('div');
  wrap.className = 'bulkwrap';
  var t = document.createElement('table');
  t.className = 'bulk';
  var thead = document.createElement('thead');
  var hr = document.createElement('tr');
  // No Group column. Membership is expressed by which section a row sits
  // in, and moving between sections is what the drag handle is for --
  // a text field that has to agree with the row's position is a second
  // source of truth and one of them is always wrong.
  ['', '', 'Name', 'Description', 'Icons', 'Pos', 'Above fold', 'Hidden', ''].forEach(function (h) {
    var th = document.createElement('th'); th.textContent = h; hr.appendChild(th);
  });
  thead.appendChild(hr); t.appendChild(thead);
  var tb = document.createElement('tbody');

  function value(a, key) {
    var ov = OVERRIDES[a.slug] || {};
    if (ov[key] != null) { return ov[key]; }
    var base = a.base || a;
    return base[key];
  }

  // Diff against the SNAPSHOT, not against the seeded value. "Changed"
  // here means "changed since you opened this table" -- an override that
  // was already stored last week is not a pending edit, and marking it as
  // one makes the highlight useless for finding what you just did.
  function changedKeys(a) {
    var now = OVERRIDES[a.slug] || {};
    var was = (BULK.snapshot || {})[a.slug] || {};
    var keys = {};
    Object.keys(now).forEach(function (k) { keys[k] = 1; });
    Object.keys(was).forEach(function (k) { keys[k] = 1; });
    return Object.keys(keys).filter(function (k) {
      return JSON.stringify(now[k]) !== JSON.stringify(was[k]);
    });
  }

  // Recompute from the snapshot rather than latching. Typing a value and
  // typing it back should leave no trace -- a one-way dirty flag would
  // keep the app in the Save payload and rewrite it for no reason.
  function paint(a, row) {
    var chg = {};
    changedKeys(a).forEach(function (k) { chg[k] = 1; });
    Object.keys(row._ctl).forEach(function (k) {
      row._ctl[k].classList.toggle('chg', !!chg[k]);
    });
    var any = Object.keys(chg).length > 0;
    row.classList.toggle('dirty', any);
    if (any) { BULK.dirty[a.slug] = true; } else { delete BULK.dirty[a.slug]; }
    status();
  }

  function set(a, key, v, row) {
    bulkStage(a, key, v);
    paint(a, row);
  }

  function text(a, key, row) {
    var i = document.createElement('input');
    i.type = 'text';
    i.value = value(a, key) == null ? '' : value(a, key);
    // `change`, not `input`: staging on every keystroke marks a row dirty
    // the moment it is focused and typed into, including edits backed out
    // before leaving the cell.
    i.addEventListener('change', function () { set(a, key, i.value.trim(), row); });
    row._ctl[key] = i;
    var td = document.createElement('td'); td.appendChild(i); return td;
  }

  function flag(a, key, row) {
    var i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!value(a, key);
    i.addEventListener('change', function () { set(a, key, i.checked, row); });
    row._ctl[key] = i;
    var td = document.createElement('td'); td.appendChild(i); return td;
  }

  function swatch(a, key, row) {
    var sw = document.createElement('span');
    sw.className = 'swatch ' + (key === 'icon' ? 'dark' : 'light');
    sw.setAttribute('role', 'button');
    sw.tabIndex = 0;
    var img = document.createElement('img');
    var empty = document.createElement('span');
    empty.className = 'none'; empty.textContent = 'none';
    sw.appendChild(img); sw.appendChild(empty);

    function draw() {
      // The light swatch inherits the dark icon when it has none of its
      // own, because that is exactly what the page does at render time.
      var own = value(a, key);
      var shown = own || (key === 'icon_light' ? value(a, 'icon') : '');
      sw.title = (key === 'icon' ? 'Dark mode icon' : 'Light mode icon') +
                 (own ? '' : shown ? ' (inherited from the dark icon)' : ' (none set)') +
                 ' — click to change';
      if (shown && /^(https?:\/\/|data:image\/)/.test(shown)) {
        img.src = shown; img.hidden = false; empty.hidden = true;
      } else {
        img.removeAttribute('src'); img.hidden = true; empty.hidden = false;
      }
    }
    img.onerror = function () { img.hidden = true; empty.hidden = false; };
    draw();

    function open() {
      iconDialog(a, key, value(a, key) || '',
        key === 'icon_light' ? (value(a, 'icon') || '') : '',
        function (v) {
          set(a, key, v, row);
          draw();
          // The dark icon is the light one's fallback, so changing it
          // changes what the light swatch shows too.
          if (key === 'icon' && row._redrawLight) { row._redrawLight(); }
        });
    }
    sw.addEventListener('click', open);
    sw.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
    row._ctl[key] = sw;
    return { el: sw, draw: draw };
  }

  // --- row drag ------------------------------------------------------
  // The grip is the draggable element, not the row: a draggable <tr> makes
  // every text cell in it a drag source, so selecting text in Name starts
  // a drag instead. dragstart bubbles from the grip, so the row is still
  // what moves.
  // The SHARED DRAG, not a local one. The sidebar's drop handlers read
  // DRAG, so a row dragged out of this table has to announce itself the
  // same way a tile does -- otherwise the rail simply ignores it.
  function clearMarks() {
    [].forEach.call(tb.querySelectorAll('.dropbefore, .dropinto, .dropafter'), function (el) {
      el.classList.remove('dropbefore', 'dropinto', 'dropafter');
    });
  }
  // A heading accepts BOTH: an app dropped on it joins that group, a
  // heading dropped on it reorders the headings. DROP says which is in
  // flight, so the two sets of handlers never both fire.
  function dropTarget(el, before, cat) {
    el.addEventListener('dragenter', function (ev) {
      if (!DRAG.slug) { return; }
      ev.preventDefault();
    });
    el.addEventListener('dragover', function (ev) {
      if (!DRAG.slug || (before && before.slug === DRAG.slug)) { return; }
      ev.preventDefault();
      if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'move'; }
      clearMarks();
      el.classList.add(before ? 'dropbefore' : 'dropinto');
    });
    el.addEventListener('drop', function (ev) {
      if (!DRAG.slug || (before && before.slug === DRAG.slug)) { return; }
      ev.preventDefault();
      clearMarks();
      var slug = DRAG.slug;
      DRAG.slug = null;
      bulkMove(slug, before, cat);
    });
  }

  // `after` is why app rows take group drops too. A heading dropped on a
  // heading always lands BEFORE it, which leaves no way to move a group to
  // the end -- there is no heading below the last one to aim at. Dragging
  // it down onto any row of the last group puts it after that group.
  function groupDropTarget(el, cat, after) {
    el.addEventListener('dragenter', function (ev) {
      if (!DRAG.group) { return; }
      ev.preventDefault();
    });
    el.addEventListener('dragover', function (ev) {
      if (!DRAG.group || DRAG.group === cat) { return; }
      ev.preventDefault();
      if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'move'; }
      clearMarks();
      el.classList.add(after ? 'dropafter' : 'dropbefore');
    });
    el.addEventListener('drop', function (ev) {
      if (!DRAG.group || DRAG.group === cat) { return; }
      ev.preventDefault();
      clearMarks();
      var g = DRAG.group;
      DRAG.group = null;
      bulkMoveGroup(g, cat, after);
    });
  }

  cats.forEach(function (c) {
    var inCat = filtered(sorted(APPS.filter(function (x) {
      return (x.category || 'Other') === c;
    })));
    // A heading with no matches is noise while searching, but an empty
    // group with no search is a real drop target and has to stay.
    if (SEARCH && !inCat.length) { return; }
    var gr = document.createElement('tr');
    gr.className = 'grp';
    gr.dataset.cat = c;

    var ggrip = document.createElement('td');
    ggrip.className = 'grip';
    ggrip.textContent = '\u2261';
    ggrip.title = 'Drag to reorder the groups';
    ggrip.draggable = true;
    ggrip.addEventListener('dragstart', function (ev) {
      DRAG.group = c; DRAG.slug = null;
      gr.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', c);
      if (ev.dataTransfer.setDragImage) { ev.dataTransfer.setDragImage(gr, 10, 10); }
    });
    ggrip.addEventListener('dragend', function () {
      DRAG.group = null;
      gr.classList.remove('dragging');
      clearMarks();
    });
    // Mark the heading that was DRAGGED, not every heading whose index
    // shifted -- moving one to the top changes the index of everything
    // below it, and flagging all of them says nothing about what you did.
    if (BULK.catsMoved[c]) { ggrip.classList.add('chg'); }
    gr.appendChild(ggrip);

    var gtd = document.createElement('td');
    gtd.colSpan = 8;
    var gchev = document.createElement('span');
    gchev.className = 'chev';
    gchev.textContent = '\u25be';
    gchev.style.cssText = 'display:inline-block; width:14px;' +
                          (collapsed[c] ? ' transform:rotate(-90deg);' : '');
    gtd.appendChild(gchev);
    gtd.appendChild(document.createTextNode(c));
    gtd.style.cursor = 'pointer';
    gtd.setAttribute('role', 'button');
    gtd.setAttribute('aria-expanded', String(!collapsed[c]));
    gtd.addEventListener('click', function () {
      collapsed[c] = !collapsed[c];
      saveCollapsed();     // the same per-device state the dashboard uses
      render();
    });
    gr.appendChild(gtd); tb.appendChild(gr);
    // Dropping on the heading puts the row at the END of that group, and
    // is the only way into a group that is currently empty.
    dropTarget(gr, null, c);
    groupDropTarget(gr, c, false);
    if (collapsed[c]) {
      // Count only when there is something folded away, so the heading
      // says what it is hiding. The heading is still a drop target, so a
      // collapsed group is somewhere you can drop into, not a dead end.
      if (inCat.length) {
        var cnt = document.createElement('span');
        cnt.className = 'count';
        cnt.style.cssText = 'margin-left:8px; color:var(--muted); font-weight:400;';
        cnt.textContent = inCat.length;
        gtd.appendChild(cnt);
      }
      return;
    }
    if (!inCat.length) { return; }

    inCat.forEach(function (a) {
      var row = document.createElement('tr');
      row._ctl = {};

      var gtd2 = document.createElement('td');
      gtd2.className = 'grip';
      gtd2.textContent = '\u2261';
      gtd2.title = 'Drag to reorder, or onto another group to move it there';
      gtd2.draggable = true;
      gtd2.addEventListener('dragstart', function (ev) {
        DRAG.slug = a.slug; DRAG.group = null;
        row.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', a.slug);
        if (ev.dataTransfer.setDragImage) { ev.dataTransfer.setDragImage(row, 10, 10); }
      });
      gtd2.addEventListener('dragend', function () {
        DRAG.slug = null;
        row.classList.remove('dragging');
        clearMarks();
      });
      // The grip stands in for `category` in the change marks: with the
      // Group column gone there is no other control a staged move could
      // light up, and a moved row that looked identical to an untouched
      // one would be the same "which of these changed?" problem again.
      row._ctl.category = gtd2;
      row.appendChild(gtd2);

      // Read-only, and what the tile ACTUALLY shows right now: same
      // light/dark choice the renderer makes, so this column answers "did
      // I break it?" without opening anything.
      var ptd = document.createElement('td');
      ptd.className = 'preview';
      // The SAME fallback chain the tile uses, all of it: chosen icon,
      // then the bundled icons/<slug>.svg, then the letter avatar. This
      // column is here to answer "what does this app actually look like",
      // so it must never be blank -- a blank cell reads as "no icon" when
      // the dashboard is in fact showing something.
      var pwantLight = window.matchMedia &&
                       window.matchMedia('(prefers-color-scheme: light)').matches;
      var peff = (pwantLight && value(a, 'icon_light')) ? value(a, 'icon_light') : value(a, 'icon');
      var pv = document.createElement('img');
      pv.alt = '';
      pv.src = (peff && /^(https?:\/\/|data:image\/)/.test(peff))
                 ? peff : 'icons/' + a.slug + '.svg';
      pv.onerror = function () {
        var f = document.createElement('div');
        f.className = 'icon letter';
        f.style.cssText = 'width:24px; height:24px; font-size:12px;';
        f.textContent = ((a.base || a).name || a.slug || '?').charAt(0);
        if (pv.parentNode) { pv.parentNode.replaceChild(f, pv); }
      };
      ptd.appendChild(pv); row.appendChild(ptd);

      row.appendChild(text(a, 'name', row));
      row.appendChild(text(a, 'description', row));

      var itd = document.createElement('td');
      itd.className = 'icons';
      var dark = swatch(a, 'icon', row);
      var light = swatch(a, 'icon_light', row);
      row._redrawLight = light.draw;
      itd.appendChild(dark.el); itd.appendChild(light.el);
      row.appendChild(itd);

      dropTarget(row, a, null);
      groupDropTarget(row, c, true);

      var ntd = document.createElement('td');
      ntd.className = 'num';
      var num = document.createElement('input');
      num.type = 'number';
      num.value = value(a, 'order') == null ? '' : value(a, 'order');
      num.addEventListener('change', function () {
        set(a, 'order', num.value === '' ? null : parseInt(num.value, 10), row);
      });
      row._ctl.order = num;
      ntd.appendChild(num); row.appendChild(ntd);

      row.appendChild(flag(a, 'above_fold', row));
      row.appendChild(flag(a, 'hidden', row));

      var atd = document.createElement('td');
      atd.className = 'act';
      if (a.custom) {
        // The URL is the one field an Authentik-backed tile does not own,
        // so it is edited here rather than in the table: adding a ninth
        // column that is blank for 29 of 31 rows is worse.
        var edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'del'; edit.textContent = '\u270e';
        edit.title = 'Edit the link and who is offered it';
        edit.addEventListener('click', function () { newTileDialog(a); });
        var del = document.createElement('button');
        del.type = 'button'; del.className = 'del'; del.textContent = '\u00d7';
        del.title = 'Delete this tile';
        del.addEventListener('click', function () { deleteTile(a); });
        atd.appendChild(edit); atd.appendChild(del);

        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'link';
        badge.title = 'A bookmark, not an Authentik application. Its URL is editable ' +
                      'and it can be deleted; it grants no access by itself.';
        row.children[2].appendChild(badge);
      }
      row.appendChild(atd);

      tb.appendChild(row);
      paint(a, row);
    });
  });

  if (SEARCH && !tb.querySelector('tr:not(.grp)')) {
    var none = document.createElement('div');
    none.className = 'msg';
    none.textContent = 'No tiles match \u201c' + SEARCH + '\u201d.';
    frag.appendChild(none);
  } else {
    t.appendChild(tb); wrap.appendChild(t); frag.appendChild(wrap);
  }
  status();
  return frag;
}

document.getElementById('admin-bulk-btn').addEventListener('click', bulkEnter);
