// widgets-clock-weather.js -- the `clock` and `weather` renderers.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after widgets.js (svgEl, div, WIDGET_RENDERERS) and registers into it.
//
// Both draw MORE as they get bigger rather than the same thing scaled: a
// compact size shows the one thing that matters at a glance, and the full
// widget opens over it on hover (widget-layout.js).
'use strict';

// --- clock --------------------------------------------------------------------
//
// The server only validates the zones; the time is the browser's. One shared
// ticker for every clock on the page, pruning clocks that have left it.

var CLOCKS = [];
var CLOCK_TIMER = null;

function clockTick() {
  var now = new Date();
  CLOCKS = CLOCKS.filter(function (c) { return c.el.isConnected; });
  CLOCKS.forEach(function (c) { c.draw(now); });
  if (!CLOCKS.length && CLOCK_TIMER) { clearInterval(CLOCK_TIMER); CLOCK_TIMER = null; }
}

function watchClock(el, draw) {
  CLOCKS = CLOCKS.filter(function (c) { return c.el !== el; });
  CLOCKS.push({ el: el, draw: draw });
  draw(new Date());
  if (!CLOCK_TIMER) { CLOCK_TIMER = setInterval(clockTick, 1000); }
}

/** {h, m, s} in a zone (null: the viewer's own). */
function zoneParts(now, tz) {
  var f = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23',
    hour: 'numeric', minute: 'numeric', second: 'numeric' });
  var p = {};
  f.formatToParts(now).forEach(function (x) { p[x.type] = Number(x.value); });
  return { h: p.hour % 24, m: p.minute, s: p.second };
}

/** "+8h", "−3:30", or "" for the viewer's own offset. */
function zoneOffset(now, tz) {
  if (!tz) { return ''; }
  var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric',
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  var p = {};
  f.formatToParts(now).forEach(function (x) { p[x.type] = Number(x.value); });
  var there = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  var here = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  var mins = Math.round((there - here) / 60000);
  if (!mins) { return ''; }
  var a = Math.abs(mins), hh = Math.floor(a / 60), mm = a % 60;
  return (mins > 0 ? '+' : '−') + hh + (mm ? ':' + String(mm).padStart(2, '0') : 'h');
}

function timeFmt(tz, d, seconds) {
  var o = { timeZone: tz || undefined, hour: 'numeric', minute: '2-digit' };
  if (seconds) { o.second = '2-digit'; }
  if (d.hours === '12') { o.hour12 = true; } else if (d.hours === '24') { o.hourCycle = 'h23'; }
  return new Intl.DateTimeFormat(undefined, o);
}

function dateFmt(tz) {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz || undefined, weekday: 'short',
                                              day: 'numeric', month: 'short' });
}

function clockFace(px, seconds) {
  var s = svgEl('svg', { viewBox: '-50 -50 100 100', width: px, height: px, class: 'c-face',
                         role: 'img', style: 'width:' + px + 'px;height:' + px + 'px' });
  s.appendChild(svgEl('circle', { r: 47, class: 'c-rim' }));
  for (var i = 0; i < 12; i++) {
    var a = i * Math.PI / 6, big = i % 3 === 0;
    s.appendChild(svgEl('line', { x1: Math.sin(a) * (big ? 36 : 40), y1: -Math.cos(a) * (big ? 36 : 40),
                                  x2: Math.sin(a) * 44, y2: -Math.cos(a) * 44,
                                  class: big ? 'c-tick big' : 'c-tick' }));
  }
  var hands = {
    h: svgEl('line', { x1: 0, y1: 6, x2: 0, y2: -24, class: 'c-hand c-h' }),
    m: svgEl('line', { x1: 0, y1: 8, x2: 0, y2: -36, class: 'c-hand c-m' })
  };
  s.appendChild(hands.h); s.appendChild(hands.m);
  if (seconds) {
    hands.s = svgEl('line', { x1: 0, y1: 10, x2: 0, y2: -40, class: 'c-hand c-s' });
    s.appendChild(hands.s);
  }
  s.appendChild(svgEl('circle', { r: 2.6, class: 'c-hub' }));
  return { svg: s, hands: hands };
}

