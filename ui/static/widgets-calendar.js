// widgets-calendar.js -- the calendar shape: what is coming up, by week or month.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after widgets.js (div, widgetUi, WIDGET_RENDERERS) and widgets-clock-weather.js
// (cellRoom), and registers into WIDGET_RENDERERS.
//
// Payload (api/media.py): {label, view, events, warnings}. An event has
// `at` (an instant, bucketed by the VIEWER's local day) or `date` (a calendar
// day, never shifted), plus kind (tv | movie | music), title, sub and done.
//
// By the cell's width:
//   under 8 columns  an agenda: the days that have something, each a heading
//   8+, week         seven columns from today
//   8+, month        this month as a grid; chips where they fit, dots where not
// Week or month is this viewer's choice, per widget (widgetUi), defaulting to
// the definition's `view`. ‹ and › step a week or a month, as far as the
// payload's `range` (the days nav-api fetched) covers; the step is not kept --
// a reload is back at today.
'use strict';

var CAL_KINDS = { tv: ['TV', 1], movie: ['Films', 2], music: ['Music', 3] };

/** An event's colour: its own `series` (1-8, e.g. a person in choreboard's
 *  calendar) or its kind's. Events and the legend use the same palette. */
function calColor(e) {
  if (e.series >= 1 && e.series <= 8) { return 'var(--series-' + e.series + ')'; }
  return 'var(--series-' + (CAL_KINDS[e.kind] || ['', 4])[1] + ')';
}
var CAL_SPANS = { M: [4, 4], L: [8, 4], XL: [12, 8], W: [24, 4] };
var CAL_AGENDA_W = 420;     // narrower than this (px of room): an agenda
var CAL_STEP = {};          // widget key -> weeks or months from now

/** The days a view shows at `step`: [first, last, anchor]. Week: seven days
 *  from today + 7*step. Month: that month's days (the grid's spill-over days
 *  are drawn muted and not counted). The agenda's step 0 month is the next
 *  30 days, as before. */
function calSpan(mode, step, today, agenda) {
  if (mode === 'week') {
    var a = calAdd(today, 7 * step);
    return [a, calAdd(a, 6), a];
  }
  if (agenda && step === 0) { return [today, calAdd(today, 30), today]; }
  var t = calParse(today);
  var first = new Date(t.getFullYear(), t.getMonth() + step, 1);
  var last = new Date(t.getFullYear(), t.getMonth() + step + 1, 0);
  return [calDay(first), calDay(last), calDay(first)];
}

/** Whether the data covers a span. An older API sends no range: then what
 *  it always fetched (38 back, 45 on, less a day for the zones). */
function calCovered(d, sp, today) {
  var r = d.range || [calAdd(today, -37), calAdd(today, 44)];
  return sp[0] >= r[0] && sp[1] <= r[1];
}

