// widgets.js -- renderers for widget payloads, chosen by SHAPE (roadmap #34).
//
// One of nav's page scripts. These are CLASSIC scripts, not modules: top-level
// names are shared page globals, so the <script> order in index.html is load
// order and matters. jsdom (the test harness) cannot run type=module.
//
// The server half is api/widgets.py; check_shape() there is the
// contract each renderer below relies on. A payload with `error` draws as an
// error tile -- one broken widget never breaks the page.
//
// Charts are plain SVG, not a library: jsdom has no canvas (so a canvas chart
// could not be tested), and nav is the page you open when the WAN is down, so
// nothing may be hot-linked.
'use strict';

var SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  var e = document.createElementNS(SVGNS, tag);
  Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
  return e;
}

function div(cls, text) {
  var e = document.createElement('div');
  if (cls) { e.className = cls; }
  if (text != null) { e.textContent = text; }   // never innerHTML: labels are data
  return e;
}

// 1,284 / 12.9K / 4.2M -- auto-compact, the stat-tile convention.
function compact(v, dec) {
  var a = Math.abs(v);
  if (a >= 1e9) { return (v / 1e9).toFixed(dec) + 'B'; }
  if (a >= 1e6) { return (v / 1e6).toFixed(dec) + 'M'; }
  if (a >= 1e4) { return (v / 1e3).toFixed(dec) + 'K'; }
  return v.toLocaleString(undefined, { maximumFractionDigits: dec });
}

function fmtValue(v, d) {
  if (v == null || isNaN(v)) { return '—'; }
  var dec = d.decimals == null ? 1 : d.decimals;
  var s;
  if (d.format === 'percent') {
    s = v.toFixed(dec) + '%';
  } else if (d.format === 'bytes') {
    var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], i = 0, x = Math.abs(v);
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    s = (v < 0 ? '-' : '') + x.toFixed(i ? dec : 0) + ' ' + u[i];
  } else if (d.format === 'seconds') {
    var t = Math.abs(v);
    s = t < 60 ? v.toFixed(dec) + 's' : t < 3600 ? (v / 60).toFixed(dec) + 'm'
      : t < 86400 ? (v / 3600).toFixed(dec) + 'h' : (v / 86400).toFixed(dec) + 'd';
  } else {
    s = compact(v, dec);
  }
  return d.unit ? s + ' ' + d.unit : s;
}

// Round tick values: 0 / 20 / 40, never 0 / 17.3 / 34.6.
function niceTicks(lo, hi, n) {
  if (lo === hi) { lo -= 1; hi += 1; }
  var raw = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; })
    .find(function (s) { return s >= raw; });
  var out = [];
  for (var v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  if (out[out.length - 1] < hi) { out.push(out[out.length - 1] + step); }
  return out;
}