// The room a cell gives its content, in px, from its span in grid cells (the
// grid's pitch: 53px columns at minimum, 33px rows, 10px gaps; the widget's
// padding off). An estimate -- columns grow with the page -- but the layout
// only needs to know what FITS. No span (the hover view): its fixed width.
var CLOCK_SPANS = { XS: [2, 2], S: [4, 2], M: [4, 4], L: [8, 4] };
function cellRoom(opts, fallback, el) {
  var sp = opts.span || (opts.size && fallback[opts.size]);
  // The hover view: its own width when it is laid out already (it is), so a
  // row of faces is planned for the panel it is in, not a guess.
  if (!sp) { return { w: el && el.clientWidth > 60 ? el.clientWidth - 28 : 492, h: 320 }; }
  // One row (a .thin cell) has almost no padding: the line is the room.
  if (sp[1] === 1) { return { w: sp[0] * 63 - 10 - 16, h: 27 }; }
  return { w: sp[0] * 63 - 10 - 28, h: sp[1] * 43 - 10 - 24 };
}

var C_LINE = 16;                   // one caption line (label, time or date)

/** Analog: in how many rows, how big, with which captions -- the biggest
 *  faces among the arrangements that fit every zone, or null when none does
 *  (see analogScroll). The caption is UNDER the face -- label, then time,
 *  then date -- and lines go from the bottom up when there is no room: date,
 *  then time, then label (the label stays as the tooltip). */
function analogLayout(n, room, lines, hasLabels) {
  var best = null;
  for (var rows = 1; rows <= n; rows++) {
    var perRow = Math.ceil(n / rows);
    var w = (room.w - (perRow - 1) * 10) / perRow;
    var h = (room.h - (rows - 1) * 8) / rows;
    // A caption line only where its text fits across: the date line
    // (with the offset) wants ~100px, the time ~56.
    var most = lines;
    if (w < 100) { most = Math.min(most, (hasLabels ? 1 : 0) + 1); }
    if (w < 56) { most = Math.min(most, hasLabels ? 1 : 0); }
    for (var l = most; l >= 0; l--) {
      var face = Math.min(w, h - l * C_LINE - (l ? 4 : 0), 160);
      if (face >= (l ? 30 : 26)) {
        if (!best || face > best.face + 4) { best = { k: n, rows: rows, perRow: perRow, face: Math.floor(face), lines: l }; }
        break;
      }
    }
  }
  return best;
}

/** Analog when no arrangement fits every zone: every zone anyway, as many
 *  faces across as fit at a readable size, and the widget scrolls. */
function analogScroll(n, room, lines, hasLabels) {
  var face = Math.max(30, Math.min(64, room.w));
  var perRow = Math.max(1, Math.min(n, Math.floor((room.w + 10) / (face + 10))));
  var w = (room.w - (perRow - 1) * 10) / perRow;
  var most = w < 56 ? (hasLabels ? 1 : 0) : w < 100 ? Math.min(lines, (hasLabels ? 1 : 0) + 1) : lines;
  return { k: n, rows: Math.ceil(n / perRow), perRow: perRow, face: Math.floor(Math.min(face, w)), lines: most };
}

/** Digital, several zones: a grid of rows, each label + date beside the
 *  time -- or, too narrow for that, the time UNDER the label (`stack`).
 *  Columns as the width allows; the date goes before any zone does. */
function digitalLayout(n, room, wantDate) {
  var stack = room.w < 170;
  var most = Math.max(1, Math.floor((room.w + 16) / 186));
  // Rows that fit at a pitch: label over date ~39px, one line ~24px (stacked,
  // the time's line on top of those). As few columns as hold every zone -- a
  // column of three reads better than 2+1.
  function plan(pitch, date) {
    var rows = Math.max(1, Math.floor(room.h / pitch));
    var cols = Math.min(most, Math.ceil(n / rows));
    return { k: Math.min(n, rows * cols), cols: cols, date: date, stack: stack };
  }
  var dated = wantDate && plan(stack ? 60 : 39, true);
  if (dated && dated.k >= n) { return dated; }
  var one = plan(stack ? 44 : 24, false);
  if (one.k >= n) { return one; }
  // Not every zone fits either way: all of them, dated, and the widget
  // scrolls -- a zone is never dropped.
  return { k: n, cols: Math.min(most, n), date: !!wantDate, stack: stack };
}