function calSpanName(mode, sp, today) {
  if (mode === 'month') {
    return calParse(sp[2]).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  var a = calParse(sp[0]), b = calParse(sp[1]);
  var f = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  // "Oct 19 – 25", the locale's own way of saying a range.
  if (f.formatRange) { return f.formatRange(a, b); }
  return f.format(a) + ' – ' + f.format(b);
}

function calDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function calParse(s) {
  var p = s.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function calAdd(s, n) {
  var d = calParse(s);
  d.setDate(d.getDate() + n);
  return calDay(d);
}

function calWhen(e) { return e.at ? calDay(new Date(e.at)) : e.date; }

function calName(s, today, long) {
  var n = Math.round((calParse(s) - calParse(today)) / 864e5);
  if (n === 0) { return 'Today'; }
  if (n === 1) { return 'Tomorrow'; }
  return calParse(s).toLocaleDateString(undefined, long
    ? { weekday: 'long', day: 'numeric', month: 'short' }
    : { weekday: 'short', day: 'numeric' });
}

/** Sunday or Monday, as the viewer's locale has it. */
function calFirstDay() {
  try {
    var loc = new Intl.Locale(navigator.language || 'en-US');
    var info = loc.getWeekInfo ? loc.getWeekInfo() : loc.weekInfo;
    if (info && info.firstDay) { return info.firstDay % 7; }
  } catch (e) { /* older engines */ }
  return 0;
}

function calTip(e, day) {
  return e.title + (e.sub ? ' — ' + e.sub : '') +
    (e.at ? ' · ' + new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') +
    ' · ' + calParse(day).toLocaleDateString() + (e.done ? (e.kind ? ' · downloaded' : ' · done') : '');
}

function calChip(e, day, withSub) {
  var c = div('cal-chip' + (e.done ? ' cal-done' : '') + (e.struck ? ' cal-struck' : ''));
  c.style.setProperty('--cal-c', calColor(e));
  c.title = calTip(e, day);
  c.appendChild(div('cal-t', (e.done ? '✓ ' : '') + e.title));
  if (withSub && e.sub) { c.appendChild(div('cal-s', e.sub)); }
  return c;
}

function calDot(e, day) {
  var i = document.createElement('i');
  i.className = 'cal-dot' + (e.done ? ' cal-done' : '');
  i.style.background = calColor(e);
  i.title = calTip(e, day);
  return i;
}

/** Too small to read a title: one bright dot per kind of release that day
 *  (TV, film, music), in the legend's colours. What they are is the day's
 *  popover (calDayPeek), on hover or tap. */
var CAL_CHIP_MIN_W = 64;    // px of cell: narrower and a title is three letters

var CAL_MAX_INITIALS = 5;   // then "+N": the day's popover has them all

/* Events that name a person (choreboard) are drawn as one chip whose parts
 * appear in priority order as width allows: the person's initial, then the
 * chore's icon, then the person's name, then the chore's name. Widths are px
 * of the cell, measured from what each part needs at the chip's font size. */
var CAL_LEVELS = [[40, 1], [66, 2], [118, 3]];   // under this width -> this many parts; wider: all 4

function calPeople(evs) {
  return evs.some(function (e) { return e.initial; });
}

function calLevel(width) {
  for (var i = 0; i < CAL_LEVELS.length; i++) { if (width < CAL_LEVELS[i][0]) { return CAL_LEVELS[i][1]; } }
  return 4;
}

/** Set by renderCalendar for the chips it draws: which widget definition
 *  they belong to, and its payload (people, whether actions are on). */
var CAL_RENDER = null;

function calPersonChip(e, level, withDetail) {
  var c = div('cal-chip cal-pchip' + (e.done ? ' cal-done' : '') + (e.struck ? ' cal-struck' : '') +
              (e.pending ? ' cal-tentative' : ''));
  var ctx = CAL_RENDER;
  if (ctx && ctx.d.actions && e.key && ctx.defId) {
    // Interactive: a click (or Enter) opens what this viewer may do with it.
    c.classList.add('cal-act');
    c.tabIndex = 0;
    c.setAttribute('role', 'button');
    var open = function (ev) { ev.stopPropagation(); ev.preventDefault(); calSheet(c, e, ctx.defId, ctx.d); };
    c.addEventListener('click', open);
    c.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { open(ev); } });
  }
  c.style.setProperty('--cal-c', calColor(e));
  var full = (e.who || e.initial || '') + ' — ' + (e.name || e.title || '') + (e.detail ? ' · ' + e.detail : '');
  c.title = full;
  c.setAttribute('aria-label', full);
  var line = div('cal-pline');
  var init = document.createElement('i');
  init.className = 'cal-init';
  init.style.background = calColor(e);
  init.textContent = e.initial || '?';
  line.appendChild(init);
  if (level >= 2 && e.icon) { line.appendChild(div('cal-ic', e.icon)); }
  if (level >= 3) { line.appendChild(div('cal-who', e.who || '')); }
  if (level >= 4) { line.appendChild(div('cal-t', (e.done ? '✓ ' : '') + (e.name || e.title || ''))); }
  c.appendChild(line);
  if (withDetail && e.detail) { c.appendChild(div('cal-s', e.detail)); }
  return c;
}

/** Person chips stacked in a cell: as many as `rows` allows, the rest as
 *  "+N" (the day's popover has them all); no room for even one row -> a
 *  wrapping row of initials. */
function calPersonCell(box, evs, width, rows, more) {
  if (rows < 1) { box.appendChild(calKindDots(evs)); return; }
  var level = calLevel(width);
  var fit = evs.length > rows ? Math.max(rows - (more ? 0 : 1), 1) : evs.length;
  evs.slice(0, fit).forEach(function (e) { box.appendChild(calPersonChip(e, level, false)); });
  if (evs.length > fit) { (more || box).appendChild(div('cal-more', '+' + (evs.length - fit))); }
}

function calKindDots(evs, day) {
  // Events that name a person (choreboard): that person's initial, one per
  // event, in their colour -- "who has something that day" is the point.
  if (evs.some(function (e) { return e.initial; })) {
    var row = div('cal-dots cal-inits');
    evs.slice(0, CAL_MAX_INITIALS).forEach(function (e) {
      var b = document.createElement('i');
      b.className = 'cal-init' + (e.done ? ' cal-done' : '') + (e.struck ? ' cal-struck' : '');
      b.style.background = calColor(e);
      b.textContent = e.initial || '?';
      row.appendChild(b);
    });
    if (evs.length > CAL_MAX_INITIALS) { row.appendChild(div('cal-more', '+' + (evs.length - CAL_MAX_INITIALS))); }
    return row;
  }
  var dots = div('cal-dots');
  var seen = {};
  evs.forEach(function (e) {
    if (seen[e.kind]) { return; }
    seen[e.kind] = true;
    var i = calDot(e, day);
    i.removeAttribute('title');
    dots.appendChild(i);
  });
  return dots;
}

function calAgenda(box, byDay, today, mode, sp, step) {
  var first = step === 0 && sp[0] < today ? today : sp[0], last = sp[1];
  var any = false;
  var ul = document.createElement('ul');
  ul.className = 'w-list cal-agenda';
  Object.keys(byDay).sort().forEach(function (day) {
    if (day < first || day > last) { return; }
    any = true;
    var h = document.createElement('li');
    h.className = 'w-section' + (day === today ? ' cal-today' : '');
    h.textContent = calName(day, today, true);
    ul.appendChild(h);
    byDay[day].forEach(function (e) {
      var li = document.createElement('li');
      li.appendChild(e.initial ? calPersonChip(e, 4, true) : calChip(e, day, true));
      ul.appendChild(li);
    });
  });
  if (any) { box.appendChild(ul); }
  else {
    box.appendChild(div('w-sub', step !== 0 ? 'Nothing then.'
      : mode === 'week' ? 'Nothing due this week.' : 'Nothing due in the next month.'));
  }
}

function calWeek(box, byDay, start, today, room) {
  var grid = div('cal-week');
  // Subtitles where the busiest day still fits with them (a chip with its
  // sub is about 44px when the title wraps, 30 when it does not).
  var most = 0;
  for (var j = 0; j < 7; j++) { most = Math.max(most, (byDay[calAdd(start, j)] || []).length); }
  var per = room.w / 7 < 110 ? 44 : 30;
  var withSub = most * per <= room.h - 44;
  // Columns too narrow, or too short for even one chip: dots, not slivers.
  var dotted = room.w / 7 < CAL_CHIP_MIN_W || room.h - 44 < 24;
  for (var i = 0; i < 7; i++) {
    var day = calAdd(start, i);
    var evs = byDay[day] || [];
    var col = div('cal-col' + (day === today ? ' cal-today' : '') + (day < today ? ' cal-past' : ''));
    col.appendChild(div('cal-h', calName(day, today, false)));
    if (calPeople(evs)) {
      // Chip height ~20px; the column header ~24px.
      calPersonCell(col, evs, room.w / 7 - 6, Math.floor((room.h - 44) / 20), null);
      calDayPeek(col, day, evs, today);
    } else if (dotted) {
      if (evs.length) { calDayPeek(col, day, evs, today); col.appendChild(calKindDots(evs, day)); }
    } else {
      evs.forEach(function (e) { col.appendChild(calChip(e, day, withSub)); });
    }
    grid.appendChild(col);
  }
  box.appendChild(grid);
}

function calMonth(box, byDay, anchor, today, room) {
  var t = calParse(anchor);
  var first = new Date(t.getFullYear(), t.getMonth(), 1);
  var start = new Date(first);
  start.setDate(1 - ((first.getDay() - calFirstDay() + 7) % 7));
  var end = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  var weeks = Math.ceil(((end - start) / 864e5 + 1) / 7);
  var grid = div('cal-month');
  grid.style.gridTemplateRows = '14px repeat(' + weeks + ', 1fr)';
  for (var w = 0; w < 7; w++) {
    var wd = new Date(start);
    wd.setDate(start.getDate() + w);
    grid.appendChild(div('cal-wd', wd.toLocaleDateString(undefined, { weekday: room.w > 600 ? 'short' : 'narrow' })));
  }
  // Rows share what is left under the header and weekday line.
  var cellH = (room.h - 24 - 14) / weeks;
  var lines = Math.floor((cellH - 14) / 14);
  for (var n = 0; n < weeks * 7; n++) {
    var d = new Date(start);
    d.setDate(start.getDate() + n);
    var day = calDay(d);
    var evs = byDay[day] || [];
    var cell = div('cal-cell' + (d.getMonth() !== t.getMonth() ? ' cal-out' : '') +
                   (day < today ? ' cal-past' : '') + (day === today ? ' cal-today' : ''));
    var num = div('cal-n', String(d.getDate()));
    cell.appendChild(num);
    if (evs.length && calPeople(evs)) {
      calDayPeek(cell, day, evs, today);
      // A person chip is ~17px; the overflow count rides beside the day number.
      calPersonCell(cell, evs, room.w / 7 - 6, Math.floor((cellH - 14) / 17), num);
    } else if (evs.length) {
      calDayPeek(cell, day, evs, today);
      if (lines >= 1 && room.w / 7 >= CAL_CHIP_MIN_W) {
        // The overflow count rides beside the day number, so it costs no line.
        var fit = Math.min(evs.length, lines);
        evs.slice(0, fit).forEach(function (e) {
          var c = calChip(e, day, false);
          c.removeAttribute('title');     // the day's popover says it all
          cell.appendChild(c);
        });
        if (evs.length > fit) { num.appendChild(div('cal-more', '+' + (evs.length - fit))); }
      } else {
        cell.appendChild(calKindDots(evs, day));
      }
    }
    grid.appendChild(cell);
  }
  box.appendChild(grid);
}

/** A day enlarged -- a month cell, or a week column drawn as dots: every
 *  event with its sub, where the cell has room for two and a "+3", or for
 *  none. On hover (a short delay), focus or a tap;
 *  Escape, leaving, or a tap elsewhere closes it. One open at a time. */
var CAL_DAY = null;         // { el, cell, timer }

function calDayClose() {
  if (!CAL_DAY) { return; }
  clearTimeout(CAL_DAY.timer);
  if (CAL_DAY.el && CAL_DAY.el.parentNode) { CAL_DAY.el.parentNode.removeChild(CAL_DAY.el); }
  CAL_DAY = null;
}

function calDayOpen(cell, day, evs, today) {
  calDayClose();
  var pop = div('w-peek cal-day-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', calName(day, today, true));
  pop.appendChild(div('cal-day-h', calName(day, today, true)));
  evs.forEach(function (e) {
    if (e.initial) { pop.appendChild(calPersonChip(e, 4, true)); return; }
    var c = calChip(e, day, true);
    if (e.at) {
      c.appendChild(div('cal-s', new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    }
    pop.appendChild(c);
  });
  document.body.appendChild(pop);
  // Over the cell, grown from its top-left; kept on screen.
  var r = cell.getBoundingClientRect(), pw = pop.offsetWidth || 260, ph = pop.offsetHeight || 120;
  pop.style.left = Math.min(Math.max(8, r.left - 4), innerWidth - pw - 8) + 'px';
  pop.style.top = Math.min(Math.max(8, r.top - 4), Math.max(8, innerHeight - ph - 8)) + 'px';
  pop.addEventListener('mouseleave', function (ev) {
    if (!cell.contains(ev.relatedTarget)) { calDayClose(); }
  });
  CAL_DAY = { el: pop, cell: cell, timer: null };
}

function calDayPeek(cell, day, evs, today) {
  cell.tabIndex = 0;
  cell.classList.add('cal-has');
  cell.setAttribute('aria-label', calName(day, today, true) + ': ' +
    evs.map(function (e) { return e.title; }).join(', '));
  // The popover is drawn later (on hover); its chips must belong to THIS
  // widget even if another calendar rendered since.
  var ctx = CAL_RENDER;
  function open() {
    var prev = CAL_RENDER;
    CAL_RENDER = ctx;
    try { calDayOpen(cell, day, evs, today); } finally { CAL_RENDER = prev; }
  }
  cell.addEventListener('mouseenter', function () {
    if (CAL_DAY && CAL_DAY.cell === cell) { return; }
    calDayClose();
    CAL_DAY = { el: null, cell: cell, timer: setTimeout(open, 250) };
  });
  cell.addEventListener('mouseleave', function (ev) {
    if (CAL_DAY && CAL_DAY.el && CAL_DAY.el.contains(ev.relatedTarget)) { return; }
    calDayClose();
  });
  cell.addEventListener('click', function (ev) {
    // A tap: touch has no hover. A second tap closes.
    ev.stopPropagation();
    if (CAL_DAY && CAL_DAY.cell === cell && CAL_DAY.el) { calDayClose(); } else { open(); }
  });
  cell.addEventListener('focus', open);
  cell.addEventListener('blur', function (ev) {
    if (CAL_DAY && CAL_DAY.el && CAL_DAY.el.contains(ev.relatedTarget)) { return; }
    calDayClose();
  });
  cell.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { calDayClose(); } });
}

document.addEventListener('click', function (ev) {
  if (CAL_DAY && CAL_DAY.el && !CAL_DAY.el.contains(ev.target)) { calDayClose(); }
});

function renderCalendar(el, d, o) {
  o = o || {};
  if (d.strip) { calStrip(el, d, o); return; }
  CAL_RENDER = { defId: String(o.key || '').replace(/^def/, ''), d: d };
  var ui = widgetUi(o.key);
  var mode = ui.cal || d.view || 'week';
  var room = cellRoom(o, CAL_SPANS, el);
  var today = calDay(new Date());
  var byDay = {}, kinds = {};
  // Legend people chosen (clicked): only their chores -- the ones they're
  // down for or did. None chosen: everyone.
  var picked = (ui.who || []).filter(function (id) {
    return (d.legend || []).some(function (l) { return l.id === id; });
  });
  d.events.forEach(function (e) {
    if (picked.length && picked.indexOf(e.who_id) < 0 && picked.indexOf(e.person_id) < 0) { return; }
    var day = calWhen(e);
    if (!day) { return; }
    (byDay[day] = byDay[day] || []).push(e);
    kinds[e.kind] = true;
  });
  var agenda = room.w < CAL_AGENDA_W;
  el.classList.toggle('cal-is-agenda', agenda);
  var skey = o.key || 'preview';
  var step = CAL_STEP[skey] || 0;
  var sp = calSpan(mode, step, today, agenda);
  // A refresh may have narrowed the range under a step: back to today.
  if (step && !calCovered(d, sp, today)) { step = CAL_STEP[skey] = 0; sp = calSpan(mode, 0, today, agenda); }
  function redraw() {
    el.innerHTML = '';
    renderCalendar(el, d, o);
    if (typeof scrollIfOver === 'function') { scrollIfOver(el); }
  }

  var head = div('cal-head');
  if (d.label) { head.appendChild(div('w-label', d.label)); }
  if (d.unread > 0 || Array.isArray(d.notes)) {
    // The inbox of the app behind the widget (choreboard): always there once
    // it knows who you are, with the unread count; hover for the latest few.
    var bell = document.createElement(d.inbox_url ? 'a' : 'span');
    bell.className = 'cal-bell' + (d.unread > 0 ? ' has-unread' : '');
    bell.textContent = d.unread > 0 ? '🔔 ' + (d.unread > 99 ? '99+' : d.unread) : '🔔';
    bell.setAttribute('aria-label', d.unread > 0
      ? d.unread + ' unread notification' + (d.unread === 1 ? '' : 's') : 'Notifications');
    if (d.inbox_url) { bell.href = d.inbox_url; bell.target = '_blank'; bell.rel = 'noopener'; }
    bell.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    if (Array.isArray(d.notes)) { calNotesHover(bell, d); }
    head.appendChild(bell);
  }
  if (d.acting_as || d.can_act_as) { head.appendChild(calActAs(d, CAL_RENDER.defId)); }
  if (!agenda) {
    var legend = div('cal-legend');
    // The payload's own legend (choreboard: one entry per person), else the kinds present.
    var keyItems = Array.isArray(d.legend) && d.legend.length
      ? d.legend.map(function (l) { return [l.label, calColor({ series: l.series })]; })
      : Object.keys(CAL_KINDS).filter(function (k) { return kinds[k]; })
          .map(function (k) { return [CAL_KINDS[k][0], calColor({ kind: k })]; });
    var people = Array.isArray(d.legend) && d.legend.length && d.legend[0].id != null;
    keyItems.forEach(function (item, n) {
      var s = document.createElement(people ? 'button' : 'span');
      var i = document.createElement('i');
      i.style.background = item[1];
      s.appendChild(i);
      s.appendChild(document.createTextNode(item[0]));
      if (people) {
        // Click a person to show only theirs; click more to add them; click
        // again to drop them. None chosen shows everyone.
        var id = d.legend[n].id, on = picked.indexOf(id) >= 0;
        s.type = 'button';
        s.className = 'cal-who' + (on ? ' on' : '') + (picked.length && !on ? ' off' : '');
        s.setAttribute('aria-pressed', String(on));
        s.title = on ? 'Stop showing only ' + item[0] : 'Show ' + item[0] + '\'s chores';
        s.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        s.addEventListener('click', function (ev) {
          ev.stopPropagation(); ev.preventDefault();
          var next = on ? picked.filter(function (x) { return x !== id; }) : picked.concat([id]);
          widgetUi(o.key, { who: next });
          if (!o.key) { ui = { who: next }; }
          redraw();
        });
      }
      legend.appendChild(s);
    });
    head.appendChild(legend);
  }
  head.appendChild(calNav(mode, step, sp, today, agenda, d, function (n) { CAL_STEP[skey] = n; redraw(); }, room.w));
  var tog = div('wx-toggle cal-toggle');
  tog.setAttribute('role', 'group');
  tog.setAttribute('aria-label', 'Calendar view');
  [['week', 'Week', 'W'], ['month', 'Month', 'M']].forEach(function (m) {
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m[0];
    b.textContent = agenda ? m[2] : m[1];
    b.title = m[1];
    b.setAttribute('aria-pressed', String(mode === m[0]));
    b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    b.addEventListener('click', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      widgetUi(o.key, { cal: m[0] });
      if (!o.key) { d = Object.assign({}, d, { view: m[0] }); }   // a preview keeps nothing
      CAL_STEP[skey] = 0;
      redraw();
    });
    tog.appendChild(b);
  });
  head.appendChild(tog);
  el.appendChild(head);

  var box = div('cal-body');
  if (agenda) { calAgenda(box, byDay, today, mode, sp, step); }
  else if (mode === 'month') { calMonth(box, byDay, sp[2], today, room); }
  else { calWeek(box, byDay, sp[0], today, room); }
  el.appendChild(box);
  if (d.warnings && d.warnings.length) {
    var w = div('w-sub cal-warn', '⚠ ' + d.warnings.join(' · '));
    w.title = d.warnings.join('\n');
    el.appendChild(w);
  }
}

