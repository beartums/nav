// richtext.js -- text blocks: the formatting editor, and drawing one.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after widgets.js (WIDGET_RENDERERS, div) and before widget-designer.js,
// which uses richEditor() for a config field marked `rich`.
//
// The editor is contenteditable with a toolbar (document.execCommand, with
// styleWithCSS so colours and sizes become <span style>). What it produces is
// cleaned by the server on save (api/richtext.py) and again here before it is
// drawn: the same allowlist, so neither side alone is trusted.
'use strict';

var RT_TAGS = { P:1, BR:1, DIV:1, SPAN:1, H1:1, H2:1, H3:1, H4:1, B:1, STRONG:1, I:1, EM:1, U:1, S:1,
                STRIKE:1, SUB:1, SUP:1, UL:1, OL:1, LI:1, A:1, IMG:1, BLOCKQUOTE:1, HR:1, PRE:1, CODE:1 };
var RT_DROP = { SCRIPT:1, STYLE:1, IFRAME:1, OBJECT:1, EMBED:1, TEMPLATE:1, NOSCRIPT:1, SVG:1, MATH:1 };
var RT_STYLE = ['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration',
                'text-decoration-line', 'text-align', 'font-family', 'line-height', 'margin-left', 'padding-left'];

/** The allowlisted copy of `html` (mirrors api/richtext.py). */
function cleanRich(html) {
  var src = new DOMParser().parseFromString('<body>' + (html || '') + '</body>', 'text/html').body;
  var out = document.createElement('div');
  (function walk(from, to) {
    Array.prototype.forEach.call(from.childNodes, function (n) {
      if (n.nodeType === 3) { to.appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1 || RT_DROP[n.tagName]) { return; }
      if (!RT_TAGS[n.tagName]) { walk(n, to); return; }     // unknown wrapper: keep its text
      var el = document.createElement(n.tagName.toLowerCase());
      if (n.tagName === 'A') {
        var href = n.getAttribute('href') || '';
        if (/^(https?:\/\/|mailto:)/i.test(href) || dashboardLinkId(href)) { el.setAttribute('href', href); }
        if (!dashboardLinkId(href)) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      }
      if (n.tagName === 'IMG') {
        var s = n.getAttribute('src') || '';
        if (!/^(https:\/\/|api\/images\/[0-9a-f]{64}$)/.test(s)) { return; }
        el.setAttribute('src', s);
        if (n.getAttribute('alt')) { el.setAttribute('alt', n.getAttribute('alt')); }
      }
      if (n.tagName === 'OL' && /^\d{1,4}$/.test(n.getAttribute('start') || '')) { el.setAttribute('start', n.getAttribute('start')); }
      RT_STYLE.forEach(function (k) {
        var v = n.style && n.style.getPropertyValue(k);
        if (v && !/url\(/i.test(v)) { el.style.setProperty(k, v); }
      });
      if (!el.getAttribute('style')) { el.removeAttribute('style'); }
      to.appendChild(el);
      walk(n, el);
    });
  })(src, out);
  return out.innerHTML;
}

/** A text block, drawn. */
WIDGET_RENDERERS.text = function (el, d) {
  el.classList.toggle('w-text-bare', d.frame === false);
  el.classList.add('w-text-pad-' + (d.padding || 'normal'));
  var body = div('w-text');
  body.innerHTML = cleanRich(d.html || '');
  if (!body.textContent.trim() && !body.querySelector('img,hr')) {
    body.appendChild(div('w-dim', 'Empty text block'));
  }
  // A link to another dashboard switches here (layouts.js), not a new page.
  body.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    var id = a && dashboardLinkId(a.getAttribute('href'));
    if (id && !arranging()) { e.preventDefault(); openDashboard(id); }
  });
  el.appendChild(body);
};