/** The font size at which a time's text fits a width (digits ~0.6em). */
function fitTime(text, w, max) {
  return Math.max(12, Math.min(max, Math.floor(w / (text.length * 0.6))));
}

function renderClock(el, d, opts) {
  var size = opts.size;            // the named size to draw; undefined: the full widget
  var room = cellRoom(opts, CLOCK_SPANS, el);
  var analog = d.style === 'analog';
  // Tiny: room for one bare time and nothing else (XS, or a span that small).
  var tiny = room.w < 100 && room.h < 60;
  var multi = d.zones.length > 1;
  var showSec = d.seconds && !tiny;
  var hasLabels = d.zones.some(function (z) { return z.label; });

  var lay, zones, showDate, showOffset, showTime, showLabel, timePx = null;
  if (analog) {
    var want = (hasLabels ? 1 : 0) + 1 + (d.date ? 1 : 0);
    lay = tiny ? { k: 1, rows: 1, perRow: 1, face: Math.floor(Math.min(room.w, room.h)), lines: 0 }
               : analogLayout(d.zones.length, room, want, hasLabels) ||
                 analogScroll(d.zones.length, room, want, hasLabels);
    zones = d.zones.slice(0, lay.k);
    showLabel = hasLabels && lay.lines >= 1;
    showTime = lay.lines >= (hasLabels ? 2 : 1);
    showDate = d.date && lay.lines >= want;
    showOffset = showDate;
  } else if (multi && !tiny) {
    lay = digitalLayout(d.zones.length, room, d.date);
    zones = d.zones.slice(0, lay.k);
    showDate = lay.date;
    showOffset = lay.date;
    showTime = showLabel = true;
    if (lay.stack) { timePx = fitTime(timeFmt(zones[0].tz, d, showSec).format(new Date()), room.w, 20); }
  } else {
    zones = d.zones.slice(0, 1);
    showLabel = hasLabels && !tiny && room.h >= 34;
    showDate = d.date && !tiny && room.h >= 70;
    showOffset = showDate;
    showTime = true;
    // One clock: the time takes the room left by its caption lines.
    var lines = (showLabel ? 1 : 0) + (showDate ? 1 : 0);
    var sample = timeFmt(zones[0].tz, d, showSec).format(new Date());
    timePx = Math.max(16, Math.min(Math.floor((room.h - lines * C_LINE) / 1.2), fitTime(sample, room.w, 120)));
  }
  // The day period goes where there is no room for it: the hover view has it.
  var dropPeriod = tiny || (!analog && multi && !showDate && room.w < 260);

  var wrap = div('c-wrap ' + (analog ? 'c-analog' : 'c-digital') + (zones.length > 1 ? ' c-multi' : '') +
                 (!analog && lay && !lay.date ? ' c-oneline' : '') + (!analog && lay && lay.stack ? ' c-stack' : ''));
  if (analog && zones.length > 1) {
    wrap.style.gridTemplateColumns = 'repeat(' + lay.perRow + ', minmax(0, 1fr))';
  } else if (!analog && lay) {
    wrap.style.gridTemplateColumns = 'repeat(' + lay.cols + ', minmax(0, 280px))';
  }
  var items = zones.map(function (z, i) {
    var it = div('c-item');
    if (!analog && lay && i >= lay.cols) { it.classList.add('c-sep'); }
    var tf = timeFmt(z.tz, d, showSec), df = dateFmt(z.tz), fc = null;
    if (z.label) { it.title = z.label; }
    if (analog) {
      fc = clockFace(lay.face, showSec);
      it.appendChild(fc.svg);
    }
    var cap = div('c-cap');
    if (z.label && showLabel) { cap.appendChild(div('c-label', z.label)); }
    var tm = div(analog ? 'c-time-sm' : 'c-time');
    if (timePx) { tm.style.fontSize = timePx + 'px'; }
    if (showTime) { cap.appendChild(tm); }
    // Date and the offset from the viewer's own time share ONE line.
    var meta = showDate || showOffset ? div('c-date') : null;
    if (meta) { cap.appendChild(meta); }
    if (cap.childNodes.length) { it.appendChild(cap); }
    wrap.appendChild(it);
    var last = '';
    return function (now) {
      var t = dropPeriod ? tf.formatToParts(now).filter(function (x) { return x.type !== 'dayPeriod'; })
        .map(function (x) { return x.value; }).join('').trim() : tf.format(now);
      var key = t + (fc ? zoneParts(now, z.tz).s : '');
      if (key === last) { return; }
      last = key;
      tm.textContent = t;
      if (meta) {
        var o = showOffset ? zoneOffset(now, z.tz) : '';
        meta.textContent = [showDate ? df.format(now) : '', o].filter(Boolean).join(' · ');
      }
      if (fc) {
        var p = zoneParts(now, z.tz);
        fc.hands.h.setAttribute('transform', 'rotate(' + ((p.h % 12) * 30 + p.m / 2) + ')');
        fc.hands.m.setAttribute('transform', 'rotate(' + (p.m * 6 + p.s / 10) + ')');
        if (fc.hands.s) { fc.hands.s.setAttribute('transform', 'rotate(' + p.s * 6 + ')'); }
        fc.svg.setAttribute('aria-label', (z.label ? z.label + ' ' : '') + t);
      }
    };
  });
  el.appendChild(wrap);
  watchClock(el, function (now) { items.forEach(function (f) { f(now); }); });
}