/** ‹ the span › -- and Today, once stepped away. A step the data does not
 *  cover is disabled, not empty: "nothing then" would be a lie. */
/** A one-week strip for small widgets (payload `strip: true`): seven days from
 *  the payload's `week_start` (0 Sunday … 6 Saturday; default the locale's),
 *  each a date with a mark when something's on. Hover or focus a marked day
 *  for what and when. ‹ › step a week while the data covers it. */
function calStrip(el, d, o) {
  var key = o.key || 'preview';
  var today = calDay(new Date());
  var first = d.week_start >= 0 && d.week_start <= 6 ? d.week_start : calFirstDay();
  var step = CAL_STEP[key] || 0;
  var start = calAdd(today, -((calParse(today).getDay() - first + 7) % 7) + 7 * step);
  if (step && !calCovered(d, [start, calAdd(start, 6)], today)) { step = CAL_STEP[key] = 0; start = calAdd(today, -((calParse(today).getDay() - first + 7) % 7)); }
  var byDay = {};
  d.events.forEach(function (e) {
    var day = calWhen(e);
    if (day) { (byDay[day] = byDay[day] || []).push(e); }
  });
  function redraw() { el.innerHTML = ''; calStrip(el, d, o); }
  el.classList.add('cal-strip-w');
  var head = div('cal-head');
  if (d.label) { head.appendChild(div('w-label', d.label)); }
  var nav = div('cal-nav');
  [['‹', 'Previous week', -1], ['›', 'Next week', 1]].forEach(function (x, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = x[0];
    b.title = x[1];
    b.setAttribute('aria-label', x[1]);
    var s2 = calAdd(start, 7 * x[2]);
    b.disabled = !calCovered(d, [s2, calAdd(s2, 6)], today);
    b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    b.addEventListener('click', function (ev) { ev.stopPropagation(); ev.preventDefault(); CAL_STEP[key] = step + x[2]; redraw(); });
    if (i === 1) { nav.appendChild(div('cal-month-name', calSpanName('week', [start, calAdd(start, 6)], today))); }
    nav.appendChild(b);
  });
  head.appendChild(nav);
  el.appendChild(head);
  var row = div('cal-strip');
  for (var i = 0; i < 7; i++) {
    var day = calAdd(start, i), evs = byDay[day] || [];
    var cell = div('cal-sday' + (day === today ? ' cal-today' : '') + (day < today ? ' cal-past' : '') +
                   (evs.length ? ' cal-on' : ''));
    cell.appendChild(div('cal-sdow', calParse(day).toLocaleDateString(undefined, { weekday: 'narrow' })));
    cell.appendChild(div('cal-sn', String(calParse(day).getDate())));
    var marks = div('cal-smarks');
    evs.slice(0, 3).forEach(function (e) { marks.appendChild(calDot(e, day)); });
    cell.appendChild(marks);
    if (evs.length) { calDayPeek(cell, day, evs, today); }
    else { cell.setAttribute('aria-label', calName(day, today, true) + ': nothing'); }
    row.appendChild(cell);
  }
  el.appendChild(row);
  if (d.warnings && d.warnings.length) { el.appendChild(div('w-sub cal-warn', '⚠ ' + d.warnings.join(' · '))); }
}