function timeLabel(t, span) {
  var d = new Date(t * 1000);
  return span > 2 * 86400
    ? d.toLocaleDateString(undefined, { weekday: 'short' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// A path that BREAKS at gaps rather than drawing a line through missing data.
function pathFor(points, x, y) {
  var d = '', pen = false;
  points.forEach(function (p) {
    if (p[1] == null) { pen = false; return; }
    d += (pen ? 'L' : 'M') + x(p[0]).toFixed(1) + ',' + y(p[1]).toFixed(1);
    pen = true;
  });
  return d;
}

// Per-widget view state (legend open or folded), per DEVICE like collapsed
// groups. Keyed by opts.key -- a saved widget's id; a preview passes none and
// keeps nothing.
var WIDGET_UI = {};
try { WIDGET_UI = JSON.parse(localStorage.getItem('nav.widgetui') || '{}') || {}; } catch (e) {}
function widgetUi(key, patch) {
  if (!key) { return {}; }
  if (patch) {
    WIDGET_UI[key] = Object.assign({}, WIDGET_UI[key], patch);
    try { localStorage.setItem('nav.widgetui', JSON.stringify(WIDGET_UI)); } catch (e) {}
  }
  return WIDGET_UI[key] || {};
}

function renderWidget(el, payload, opts) {
  el.innerHTML = '';
  el.classList.add('widget');
  if (!payload || payload.error) {
    el.appendChild(div('w-err', payload ? payload.error : 'No data'));
    return;
  }
  var r = WIDGET_RENDERERS[payload.shape];
  if (!r) {
    el.appendChild(div('w-err', 'This page cannot draw a "' + payload.shape + '" widget yet.'));
    return;
  }
  el.classList.add('widget-' + payload.shape);
  r(el, payload.data || {}, opts || {});
}

function renderStat(el, d, opts) {
  opts = opts || {};
  var tiny = opts.size === 'XS';
  if (d.label) { el.appendChild(div('w-label', d.label)); }
  var row = div('w-value', fmtValue(d.value, d));
  // Status is icon + word, never colour alone (and never a series colour).
  // XS has no room for the word: the dot carries it as its label, and the
  // full view on hover spells it out.
  if (d.level) {
    var word = { ok: 'OK', warn: 'Warning', crit: 'Critical' }[d.level];
    var lv = document.createElement('span');
    lv.className = 'w-level';
    var dot = document.createElement('i');
    dot.style.background = 'var(--status-' + (d.level === 'ok' ? 'good' : d.level) + ')';
    lv.appendChild(dot);
    if (tiny) { lv.title = word; lv.setAttribute('aria-label', word); lv.setAttribute('role', 'img'); }
    else { lv.appendChild(document.createTextNode(word)); }
    row.appendChild(lv);
  }
  el.appendChild(row);
  if (tiny) { return; }
  if (d.sub) { el.appendChild(div('w-sub', d.sub)); }

  var pts = (d.spark || []).filter(function (p) { return p[1] != null; });
  if (pts.length > 1) {
    var W = 200, H = 36;
    var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y0 === y1) { y0 -= 1; y1 += 1; }
    var x = function (t) { return (t - x0) / (x1 - x0 || 1) * (W - 6) + 3; };
    var y = function (v) { return H - 4 - (v - y0) / (y1 - y0) * (H - 8); };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, 'aria-hidden': 'true',
                             preserveAspectRatio: 'none', class: 'w-spark' });
    // The trend is context, so it wears the de-emphasis hue; the current
    // point is the one thing in the accent.
    svg.appendChild(svgEl('path', { d: pathFor(d.spark, x, y), fill: 'none',
      stroke: 'var(--viz-muted)', 'stroke-width': 1.5, 'stroke-linejoin': 'round',
      'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    var last = pts[pts.length - 1];
    svg.appendChild(svgEl('circle', { cx: x(last[0]), cy: y(last[1]), r: 3.5,
      fill: 'var(--series-1)', stroke: 'var(--card)', 'stroke-width': 2 }));
    el.appendChild(svg);
  }
}

/** Status as dot + word (or dot alone, labelled, where there is no room). */
function levelMark(level, dotOnly) {
  var word = { ok: 'OK', warn: 'Warning', crit: 'Critical' }[level];
  var lv = document.createElement('span');
  lv.className = 'w-level';
  var dot = document.createElement('i');
  dot.style.background = 'var(--status-' + (level === 'ok' ? 'good' : level) + ')';
  lv.appendChild(dot);
  if (dotOnly) { lv.title = word; lv.setAttribute('aria-label', word); lv.setAttribute('role', 'img'); }
  else { lv.appendChild(document.createTextNode(word)); }
  return lv;
}

// A line's own identifier ("{{instance}}" in the unit) wins over the shared
// unit, so a tooltip reads "42% wk2" rather than one unit for every line.
function lineFmt(d, s) {
  return s && s.unit != null ? Object.assign({}, d, { unit: s.unit }) : d;
}

function renderTimeseries(el, d, opts) {
  opts = opts || {};
  // XS: the lines and nothing else -- a sparkline. S: lines with a minimal
  // frame. Neither has a legend, tooltip or table: the full widget opens
  // over them on hover (widget-layout.js), which is where reading happens.
  var tiny = opts.size === 'XS', compact = tiny || opts.size === 'S';
  if (d.label || d.level) {
    var head = div('w-label', d.label || '');
    // The chart's status: the worst latest value against its thresholds.
    if (d.level) { head.appendChild(levelMark(d.level, compact)); }
    el.appendChild(head);
  }
  var series = (d.series || []).filter(function (s) {
    return s.points.some(function (p) { return p[1] != null; });
  });
  if (!series.length) { el.appendChild(div('w-sub', 'No data in this range.')); return; }

  // Measured, not assumed. A cell is often drawn BEFORE it is attached (so
  // clientWidth is 0), and resized after; the observer below redraws at the
  // real width either way. Without one (jsdom), the fallback width stands.
  var minW = compact ? 80 : 200;
  var W = el.clientWidth > 0 ? Math.max(minW, el.clientWidth - (compact ? 16 : 28)) : 320, H = 150;
  // In the shared group grid the CELL sets the height (its size); fill it,
  // leaving room for the label, legend and tools. Elsewhere: 150.
  var sized = el.closest && el.closest('.ugrid') && el.clientHeight > 0;
  if (sized && compact) {
    H = Math.max(24, el.clientHeight - 12 - 16);
  } else if (sized) {
    var legendShown = series.length > 1 && widgetUi(opts.key).legend !== false;
    H = Math.max(60, Math.min(600, el.clientHeight - 24 - 22 - 18 - (legendShown ? 24 : 0)));
  }
  var pad = tiny ? { l: 1, r: 1, t: 3, b: 3 } : compact ? { l: 30, r: 4, t: 4, b: 14 }
                 : { l: 44, r: 8, t: 6, b: 20 };
  var all = [];
  series.forEach(function (s) { s.points.forEach(function (p) { if (p[1] != null) { all.push(p); } }); });
  var t0 = d.range ? d.range[0] : Math.min.apply(null, all.map(function (p) { return p[0]; }));
  var t1 = d.range ? d.range[1] : Math.max.apply(null, all.map(function (p) { return p[0]; }));
  var lo = Math.min.apply(null, all.map(function (p) { return p[1]; }));
  var hi = Math.max.apply(null, all.map(function (p) { return p[1]; }));
  // Anchor at zero when the data is mostly above it -- a free-floating
  // baseline exaggerates small changes into cliffs.
  if (lo >= 0 && lo < hi / 2) { lo = 0; }
  // Stretch to show a threshold that sits just outside the data -- a
  // reference line you cannot see is no reference. Not one far away, which
  // would squash the lines flat to show it.
  var marks = [['warn', d.warn], ['crit', d.crit]].filter(function (m) { return m[1] != null; });
  if (!compact) {
    var span = (hi - lo) || 1;
    marks.forEach(function (m) {
      if (m[1] > hi && m[1] - hi <= span) { hi = m[1]; }
      if (m[1] < lo && lo - m[1] <= span) { lo = m[1]; }
    });
  }
  var ticks = niceTicks(lo, hi, compact ? 3 : 4);
  lo = ticks[0]; hi = ticks[ticks.length - 1];
  var x = function (t) { return pad.l + (t - t0) / (t1 - t0 || 1) * (W - pad.l - pad.r); };
  var y = function (v) { return pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b); };

  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img',
                           'aria-label': (d.label || 'chart') + ', ' + series.length + ' series' });
  ticks.forEach(function (v) {
    if (tiny) { return; }
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v),
      stroke: v === lo ? 'var(--viz-axis)' : 'var(--viz-grid)', 'stroke-width': 1 }));
    var lab = svgEl('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
    lab.textContent = fmtValue(v, { format: d.format, unit: '', decimals: 0 });
    svg.appendChild(lab);
  });
  // About one time label per 110px, so they never collide.
  var nx = Math.max(1, Math.min(5, Math.floor((W - pad.l - pad.r) / 110)));
  if (compact) { nx = W >= 150 ? 1 : 0; }
  for (var i = 0; i <= nx && !tiny && nx > 0; i++) {
    var tt = t0 + (t1 - t0) * i / nx;
    var tl = svgEl('text', { x: x(tt), y: H - 4,
      'text-anchor': i === 0 ? 'start' : i === nx ? 'end' : 'middle' });
    tl.textContent = timeLabel(tt, t1 - t0);
    svg.appendChild(tl);
  }
  // Threshold reference lines: thin, solid (never dashed -- that reads as a
  // gridline), in the status colour, with a word at the right in full view.
  marks.forEach(function (m) {
    if (m[1] < lo || m[1] > hi) { return; }
    var yy = y(m[1]);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: 'w-threshold',
      stroke: 'var(--status-' + m[0] + ')', 'stroke-width': 1, 'stroke-opacity': 0.8 }));
    if (!compact) {
      // At the LEFT end: metrics that worry you tend to rise toward "now",
      // so the right end is exactly where the data crowds a label.
      var tlab = svgEl('text', { x: pad.l + 4, y: yy - 3, 'text-anchor': 'start', class: 'w-threshold-label' });
      tlab.textContent = (m[0] === 'crit' ? 'critical ' : 'warn ') + fmtValue(m[1], d);
      svg.appendChild(tlab);
    }
  });
  series.forEach(function (s, k) {
    var colour = 'var(--series-' + (k + 1) + ')';
    if (series.length === 1) {
      // A wash under a lone line; with several it would just be mud.
      var area = pathFor(s.points, x, y);
      if (area) {
        var first = s.points.find(function (p) { return p[1] != null; });
        var last = s.points.slice().reverse().find(function (p) { return p[1] != null; });
        svg.appendChild(svgEl('path', { d: area + 'L' + x(last[0]) + ',' + y(lo) +
          'L' + x(first[0]) + ',' + y(lo) + 'Z', fill: colour, 'fill-opacity': 0.1, stroke: 'none' }));
      }
    }
    svg.appendChild(svgEl('path', { d: pathFor(s.points, x, y), fill: 'none', stroke: colour,
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      class: 'w-line' }));
  });

  if (compact) {
    el.appendChild(svg);
    watchSize(el, d, opts, W, minW, compact, sized);
    return;
  }

  // Crosshair + one tooltip listing every series at that time.
  var cross = svgEl('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--viz-axis)',
                              'stroke-width': 1, visibility: 'hidden' });
  svg.appendChild(cross);
  var hit = svgEl('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H,
                            fill: 'transparent', class: 'w-hit' });
  svg.appendChild(hit);
  var wrap = div('w-plot');
  wrap.style.position = 'relative';
  wrap.tabIndex = 0;
  wrap.appendChild(svg);
  var tip = div('w-tip');
  tip.hidden = true;
  wrap.appendChild(tip);
  var times = series[0].points.map(function (p) { return p[0]; });
  var at = times.length - 1;

  function show(idx) {
    at = Math.max(0, Math.min(times.length - 1, idx));
    var t = times[at], px = x(t);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    tip.innerHTML = '';
    tip.appendChild(div('w-sub', new Date(t * 1000).toLocaleString()));
    series.forEach(function (s, k) {
      var p = s.points.find(function (q) { return q[0] === t; });
      var r = document.createElement('div');
      var name = document.createElement('b');
      name.style.setProperty('--k', 'var(--series-' + (k + 1) + ')');
      name.textContent = s.name;
      var val = document.createElement('strong');   // value leads, label follows
      val.textContent = fmtValue(p ? p[1] : null, lineFmt(d, s));
      r.appendChild(val); r.appendChild(name);
      tip.appendChild(r);
    });
    tip.hidden = false;
    // Beside the crosshair, on whichever side has room -- on the right half
    // it flips left, so it never sits on the lines it is describing.
    var w = wrap.clientWidth || W, cx = px / W * w;
    var tw = tip.offsetWidth || 160;
    tip.style.left = (cx > w / 2 ? Math.max(0, cx - tw - 10) : Math.min(cx + 10, w - tw)) + 'px';
    tip.style.top = '4px';
  }
  function hide() { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; }
  hit.addEventListener('pointermove', function (ev) {
    var box = svg.getBoundingClientRect();
    var t = t0 + ((ev.clientX - box.left) / (box.width || W) * W - pad.l) /
      (W - pad.l - pad.r) * (t1 - t0);
    var best = 0;
    times.forEach(function (tm, i) { if (Math.abs(tm - t) < Math.abs(times[best] - t)) { best = i; } });
    show(best);
  });
  hit.addEventListener('pointerleave', hide);
  wrap.addEventListener('focus', function () { show(at); });
  wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowLeft') { show(at - 1); ev.preventDefault(); }
    if (ev.key === 'ArrowRight') { show(at + 1); ev.preventDefault(); }
  });
  el.appendChild(wrap);

  // Legend for two or more series; a single series is named by the label.
  // Foldable: with many lines it can outgrow the chart. Folded, the tooltip
  // and the table still name every line, so identity never needs colour.
  var lg = null;
  if (series.length > 1) {
    lg = div('w-legend');
    series.forEach(function (s, k) {
      var sp = document.createElement('span');
      sp.style.setProperty('--k', 'var(--series-' + (k + 1) + ')');
      sp.textContent = s.name;
      lg.appendChild(sp);
    });
    lg.hidden = widgetUi(opts.key).legend === false;
    el.appendChild(lg);
  }
  if (d.truncated) {
    el.appendChild(div('w-sub', '+' + d.truncated + ' more series not drawn — aggregate the query to fit 8.'));
  }

  // The table view: every value reachable without hovering.
  var tools = div('w-tools');
  if (lg) {
    var lb = document.createElement('button');
    lb.className = 'w-legend-btn';
    lb.textContent = lg.hidden ? 'Show legend' : 'Hide legend';
    lb.addEventListener('click', function () {
      lg.hidden = !lg.hidden;
      lb.textContent = lg.hidden ? 'Show legend' : 'Hide legend';
      widgetUi(opts.key, { legend: !lg.hidden });
    });
    tools.appendChild(lb);
  }
  var tb = document.createElement('button');
  tb.className = 'w-table-btn';
  tb.textContent = 'Table';
  tools.appendChild(tb);
  el.appendChild(tools);
  var tableBox = div('w-table');
  tableBox.hidden = true;
  el.appendChild(tableBox);
  tb.addEventListener('click', function () {
    if (!tableBox.hidden) { tableBox.hidden = true; tb.textContent = 'Table'; return; }
    tableBox.innerHTML = '';
    var table = document.createElement('table');
    var head = document.createElement('tr');
    ['Time'].concat(series.map(function (s) { return s.name; })).forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; head.appendChild(th);
    });
    table.appendChild(head);
    times.slice().reverse().forEach(function (t) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.textContent = new Date(t * 1000).toLocaleString();
      tr.appendChild(td);
      series.forEach(function (s) {
        var p = s.points.find(function (q) { return q[0] === t; });
        var c = document.createElement('td');
        c.textContent = fmtValue(p ? p[1] : null, lineFmt(d, s));
        tr.appendChild(c);
      });
      table.appendChild(tr);
    });
    tableBox.appendChild(table);
    tableBox.hidden = false;
    tb.textContent = 'Chart only';
  });

  watchSize(el, d, opts, W, minW, compact, sized, tableBox, tb);
}