// --- weather -------------------------------------------------------------------
//
// Icons are drawn, not emoji: emoji differ by platform and cannot take the
// theme's colour. Monochrome, currentColor, so they sit in text colour.

function wxIcon(kind, isDay, px) {
  var s = svgEl('svg', { viewBox: '0 0 32 32', width: px, height: px, class: 'wx-ico',
                         'aria-hidden': 'true', style: 'width:' + px + 'px;height:' + px + 'px' });
  function add(tag, a) { s.appendChild(svgEl(tag, a)); }
  function sun(cx, cy, r) {
    add('circle', { cx: cx, cy: cy, r: r });
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      add('line', { x1: cx + Math.cos(a) * (r + 2.5), y1: cy + Math.sin(a) * (r + 2.5),
                    x2: cx + Math.cos(a) * (r + 5), y2: cy + Math.sin(a) * (r + 5) });
    }
  }
  function moon(cx, cy, r) {
    add('path', { d: 'M' + (cx + r * 0.3) + ' ' + (cy - r) + 'a' + r + ' ' + r + ' 0 1 0 ' +
                     (r * 0.7) + ' ' + (r * 1.7) + 'a' + (r * 0.8) + ' ' + (r * 0.8) + ' 0 0 1 -' +
                     (r * 0.7) + ' -' + (r * 1.7) + 'z' });
  }
  var cloud = 'M9 23h14a5 5 0 0 0 0-10a7 7 0 0 0-13.4 1.6A4.3 4.3 0 0 0 9 23z';
  if (kind === 'clear') { if (isDay) { sun(16, 16, 6); } else { moon(14, 16, 8); } return s; }
  if (kind === 'partly') {
    if (isDay) { sun(11, 11, 4.5); } else { moon(9, 10, 5.5); }
    add('path', { d: 'M12 26h12a4.5 4.5 0 0 0 0-9a6 6 0 0 0-11.6 1.5A3.8 3.8 0 0 0 12 26z', class: 'fill' });
    return s;
  }
  add('path', { d: cloud, class: kind === 'cloud' ? '' : 'up' });
  if (kind === 'fog') {
    add('line', { x1: 7, y1: 27, x2: 25, y2: 27 }); add('line', { x1: 10, y1: 30, x2: 22, y2: 30 });
  } else if (kind === 'drizzle' || kind === 'rain') {
    var n = kind === 'rain' ? 3 : 2;
    for (var i = 0; i < n; i++) {
      var x = 11 + i * (10 / (n - 1 || 1));
      add('line', { x1: x, y1: 25, x2: x - 1.5, y2: kind === 'rain' ? 30 : 28 });
    }
  } else if (kind === 'snow') {
    [11, 16, 21].forEach(function (x) { add('circle', { cx: x, cy: 28, r: 1.2, class: 'dot' }); });
  } else if (kind === 'storm') {
    add('path', { d: 'M17 23l-3 5h4l-2 4', class: 'bolt' });
  }
  return s;
}