function calNav(mode, step, sp, today, agenda, d, go, roomW) {
  var nav = div('cal-nav');
  function btn(text, label, n, ok) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.disabled = !ok;
    b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    b.addEventListener('click', function (ev) { ev.stopPropagation(); ev.preventDefault(); go(n); });
    return b;
  }
  var unit = mode === 'week' ? 'week' : 'month';
  nav.appendChild(btn('‹', 'Previous ' + unit, step - 1,
                      calCovered(d, calSpan(mode, step - 1, today, agenda), today)));
  var name = div('cal-month-name', calSpanName(mode, sp, today));
  // Not needed: the agenda's "next 7/30 days", or a narrow week whose column
  // heads already say the dates (and the header has no room for it).
  if ((agenda && step === 0) || (mode === 'week' && !agenda && roomW < 600)) { name.hidden = true; }
  nav.appendChild(name);
  nav.appendChild(btn('›', 'Next ' + unit, step + 1,
                      calCovered(d, calSpan(mode, step + 1, today, agenda), today)));
  if (step !== 0) { nav.appendChild(btn('Today', 'Back to today', 0, true)); }
  return nav;
}

/* --- actions: what the viewer may do with a chore ---------------------------
 * The payload says, per chore, what THIS viewer may do (`can`, decided by the
 * app behind the widget) and why not for the common ones (`cannot`). The sheet
 * offers exactly that; nav-api performs it as the viewer, and the app's own
 * rules have the last word -- its refusal is what the sheet shows. */