/** The formatting editor: {el, value()}. */
function richEditor(html) {
  var wrap = div('rt');
  var bar = div('rt-bar');
  var area = document.createElement('div');
  area.className = 'rt-area';
  area.contentEditable = 'true';
  area.innerHTML = cleanRich(html || '');
  var saved = null;   // the selection, kept while a toolbar control has focus

  function keep() {
    var s = window.getSelection();
    if (s && s.rangeCount && area.contains(s.anchorNode)) { saved = s.getRangeAt(0).cloneRange(); }
  }
  function back() {
    area.focus();
    if (saved) { var s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); }
  }
  function cmd(name, arg) {
    back();
    try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
    document.execCommand(name, false, arg);
    keep();
  }
  area.addEventListener('keyup', keep);
  area.addEventListener('mouseup', keep);
  area.addEventListener('input', keep);

  function btn(label, title, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'rt-b'; b.innerHTML = label; b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the selection
    b.addEventListener('click', fn);
    bar.appendChild(b);
    return b;
  }
  function sel(title, options, fn) {
    var s = document.createElement('select');
    s.className = 'rt-s'; s.title = title; s.setAttribute('aria-label', title);
    options.forEach(function (o) {
      var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; s.appendChild(op);
    });
    s.addEventListener('focus', keep);
    s.addEventListener('change', function () { fn(s.value); s.selectedIndex = 0; });
    bar.appendChild(s);
    return s;
  }
  function colour(title, fn) {
    var lab = document.createElement('label');
    lab.className = 'rt-c'; lab.title = title;
    var i = document.createElement('input');
    i.type = 'color'; i.setAttribute('aria-label', title);
    i.addEventListener('focus', keep);
    i.addEventListener('input', function () { fn(i.value); });
    lab.appendChild(i);
    bar.appendChild(lab);
  }
  function sep() { bar.appendChild(div('rt-sep')); }

  sel('Paragraph style', [['', 'Style'], ['p', 'Paragraph'], ['h1', 'Heading 1'], ['h2', 'Heading 2'],
                          ['h3', 'Heading 3'], ['blockquote', 'Quote'], ['pre', 'Code']],
      function (v) { if (v) { cmd('formatBlock', '<' + v + '>'); } });
  sel('Text size', [['', 'Size'], ['12px', 'Small'], ['15px', 'Normal'], ['19px', 'Large'], ['24px', 'Larger'],
                    ['32px', 'Huge']], function (v) {
    if (!v) { return; }
    // execCommand only knows <font size>; mark with size 7, then turn those into spans.
    cmd('fontSize', 7);
    area.querySelectorAll('font[size="7"], span[style*="xxx-large"]').forEach(function (f) {
      var s = document.createElement('span');
      s.style.fontSize = v;
      while (f.firstChild) { s.appendChild(f.firstChild); }
      f.replaceWith(s);
    });
    keep();
  });
  sep();
  btn('<b>B</b>', 'Bold', function () { cmd('bold'); });
  btn('<i>I</i>', 'Italic', function () { cmd('italic'); });
  btn('<u>U</u>', 'Underline', function () { cmd('underline'); });
  btn('<s>S</s>', 'Strikethrough', function () { cmd('strikeThrough'); });
  colour('Text colour', function (v) { cmd('foreColor', v); });
  colour('Highlight', function (v) { cmd('hiliteColor', v); });
  sep();
  btn('&#8676;', 'Align left', function () { cmd('justifyLeft'); });
  btn('&#8596;', 'Centre', function () { cmd('justifyCenter'); });
  btn('&#8677;', 'Align right', function () { cmd('justifyRight'); });
  sep();
  btn('&#8226;', 'Bulleted list', function () { cmd('insertUnorderedList'); });
  btn('1.', 'Numbered list', function () { cmd('insertOrderedList'); });
  btn('&#8677;&#xFE0E;', 'Indent', function () { cmd('indent'); });
  btn('&#8676;&#xFE0E;', 'Outdent', function () { cmd('outdent'); });
  sep();

  // Link and picture: an address box under the toolbar, not a browser prompt.
  var ask = div('rt-ask');
  ask.hidden = true;
  var askIn = document.createElement('input');
  askIn.type = 'text';
  var askOk = document.createElement('button');
  askOk.type = 'button'; askOk.textContent = 'Insert';
  var askNo = document.createElement('button');
  askNo.type = 'button'; askNo.textContent = 'Cancel';
  ask.appendChild(askIn); ask.appendChild(askOk); ask.appendChild(askNo);
  var askFor = null;
  function askOpen(kind) {
    keep();
    askFor = kind;
    askIn.value = '';
    askIn.placeholder = kind === 'link' ? 'https://…, mailto:…, or /?dashboard=<id>' : 'https://… picture address';
    askOk.textContent = kind === 'link' ? 'Link' : 'Insert picture';
    ask.hidden = false;
    askIn.focus();
  }
  function askDone(go) {
    var v = askIn.value.trim();
    ask.hidden = true;
    if (!go || !v) { back(); return; }
    if (askFor === 'link') {
      if (!/^(https?:\/\/|mailto:)/i.test(v) && !dashboardLinkId(v)) { v = 'https://' + v; }
      cmd('createLink', v);
    } else if (/^https:\/\//.test(v)) {
      cmd('insertImage', v);
    }
  }
  askOk.addEventListener('click', function () { askDone(true); });
  askNo.addEventListener('click', function () { askDone(false); });
  askIn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); askDone(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askDone(false); }
  });
  btn('&#128279;', 'Link', function () { askOpen('link'); });
  btn('&#10005;&#128279;', 'Remove link', function () { cmd('unlink'); });
  btn('&#128444;', 'Picture from an address', function () { askOpen('image'); });
  btn('&#8213;', 'Divider line', function () { cmd('insertHorizontalRule'); });
  btn('&#10227;', 'Clear formatting', function () { cmd('removeFormat'); cmd('formatBlock', '<p>'); });

  // Pasted text keeps its basic formatting, minus anything the allowlist drops.
  area.addEventListener('paste', function (e) {
    var h = e.clipboardData && e.clipboardData.getData('text/html');
    if (!h) { return; }
    e.preventDefault();
    document.execCommand('insertHTML', false, cleanRich(h));
  });

  wrap.appendChild(bar);
  wrap.appendChild(ask);
  wrap.appendChild(area);
  return { el: wrap, value: function () { return cleanRich(area.innerHTML); } };
}