function wxTemp(v) { return v == null ? '–' : Math.round(v) + '°'; }

// Under 5% is forecast noise; shown, it reads as "might rain" on a dry day.
function wxPop(v) { return v != null ? Math.round(v) + '%' : ''; }

function wxHour(iso) {
  // The PLACE's hour, already local in the payload: format as UTC so the
  // viewer's own zone cannot shift it.
  var h = Number(iso.slice(11, 13));
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, 0, 1, h)));
}

function wxDay(iso, i) {
  if (i === 0) { return 'Today'; }
  var p = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(p[0], p[1] - 1, p[2])));
}

function wxNow(d, big) {
  var c = d.current, t = d.daily[0] || {};
  var box = div('wx-now');
  box.appendChild(wxIcon(c.icon, c.is_day, big ? 44 : 30));
  var txt = div('wx-now-txt');
  var temp = div('wx-temp', wxTemp(c.temp));
  txt.appendChild(temp);
  txt.appendChild(div('wx-cond', c.text + (t.hi != null ? ' · ' + wxTemp(t.hi) + ' / ' + wxTemp(t.lo) : '')));
  box.appendChild(txt);
  return box;
}

function wxDetails(d, short) {
  var c = d.current, t = d.daily[0] || {}, u = d.units;
  var bits = [];
  if (short) {
    if (c.feels != null) { bits.push('Feels ' + wxTemp(c.feels)); }
    if (t.pop != null) { bits.push('Rain ' + Math.round(t.pop) + '%'); }
    return div('wx-details', bits.join(' \u00b7 '));
  }
  if (c.feels != null) { bits.push('Feels ' + wxTemp(c.feels)); }
  if (c.wind != null) { bits.push('Wind ' + Math.round(c.wind) + ' ' + u.wind); }
  if (c.humidity != null) { bits.push('Humidity ' + Math.round(c.humidity) + '%'); }
  if (t.pop != null) { bits.push('Rain ' + Math.round(t.pop) + '%'); }
  if (t.sunrise && t.sunset) { bits.push('☀ ' + wxHourMin(t.sunrise) + ' – ' + wxHourMin(t.sunset)); }
  return div('wx-details', bits.join(' · '));
}

function wxHourMin(iso) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2000, 0, 1, Number(iso.slice(11, 13)), Number(iso.slice(14, 16)))));
}

/** Next hours: icons and temperatures as a strip; at the larger sizes, a
 *  temperature line over rain-chance bars, one axis each way (no dual axis:
 *  the bars' scale is the row of percentages under them). */