var CAL_SHEET = null;

/** A choreboard admin acting as someone else in this widget: 👤 picks who;
 *  "as Toby ✕" while it's on. Choreboard checks it on every call and
 *  records the admin with what they do. */
function calActAs(d, defId) {
  var wrap = div('cal-as');
  var stop = function (ev) { ev.stopPropagation(); };
  wrap.addEventListener('mousedown', stop);
  if (d.acting_as) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cal-as-on';
    chip.textContent = '👤 as ' + d.acting_as.name + ' ✕';
    chip.title = 'You are acting as ' + d.acting_as.name + '; changes are recorded as you, as them. Click to stop.';
    chip.addEventListener('click', function (ev) {
      stop(ev); ev.preventDefault();
      delete WIDGET_AS[defId];
      calSheetClose();
      calRefresh(defId);
    });
    wrap.appendChild(chip);
    return wrap;
  }
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'cal-ib cal-as-pick';
  b.textContent = '👤';
  b.title = 'Act as someone else';
  b.setAttribute('aria-label', 'Act as someone else');
  b.setAttribute('aria-haspopup', 'menu');
  b.addEventListener('click', function (ev) {
    stop(ev); ev.preventDefault();
    // Floats on the page like the action sheet: a menu inside the widget is
    // clipped by it.
    var r = b.getBoundingClientRect();
    calSheetClose();
    var pop = div('w-peek cal-sheet cal-as-menu');
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', 'Act as');
    pop.addEventListener('click', stop);
    pop.appendChild(div('cal-as-h', 'Act as:'));
    (d.people || []).forEach(function (p) {
      var it = document.createElement('button');
      it.type = 'button';
      it.setAttribute('role', 'menuitem');
      it.className = 'cal-as-chip';
      it.textContent = p.name;
      it.addEventListener('click', function (e2) {
        stop(e2); e2.preventDefault();
        WIDGET_AS[defId] = p.id;
        calSheetClose();
        calRefresh(defId);
      });
      pop.appendChild(it);
    });
    document.body.appendChild(pop);
    var pw = pop.offsetWidth || 220;
    pop.style.left = Math.min(Math.max(8, r.right - pw), Math.max(8, innerWidth - pw - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, Math.max(8, innerHeight - (pop.offsetHeight || 200) - 8)) + 'px';
    CAL_SHEET = pop;
    b.setAttribute('aria-expanded', 'true');
    var first = pop.querySelector('[role=menuitem]');
    if (first && first.focus) { first.focus(); }
  });
  wrap.appendChild(b);
  return wrap;
}

/** The bell's hover: the latest notifications, unread first-marked, each a
 *  link to its own page in Choreboard. Floats on the page (a popover inside
 *  the widget is clipped), and stays while the pointer moves onto it. */
var CAL_NOTES = null;
function calNotesClose() {
  if (CAL_NOTES && CAL_NOTES.parentNode) { CAL_NOTES.parentNode.removeChild(CAL_NOTES); }
  CAL_NOTES = null;
}
function calAgo(iso) {
  var t = Date.parse(iso);
  if (isNaN(t)) { return ''; }
  var m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
}
function calNotesHover(bell, d) {
  var timer = null;
  function hideSoon() { clearTimeout(timer); timer = setTimeout(calNotesClose, 250); }
  function show() {
    clearTimeout(timer);
    if (CAL_NOTES && CAL_NOTES.owner === bell) { return; }
    calNotesClose();
    var r = bell.getBoundingClientRect();
    var pop = div('w-peek cal-sheet cal-notes');
    pop.owner = bell;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Notifications');
    pop.addEventListener('mouseenter', function () { clearTimeout(timer); });
    pop.addEventListener('mouseleave', hideSoon);
    pop.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    pop.appendChild(div('cal-sheet-h', d.unread > 0 ? d.unread + ' unread' : 'Notifications'));
    if (!d.notes.length) { pop.appendChild(div('w-sub', 'Nothing yet.')); }
    d.notes.forEach(function (n) {
      var it = document.createElement(n.url ? 'a' : 'div');
      it.className = 'cal-note-item' + (n.read ? '' : ' unread');
      if (n.url) { it.href = n.url; it.target = '_blank'; it.rel = 'noopener'; }
      var top = div('cal-note-t');
      top.appendChild(document.createTextNode(n.title));
      var ago = document.createElement('span');
      ago.className = 'w-sub';
      ago.textContent = calAgo(n.at);
      top.appendChild(ago);
      it.appendChild(top);
      if (n.body) { it.appendChild(div('w-sub cal-note-b', n.body)); }
      pop.appendChild(it);
    });
    if (d.inbox_url) {
      var all = document.createElement('a');
      all.className = 'cal-note-all';
      all.href = d.inbox_url; all.target = '_blank'; all.rel = 'noopener';
      all.textContent = 'Open the inbox ›';
      pop.appendChild(all);
    }
    document.body.appendChild(pop);
    var pw = pop.offsetWidth || 300;
    pop.style.left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - pw - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, Math.max(8, innerHeight - (pop.offsetHeight || 200) - 8)) + 'px';
    CAL_NOTES = pop;
  }
  bell.addEventListener('mouseenter', show);
  bell.addEventListener('focus', show);
  bell.addEventListener('mouseleave', hideSoon);
  bell.addEventListener('blur', hideSoon);
}