// Redraw when the cell's real size differs from what was drawn: cells are
// drawn before they are attached (width 0) and resized by the grid after.
function watchSize(el, d, opts, W, minW, compact, sized, tableBox, tb) {
  if (!window.ResizeObserver) { return; }
  if (el._ro) { el._ro.disconnect(); }
  var lastH = el.clientHeight;
  el._ro = new ResizeObserver(function () {
    var w = el.clientWidth - (compact ? 16 : 28);
    var hChanged = sized && Math.abs(el.clientHeight - lastH) > 8;
    if (w > 0 && (Math.abs(Math.max(minW, w) - W) > 8 || hChanged)) {
      var open = tableBox && !tableBox.hidden;
      el.innerHTML = '';
      renderTimeseries(el, d, opts);
      if (open) { el.querySelector('.w-table-btn').click(); }
    }
  });
  el._ro.observe(el);
}

// A list: strings, or items of {label, value, sub, url, badge: {text, level},
// section}. A change of `section` starts a heading (the meal plan's days); a
// badge is a state word with its colour (Seerr's Pending / Available), never
// colour alone. `note` sits beside the headline ("3 pending").
var LIST_LEVEL = { good: 'good', warn: 'warn', crit: 'crit' };

function listLink(url) {
  var a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  // The page's own link setting where it is a plain target; a widget row
  // cannot open nav's split window, so that falls back to a new tab.
  var t = typeof opts !== 'undefined' && opts && opts.target;
  a.target = t === '_self' ? '_self' : '_blank';
  return a;
}