function wxHourly(d, n, chart, step, pops) {
  // Every `step`th hour: 8 columns at three-hour steps is a day ahead in the
  // room eight hours take, and labels that do not collide.
  var hrs = d.hourly.filter(function (h, i) { return i % (step || 1) === 0; }).slice(0, n);
  var box = div('wx-hourly');
  if (!hrs.length) { return box; }
  if (chart) {
    var W = 100 * hrs.length / 6, H = 46;
    var vals = hrs.map(function (h) { return h.temp; }).filter(function (v) { return v != null; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) { hi = lo + 1; }
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none',
                             class: 'wx-chart', role: 'img',
                             'aria-label': 'Next ' + hrs.length + ' hours: ' + wxTemp(hrs[0].temp) +
                                           ' now, ' + wxTemp(lo) + ' to ' + wxTemp(hi) });
    var step = W / hrs.length;
    hrs.forEach(function (h, i) {
      if (h.pop) {
        var bh = (h.pop / 100) * (H * 0.45);
        svg.appendChild(svgEl('rect', { x: i * step + step * 0.2, y: H - bh, width: step * 0.6,
                                        height: bh, rx: 1, class: 'wx-pop' }));
      }
    });
    var pts = hrs.map(function (h, i) {
      return h.temp == null ? null
        : [i * step + step / 2, 6 + (1 - (h.temp - lo) / (hi - lo)) * (H * 0.5 - 6)];
    });
    var dpath = '', pen = false;
    pts.forEach(function (p) {
      if (!p) { pen = false; return; }
      dpath += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
      pen = true;
    });
    svg.appendChild(svgEl('path', { d: dpath, class: 'wx-line', 'vector-effect': 'non-scaling-stroke' }));
    box.appendChild(svg);
  }
  var row = div('wx-hours');
  hrs.forEach(function (h, i) {
    var c = div('wx-h');
    c.title = wxHour(h.t) + ': ' + wxTemp(h.temp) + ', ' + h.text +
              (h.pop != null ? ', rain ' + Math.round(h.pop) + '%' : '');
    c.appendChild(div('wx-h-t', i === 0 ? 'Now' : wxHour(h.t)));
    c.appendChild(wxIcon(h.icon, h.is_day, 18));
    c.appendChild(div('wx-h-v', wxTemp(h.temp)));
    if (chart || pops) { c.appendChild(div('wx-h-p', wxPop(h.pop))); }
    row.appendChild(c);
  });
  box.appendChild(row);
  return box;
}

/** The week: day, icon, rain chance, and the low-to-high range on one scale
 *  shared by every day, so the bars compare. */
function wxDaily(d) {
  var days = d.daily;
  var lows = days.map(function (x) { return x.lo; }).filter(function (v) { return v != null; });
  var highs = days.map(function (x) { return x.hi; }).filter(function (v) { return v != null; });
  var lo = Math.min.apply(null, lows), hi = Math.max.apply(null, highs);
  var span = Math.max(1, hi - lo);
  var ul = document.createElement('ul');
  ul.className = 'wx-days';
  days.forEach(function (x, i) {
    var li = document.createElement('li');
    li.appendChild(div('wx-d-n', wxDay(x.date, i)));
    li.appendChild(wxIcon(x.icon, true, 18));
    li.appendChild(div('wx-d-p', wxPop(x.pop)));
    li.appendChild(div('wx-d-lo', wxTemp(x.lo)));
    var bar = div('wx-d-bar');
    if (x.lo != null && x.hi != null) {
      var fill = div('wx-d-fill');
      fill.style.left = ((x.lo - lo) / span * 100) + '%';
      fill.style.width = Math.max(4, (x.hi - x.lo) / span * 100) + '%';
      bar.appendChild(fill);
    }
    li.appendChild(bar);
    li.appendChild(div('wx-d-hi', wxTemp(x.hi)));
    li.title = wxDay(x.date, i) + ': ' + x.text + ', ' + wxTemp(x.lo) + ' to ' + wxTemp(x.hi);
    ul.appendChild(li);
  });
  return ul;
}

var WX_SPANS = { XS: [2, 2], S: [4, 2], M: [4, 4], L: [8, 6], XL: [12, 6], W: [24, 2] };
var WX_SLOT = 75;                  // one strip column: two per three grid columns

/** Weather lays out from the cells it really has, not the size's name:
 *    under 4 columns     a card -- now, the conditions, the range, the place
 *    up to 3 rows        a forecast strip (beside now when 8+ wide)
 *    up to L             now, then the strip, then whatever else fits
 *    8x6 and up          now, details, the hours charted, the week
 *  A strip scrolls sideways, toggles hours / the week, and steps two or three
 *  hours a column when few columns fit, so it still reaches a day ahead. */