function calSheetClose() {
  if (CAL_SHEET && CAL_SHEET.parentNode) { CAL_SHEET.parentNode.removeChild(CAL_SHEET); }
  CAL_SHEET = null;
}

function calAct(defId, action, params) {
  return fetch('api/widgets/' + defId + '/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: action, params: params || {},
                           as: (typeof WIDGET_AS === 'object' && WIDGET_AS[defId]) || undefined })
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (b) {
      if (!r.ok) { throw new Error(b.detail || ('HTTP ' + r.status)); }
      return b.result || {};
    });
  });
}

function calRefresh(defId) {
  if (typeof WIDGET_DATA === 'object' && WIDGET_DATA[defId]) { WIDGET_DATA[defId].at = 0; }
  if (typeof fetchWidgetData === 'function') { fetchWidgetData(defId); }
}

/* The sheet's actions, as icons (label in the tooltip and for screen readers).
 * [action, icon, label, needs]. `needs` is what the form asks first; '' runs
 * at once. Rarer ones go in the ⋯ menu. */
var CAL_ICONS = [
  ['done', '✓', 'Mark done', ''],
  ['covered', '✓⁺', 'Someone else did it', 'person'],
  ['propose_swap', '⇄', 'Ask to swap', 'swap'],
  ['swap', '⇄', 'Swap', 'swap'],
  ['give', '⇄⁺', 'Give to someone', 'person note'],
  ['propose_give', '⇄⁺', 'Ask someone to take it', 'person note'],
  ['skip', '⏭', 'Skip this day', 'note'],
  ['failed', '✗', 'Missed', 'deduct note'],
  ['undo', '↶', 'Undo', 'note'],
  ['undo_swap', '⇄↶', 'Undo the swap', ''],
  ['request_undo', '⇄↶', 'Ask to undo the swap', 'note']
];
var CAL_MORE = [
  ['failed_covered', '✗⁺', 'Missed, someone covered', 'person deduct note'],
  ['skipped', '∅', 'Not needed', '']
];

function calSheet(anchor, e, defId, d) {
  // Measure BEFORE closing anything: the chip may be inside the day popover,
  // and a removed element measures as 0,0 -- the sheet flew to the corner.
  var r = anchor.getBoundingClientRect();
  calSheetClose();
  var inPopover = CAL_DAY && CAL_DAY.el && CAL_DAY.el.contains(anchor);
  if (!inPopover && typeof calDayClose === 'function') { calDayClose(); }
  var pop = div('w-peek cal-sheet');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', (e.name || e.title) + ', ' + (e.who || ''));
  pop.addEventListener('click', function (ev) { ev.stopPropagation(); });
  pop.addEventListener('mouseleave', function (ev) { ev.stopPropagation(); });
  pop.appendChild(div('cal-sheet-h', (e.icon ? e.icon + ' ' : '') + (e.name || e.title)));
  pop.appendChild(div('w-sub', (e.who || '') + (e.detail ? ' · ' + e.detail : '') + ' · ' +
    calParse(e.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })));
  if (e.covered) {
    pop.appendChild(div('cal-note', e.covered.missed
      ? e.covered.for + ' missed it; ' + e.who + ' covered.'
      : e.who + ' did it for ' + e.covered.for + '.'));
  }
  var err = div('cal-err');
  err.setAttribute('role', 'alert');
  var body = div('cal-sheet-b');
  var can = e.can || [];
  var settle = null;          // an admin's answer to a pending swap on this day

  function run(action, extra) {
    err.textContent = '';
    var params = { key: e.key };
    if (settle) { params.pending = settle; }
    if (e.outcome_id) { params.outcome_id = e.outcome_id; }
    if (e.pending) { params.request = e.pending.id; }
    if (e.group) { params.group = e.group; }
    Object.keys(extra || {}).forEach(function (k) { params[k] = extra[k]; });
    pop.classList.add('busy');
    return calAct(defId, action, params).then(function (res) {
      pop.classList.remove('busy');
      if (action !== 'candidates') { calSheetClose(); calRefresh(defId); }
      return res;
    }, function (x) {
      pop.classList.remove('busy');
      err.textContent = x.message;
      throw x;
    });
  }
  function choose(a) {
    // An admin changing a day in a pending swap settles it first: ask how.
    if (e.pending && !settle && ['give', 'skip', 'swap'].indexOf(a[0]) >= 0) { calSettle(body, a, e, function (how) {
      settle = how;
      choose(a);
    }); return; }
    if (!a[3]) { run(a[0], {}).catch(function () {}); return; }
    calSheetForm(body, a, e, d, run);
  }

  if (e.pending) {
    var p = div('cal-note');
    p.appendChild(document.createTextNode((e.pending.kind === 'undo'
      ? '⇄↶ Undo pending: ' + e.pending.from + ' asked to undo this swap'
      : e.pending.kind === 'give'
        ? '⇄⁺ Hand-off pending: ' + e.pending.from + ' asked ' + e.pending.to + ' to take this'
        : '⇄ Swap pending: ' + e.pending.from + ' ⇄ ' + e.pending.to) +
      (e.pending.reason ? ' — ' + e.pending.reason : '') + '. Nothing changes until ' + e.pending.to + ' approves. '));
    [['approve_swap', e.pending.kind === 'give' ? 'Accept' : 'Approve'], ['decline_swap', 'Decline'],
     ['cancel_swap', 'Cancel request']].forEach(function (x) {
      if (can.indexOf(x[0]) < 0) { return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = x[0] === 'approve_swap' ? 'primary' : '';
      b.textContent = x[1];
      b.addEventListener('click', function () { run(x[0], {}).catch(function () {}); });
      p.appendChild(b);
    });
    pop.appendChild(p);
  }

  var bar = div('cal-icons');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Actions');
  CAL_ICONS.forEach(function (a) {
    if (can.indexOf(a[0]) < 0 || ((a[0] === 'propose_swap' || a[0] === 'propose_give') && e.pending)) { return; }
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-ib' + (a[0] === 'done' ? ' primary' : '');
    b.textContent = a[1];
    b.title = a[2];
    b.setAttribute('aria-label', a[2]);
    b.addEventListener('click', function () { choose(a); });
    bar.appendChild(b);
  });
  var more = CAL_MORE.filter(function (a) { return can.indexOf(a[0]) >= 0; });
  if (more.length) {
    var mb = document.createElement('button');
    mb.type = 'button';
    mb.className = 'cal-ib';
    mb.textContent = '⋯';
    mb.title = 'More';
    mb.setAttribute('aria-label', 'More');
    mb.setAttribute('aria-haspopup', 'menu');
    mb.setAttribute('aria-expanded', 'false');
    var menu = div('cal-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    more.forEach(function (a) {
      var it = document.createElement('button');
      it.type = 'button';
      it.setAttribute('role', 'menuitem');
      it.textContent = a[1] + ' ' + a[2];
      it.addEventListener('click', function () { menu.hidden = true; choose(a); });
      menu.appendChild(it);
    });
    mb.addEventListener('click', function () {
      menu.hidden = !menu.hidden;
      mb.setAttribute('aria-expanded', String(!menu.hidden));
    });
    bar.appendChild(mb);
    bar.appendChild(menu);
  }
  if (!bar.children.length && !e.pending) { bar.appendChild(div('w-sub', 'Nothing you can do with this one.')); }
  body.appendChild(bar);
  var WHY = { done: 'Done', propose_swap: 'Swap', undo: 'Undo', undo_swap: 'Undo swap', request_undo: 'Undo swap' };
  Object.keys(e.cannot || {}).forEach(function (k) {
    if (WHY[k]) { body.appendChild(div('w-sub cal-why', WHY[k] + ': ' + e.cannot[k] + '.')); }
  });
  pop.appendChild(body);
  pop.appendChild(err);

  document.body.appendChild(pop);
  // At the chore: just below it, or above if the bottom is close; aligned to
  // its left edge; never off screen.
  var pw = pop.offsetWidth || 280, ph = pop.offsetHeight || 140;
  var below = r.bottom + 4, above = r.top - 4 - ph;
  var top = below + ph <= innerHeight - 8 || above < 8 ? below : above;
  pop.style.left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - pw - 8)) + 'px';
  pop.style.top = Math.min(Math.max(8, top), Math.max(8, innerHeight - ph - 8)) + 'px';
  CAL_SHEET = pop;
  var first = pop.querySelector('button');
  if (first && first.focus) { first.focus(); }
}