function renderList(el, d) {
  if (d.label || d.note) {
    var head = div('w-label');
    if (d.label) { head.appendChild(document.createTextNode(d.label)); }
    if (d.note) { head.appendChild(div('w-note', d.note)); }
    el.appendChild(head);
  }
  if (!d.items.length) { el.appendChild(div('w-sub', d.empty || 'Nothing to show.')); return; }
  var ul = document.createElement('ul');
  ul.className = 'w-list';
  var section = null;
  d.items.forEach(function (it) {
    if (typeof it !== 'object' || it === null) { it = { label: String(it) }; }
    if (it.section && it.section !== section) {
      section = it.section;
      var h = document.createElement('li');
      h.className = 'w-section';
      h.textContent = section;
      ul.appendChild(h);
    }
    var li = document.createElement('li');
    // Only http(s) becomes a link: a remote widget's JSON is not trusted, and a
    // javascript: URL in an href runs on click.
    var main = /^https?:\/\//i.test(it.url || '') ? listLink(it.url) : document.createElement('span');
    main.className = 'w-item';
    main.appendChild(div('w-item-label', it.label));
    if (it.sub) { main.appendChild(div('w-item-sub', it.sub)); }
    li.appendChild(main);
    if (it.badge && it.badge.text) {
      var b = document.createElement('span');
      b.className = 'w-badge';
      var lv = LIST_LEVEL[it.badge.level];
      var dot = document.createElement('i');
      dot.style.background = lv ? 'var(--status-' + lv + ')' : 'var(--viz-muted)';
      b.appendChild(dot);
      b.appendChild(document.createTextNode(it.badge.text));
      li.appendChild(b);
    } else if (it.value != null) {
      var v = document.createElement('span');
      v.className = 'w-sub';
      v.textContent = String(it.value);
      li.appendChild(v);
    }
    ul.appendChild(li);
  });
  el.appendChild(ul);
}

function renderStatus(el, d, opts) {
  var tiny = opts && opts.size === 'XS';
  if (d.label) { el.appendChild(div('w-label', d.label)); }
  var row = div('w-value');
  var lv = document.createElement('span');
  lv.className = 'w-level';
  lv.style.marginLeft = '0';
  var dot = document.createElement('i');
  var colour = { up: 'good', degraded: 'warn', down: 'crit' }[d.state];
  dot.style.background = colour ? 'var(--status-' + colour + ')' : 'var(--viz-muted)';
  lv.appendChild(dot);
  var sword = { up: 'Up', down: 'Down', degraded: 'Degraded', unknown: 'Unknown' }[d.state];
  if (tiny) { lv.title = sword; lv.setAttribute('aria-label', sword); lv.setAttribute('role', 'img'); }
  else { lv.appendChild(document.createTextNode(sword)); }
  row.appendChild(lv);
  el.appendChild(row);
  if (d.sub) { el.appendChild(div('w-sub', d.sub)); }
}

var WIDGET_RENDERERS = { stat: renderStat, timeseries: renderTimeseries,
                         list: renderList, status: renderStatus };