function renderWeather(el, d, opts) {
  var size = opts.size;            // undefined: the full widget (hover view)
  el.classList.add('wx-' + (size || 'full'));
  var sp = size ? opts.span || WX_SPANS[size] : null;
  if (sp && size === 'W' && !opts.span) { sp = [typeof gridCols === 'function' ? gridCols() : 24, 2]; }
  var c = sp ? sp[0] : 99, r = sp ? sp[1] : 99;
  var room = sp ? { w: c * 63 - 38, h: r * 43 - 34 } : null;
  if (c < 4) { wxCard(el, d, c, r); return; }
  if (r <= 3) { wxForecast(el, d, opts, room, c >= 8 ? 'wide' : r === 2 ? 'narrow' : 'stack'); return; }
  if (c < 8 || r < 6) { wxForecast(el, d, opts, room, 'tall'); return; }
  // 8x6 and up, and the full view: now, the next hours, the week.
  el.appendChild(div('w-label', d.place));
  el.appendChild(wxNow(d, true));
  var body = div('wx-body');
  var left = div('wx-col');
  left.appendChild(wxDetails(d));
  // Columns that fit their labels: at three-hour steps under 12 wide (half
  // the widget each), hourly in the hover view.
  left.appendChild(wxHourly(d, c < 12 ? 6 : 8, true, sp ? 3 : 1));
  body.appendChild(left);
  var right = div('wx-col');
  right.appendChild(wxDaily(d));
  body.appendChild(right);
  el.appendChild(body);
}

/** Under four columns: no strip, the reading. Two rows hold two lines; more
 *  rows add the place and the conditions. */
function wxCard(el, d, c, r) {
  var cur = d.current, t = d.daily[0] || {};
  var range = t.hi != null ? wxTemp(t.hi) + ' / ' + wxTemp(t.lo) : '';
  var box = div('wx-card');
  box.title = d.place + ': ' + wxTemp(cur.temp) + ', ' + cur.text + (range ? ', ' + range : '');
  if (r >= 3) { box.appendChild(div('w-label', d.place)); }
  var top = div('wx-card-top');
  top.appendChild(wxIcon(cur.icon, cur.is_day, r >= 3 ? 28 : 22));
  top.appendChild(div('wx-temp', wxTemp(cur.temp)));
  if (r === 2 && c >= 3 && range) { top.appendChild(div('wx-card-range', range)); }
  box.appendChild(top);
  if (r === 2) {
    box.appendChild(div('wx-cond', c >= 3 ? d.place + ' · ' + cur.text : range || cur.text));
  } else {
    box.appendChild(div('wx-cond', cur.text));
    if (range) { box.appendChild(div('wx-cond', range + (t.pop ? ' · ' + Math.round(t.pop) + '%' : ''))); }
  }
  el.appendChild(box);
}

/** A strip of the next hours OR the week, toggled, under or beside now.
 *    narrow  4-7 x 2: the strip alone (its first hour is now), H/D toggle
 *    stack   4-7 x 3: one line of now over the strip
 *    wide    8+ x 2-3: now on the left, the strip beside it
 *    tall    4+ x 4+: the place, now, the strip; details and the week if room
 *  The choice is this viewer's, per widget (localStorage: a convenience). */