/** Before an admin's change to a day in a pending swap: approve it (the swap
 *  happens, then this) or decline it (the request is dropped, then this). */
function calSettle(body, a, e, then) {
  body.innerHTML = '';
  var undo = e.pending.kind === 'undo';
  body.appendChild(div('cal-sheet-t', a[1] + ' ' + a[2]));
  body.appendChild(div('cal-note', '⇄ This day is in a pending ' + (undo ? 'request to undo a swap' : 'swap') +
    ' (' + e.pending.from + ' asked ' + e.pending.to + (e.pending.reason ? ' — ' + e.pending.reason : '') + '). ' +
    'Doing this settles it first: approving ' + (undo ? 'undoes the swap' : 'makes the swap') +
    ', declining drops the request.'));
  var row = div('cal-settle');
  [['approve', 'Approve it, then ' + a[2].toLowerCase(), 'primary'],
   ['decline', 'Decline it, then ' + a[2].toLowerCase(), '']].forEach(function (x) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = x[2];
    b.textContent = x[1];
    b.addEventListener('click', function () { then(x[0]); });
    row.appendChild(b);
  });
  body.appendChild(row);
  var first = body.querySelector('button');
  if (first && first.focus) { first.focus(); }
}

function calDate(iso) {
  return calParse(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The details an action needs, asked for in the sheet. */
function calSheetForm(body, a, e, d, run) {
  body.innerHTML = '';
  var f = document.createElement('form');
  f.className = 'cal-sheet-form';
  f.appendChild(div('cal-sheet-t', a[1] + ' ' + a[2]));
  var fields = {};
  function field(label, input) {
    var l = document.createElement('label');
    l.appendChild(document.createTextNode(label));
    l.appendChild(input);
    f.appendChild(l);
    return input;
  }
  var needs = a[3].split(' ');
  if (needs.indexOf('person') >= 0) {
    var sel = document.createElement('select');
    (d.people || []).forEach(function (p) {
      if (p.id === e.person_id) { return; }
      var op = document.createElement('option');
      op.value = p.id; op.textContent = p.name;
      sel.appendChild(op);
    });
    fields.person = field(a[0] === 'give' ? 'Give it to' : a[0] === 'propose_give' ? 'Ask' : 'Who did it', sel);
  }
  if (needs.indexOf('deduct') >= 0) {
    var n = document.createElement('input');
    n.type = 'number'; n.min = '0'; n.value = '0';
    fields.deduct = field('Points to take from ' + (e.who || 'them') + ' (0 for none)', n);
  }
  if (needs.indexOf('swap') >= 0) { fields.swap = calSwapPicker(f, run, e.date); }
  var note = document.createElement('input');
  note.type = 'text';
  var noteRequired = needs.indexOf('note') >= 0 || needs.indexOf('swap') >= 0 || a[0] === 'covered';
  if (noteRequired) { fields.note = field(a[0] === 'undo' ? 'Why undo it?' : a[0] === 'request_undo' ? 'Why undo the swap?' : 'Why?', note); }
  if (a[0] === 'propose_swap' || a[0] === 'propose_give') {
    f.appendChild(div('w-sub', 'They\'ll be asked to ' + (a[0] === 'propose_give' ? 'accept' : 'approve') +
      ' it; nothing changes until they do.'));
  }
  var go = document.createElement('button');
  go.type = 'submit';
  go.className = 'primary';
  go.textContent = a[0] === 'propose_swap' || a[0] === 'propose_give' || a[0] === 'request_undo' ? 'Ask them' : a[2];
  f.appendChild(go);
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var p = {};
    if (fields.person) { p.person_id = Number(fields.person.value); p.done_by = Number(fields.person.value); }
    if (fields.deduct) { p.deduct = Math.max(0, Number(fields.deduct.value) || 0); }
    if (fields.swap) {
      var picked = fields.swap.querySelector('input[name=cal-swap]:checked');
      if (!picked) { return; }
      p.other = picked.value;
    }
    if (noteRequired) {
      if (!note.value.trim()) { note.focus(); return; }
      p.note = note.value.trim();
    }
    run(a[0], p).catch(function () { /* the sheet shows the error */ });
  });
  body.appendChild(f);
}

/** The other side of a swap, in two steps: choose a person or a date (a
 *  toggle), then one of that person's chores (by date) or that date's chores
 *  (by person). Candidates come from the app: other people's open chores. */
/** The swap's last step: a small calendar (week or month) where only the
 *  days you could swap with can be picked and your own day is marked -- or
 *  the same days as a plain list. Each pickable day holds a radio named
 *  cal-swap, which is what the form reads. The view is remembered. */
var CAL_SWAP_VIEW_KEY = 'nav.swapView';
function calDayPicker(days, own) {
  var box = div('cal-daypick');
  var view = 'month';
  try { view = localStorage.getItem(CAL_SWAP_VIEW_KEY) || 'month'; } catch (e) { /* fine */ }
  var anchor = days.length ? days[0].date : calDay(new Date());
  var picked = days.length ? days[0].key : null;
  var byDate = {};
  days.forEach(function (c) { byDate[c.date] = byDate[c.date] || c; });
  var today = calDay(new Date());
  var first = calFirstDay();

  function radio(c, label, cls) {
    var l = document.createElement('label');
    l.className = cls;
    var r = document.createElement('input');
    r.type = 'radio'; r.name = 'cal-swap'; r.value = c.key;
    r.checked = c.key === picked;
    r.addEventListener('change', function () { picked = c.key; draw(); });
    l.appendChild(r);
    l.appendChild(document.createTextNode(label));
    return l;
  }
  function draw() {
    box.textContent = '';
    var bar = div('cal-dp-bar');
    var seg = div('cal-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Calendar view');
    [['week', 'Week'], ['month', 'Month'], ['list', 'Agenda']].forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = m[1];
      b.setAttribute('aria-pressed', String(view === m[0]));
      b.addEventListener('click', function () {
        view = m[0];
        try { localStorage.setItem(CAL_SWAP_VIEW_KEY, view); } catch (e) { /* fine */ }
        draw();
      });
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    box.appendChild(bar);
    var group = div(view === 'list' ? 'cal-radios' : 'cal-mini');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Which day');
    if (view === 'list') {
      days.forEach(function (c) {
        group.appendChild(radio(c, ' ' + calDate(c.date) + (c.window ? ' (' + c.window + ')' : ''), 'cal-cand'));
      });
      box.appendChild(group);
      return;
    }
    var a = calParse(anchor), from, to, title;
    if (view === 'week') {
      from = calAdd(anchor, -((a.getDay() - first + 7) % 7));
      to = calAdd(from, 6);
      title = 'Week of ' + calDate(from);
    } else {
      var m1 = calDay(new Date(a.getFullYear(), a.getMonth(), 1));
      var mEnd = calDay(new Date(a.getFullYear(), a.getMonth() + 1, 0));
      from = calAdd(m1, -((calParse(m1).getDay() - first + 7) % 7));
      to = calAdd(mEnd, (first + 6 - calParse(mEnd).getDay() + 7) % 7);
      title = a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    var nav = div('cal-dp-nav');
    [['‹', -1], [title, 0], ['›', 1]].forEach(function (x) {
      if (!x[1]) { nav.appendChild(div('cal-dp-title', x[0])); return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = x[0];
      b.setAttribute('aria-label', (x[1] < 0 ? 'Previous ' : 'Next ') + view);
      b.addEventListener('click', function () {
        if (view === 'week') { anchor = calAdd(anchor, 7 * x[1]); }
        else { var p = calParse(anchor); anchor = calDay(new Date(p.getFullYear(), p.getMonth() + x[1], 1)); }
        draw();
      });
      nav.appendChild(b);
    });
    box.appendChild(nav);
    for (var i = 0; i < 7; i++) {
      var w = new Date(2024, 0, 7 + ((first + i) % 7));      // a known Sunday, plus offsets
      group.appendChild(div('cal-dow', w.toLocaleDateString(undefined, { weekday: 'narrow' })));
    }
    var month = calParse(anchor).getMonth();
    for (var d = from; d <= to; d = calAdd(d, 1)) {
      var c = byDate[d];
      var cls = 'cal-dp' + (c ? ' ok' : '') + (c && c.key === picked ? ' on' : '') + (d === own ? ' own' : '') +
        (d === today ? ' today' : '') + (view === 'month' && calParse(d).getMonth() !== month ? ' outside' : '');
      var n = String(calParse(d).getDate());
      if (c) {
        var l = radio(c, n, cls);
        l.title = calDate(d) + (c.window ? ' (' + c.window + ')' : '');
        group.appendChild(l);
      } else {
        var sp = div(cls, n);
        if (d === own) { sp.title = 'Your day'; }
        group.appendChild(sp);
      }
    }
    box.appendChild(group);
    var key = div('w-sub cal-dp-key');
    key.innerHTML = '<i class="cal-dp own"></i> your day · <i class="cal-dp ok"></i> can swap';
    box.appendChild(key);
  }
  draw();
  return box;
}

/** The other side of a swap, in three steps (the same as in Choreboard
 *  itself): by person or by chore; which one; then the other; then the day.
 *  Each list shows only what still has days behind it, with a count. */
function calSwapPicker(form, run, own) {
  var box = div('cal-swap');
  form.appendChild(box);
  var by = 'person', cands = [], first = null, second = null;
  var toggle = div('cal-seg');
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Swap by');
  var list = div('cal-cands', 'Finding chores to swap with…');
  box.appendChild(toggle);
  box.appendChild(list);
  [['person', 'By person'], ['chore', 'By chore']].forEach(function (m) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = m[1];
    b.setAttribute('aria-pressed', String(by === m[0]));
    b.addEventListener('click', function () {
      by = m[0]; first = second = null;
      [].forEach.call(toggle.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      draw();
    });
    toggle.appendChild(b);
  });
  function one(c) { return by === 'person' ? c.who : c.title; }
  function two(c) { return by === 'person' ? c.title : c.who; }
  function counts(rows, key) {
    var n = {}, order = [];
    rows.forEach(function (c) { var k = key(c); if (!n[k]) { n[k] = 0; order.push(k); } n[k]++; });
    order.sort(function (a, b) { return a.localeCompare(b); });
    return order.map(function (k) { return [k, n[k]]; });
  }
  function picks(rows, key, pick) {
    counts(rows, key).forEach(function (kv) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-pick';
      b.textContent = kv[0] + ' (' + kv[1] + ')';
      b.addEventListener('click', function () { pick(kv[0]); draw(); });
      list.appendChild(b);
    });
  }
  function back(label, undo) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-back';
    b.textContent = '‹ ' + label;
    b.addEventListener('click', function () { undo(); draw(); });
    list.appendChild(b);
  }
  function draw() {
    list.textContent = '';
    if (!cands.length) { list.textContent = 'Nothing of anyone else\'s in the next 12 weeks.'; return; }
    if (first === null) { picks(cands, one, function (k) { first = k; }); return; }
    var rows = cands.filter(function (c) { return one(c) === first; });
    back(first, function () { first = second = null; });
    if (second === null) { picks(rows, two, function (k) { second = k; }); return; }
    back(second, function () { second = null; });
    var days = rows.filter(function (c) { return two(c) === second; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    list.appendChild(calDayPicker(days, own));
  }
  run('candidates', { weeks: 12 }).then(function (res) { cands = res.candidates || []; draw(); },
                                        function () { list.textContent = ''; });
  return box;
}

document.addEventListener('click', function () { if (CAL_SHEET) { calSheetClose(); } });
document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && CAL_SHEET) { calSheetClose(); } });

WIDGET_RENDERERS.calendar = renderCalendar;