function wxForecast(el, d, opts, room, layout) {
  var key = 'nav.wx.' + (opts.key || 'preview');
  var mode = 'hourly';
  try { mode = localStorage.getItem(key) === 'daily' ? 'daily' : 'hourly'; } catch (e) { /* none */ }
  var cur = d.current, t = d.daily[0] || {};
  var range = t.hi != null ? wxTemp(t.hi) + ' / ' + wxTemp(t.lo) : '';
  var box = div('wx-wide wx-' + layout);
  box.title = d.place + ': ' + wxTemp(cur.temp) + ', ' + cur.text + (range ? ', ' + range : '');
  var tog = div('wx-toggle');
  tog.setAttribute('role', 'group');
  tog.setAttribute('aria-label', 'Forecast');
  var strip = div('wx-strip scroller');
  // Columns the strip shows without scrolling, and so how many hours each
  // takes: a day ahead in view wherever it can be.
  var stripW = !room ? 600 : layout === 'narrow' ? room.w - 32 : layout === 'wide' ? room.w - 194 : room.w;
  var shown = Math.max(1, Math.floor(stripW / WX_SLOT));
  var step = shown >= 12 ? 1 : shown >= 6 ? 2 : 3;
  function draw() {
    strip.innerHTML = '';
    strip.scrollLeft = 0;
    strip.appendChild(mode === 'daily' ? wxDailyStrip(d) : wxHourStrip(d, step));
    Array.prototype.forEach.call(tog.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
  }
  [['hourly', 'Hourly', 'H'], ['daily', 'Daily', 'D']].forEach(function (m) {
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m[0];
    b.textContent = layout === 'narrow' ? m[2] : m[1];
    b.title = m[1];
    // Not a drag start, not a link: the cell is draggable while arranging.
    b.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    b.addEventListener('click', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      mode = m[0];
      try { localStorage.setItem(key, mode); } catch (e) { /* none */ }
      draw();
    });
    tog.appendChild(b);
  });
  function nowLine(px) {
    var line = div('wx-w-top');
    line.appendChild(wxIcon(cur.icon, cur.is_day, px));
    line.appendChild(div('wx-temp', wxTemp(cur.temp)));
    return line;
  }
  if (layout === 'narrow') {
    box.appendChild(tog);
  } else if (layout === 'wide') {
    var left = div('wx-w-now');
    var top = nowLine(28);
    top.appendChild(tog);
    left.appendChild(top);
    left.appendChild(div('wx-cond', d.place + ' · ' + cur.text + (range ? ' · ' + range : '')));
    box.appendChild(left);
  } else if (layout === 'stack') {
    var head = nowLine(22);
    head.appendChild(div('wx-cond', d.place + ' · ' + cur.text + (range ? ' · ' + range : '')));
    head.appendChild(tog);
    box.appendChild(head);
  } else {
    var lab = div('wx-w-head');
    lab.appendChild(div('w-label', d.place));
    lab.appendChild(tog);
    box.appendChild(lab);
    box.appendChild(wxNow(d, room.w >= 300));
    if (room.h >= 175) { box.appendChild(wxDetails(d, room.w < 300)); }
  }
  box.appendChild(strip);
  draw();
  // Tall and narrow: room for the week under the strip, whichever it shows.
  if (layout === 'tall' && room.h >= 280) { box.appendChild(wxDaily(d)); }
  el.appendChild(box);
}

/** One strip column: when, icon, value, rain chance on the value's line. */
function wxCell(when, icon, isDay, value, pop, title) {
  var c = div('wx-h');
  c.title = title;
  c.appendChild(div('wx-h-t', when));
  c.appendChild(wxIcon(icon, isDay, 16));
  var v = div('wx-h-v');
  if (typeof value === 'string') { v.textContent = value; } else { v.appendChild(value); }
  if (pop) { v.appendChild(div('wx-h-p', pop)); }
  c.appendChild(v);
  return c;
}

/** The next day by the hour (every `step`th); the first is now. */
function wxHourStrip(d, step) {
  var row = div('wx-hours wx-hours-strip');
  d.hourly.filter(function (h, i) { return i % (step || 1) === 0; }).forEach(function (h, i) {
    row.appendChild(wxCell(i === 0 ? 'Now' : wxHour(h.t), h.icon, h.is_day,
      wxTemp(i === 0 && d.current.temp != null ? d.current.temp : h.temp), wxPop(h.pop),
      wxHour(h.t) + ': ' + wxTemp(h.temp) + ', ' + h.text +
      (h.pop != null ? ', rain ' + Math.round(h.pop) + '%' : '')));
  });
  return row;
}

/** The week as columns, compact: day, icon, high/low, rain chance. */
function wxDailyStrip(d) {
  var row = div('wx-hours wx-days-strip');
  d.daily.forEach(function (x, i) {
    var v = document.createElement('span');
    v.appendChild(document.createTextNode(wxTemp(x.hi)));
    var lo = document.createElement('span');
    lo.className = 'wx-h-lo';
    lo.textContent = '/' + wxTemp(x.lo);
    v.appendChild(lo);
    row.appendChild(wxCell(wxDay(x.date, i), x.icon, true, v, wxPop(x.pop),
      wxDay(x.date, i) + ': ' + x.text + ', ' + wxTemp(x.lo) + ' to ' + wxTemp(x.hi) +
      (x.pop != null ? ', rain ' + Math.round(x.pop) + '%' : '')));
  });
  return row;
}

WIDGET_RENDERERS.clock = renderClock;
WIDGET_RENDERERS.weather = renderWeather;
