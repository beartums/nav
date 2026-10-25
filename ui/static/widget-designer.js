// widget-designer.js -- define a widget and preview it (roadmap #34, step 2).
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Loads
// after editor.js, whose movable dialog it reuses, and widgets.js, whose
// renderers it calls.
//
// The form is GENERATED from each provider's config_schema, so a new provider
// needs no change here. Save writes a DEFINITION to the library (the admin
// sidebar); placing it in a group is done from there (widget-layout.js).
//
// `existing` is a definition from api/widgets to edit, or null for a new one.
// A new widget is the LIBRARY's in admin mode and the caller's own in edit
// mode; an existing one stays whichever it was (`mine`).
//
// `placement` (edit mode, from the widget's ✎ on the page): edit THAT placed
// widget only. The server edits your own widget in place when nothing else
// shows it, and otherwise makes a copy of your own for this spot -- a library
// widget never changes under anyone else.
// An existing widget's TYPE is fixed: its config only means anything to the
// provider it was written for.
'use strict';

function widgetDesigner(existing, placement, opts) {
  opts = opts || {};
  EDITING = '__widgets__';
  var inPlace = !!placement;
  var personal = existing ? !!existing.mine : !ADMIN_MODE;
  var base = personal ? 'api/widgets' : 'api/admin/widgets';
  PASTE_TARGET = null;
  document.getElementById('editor-title').textContent =
    inPlace ? 'Edit this widget' :
    (existing ? 'Edit ' : 'New ') + (personal ? 'personal widget' : 'widget');
  var note = document.getElementById('editor-note');
  note.textContent = '';
  editorBody.innerHTML = '';
  editor.classList.add('wide');

  var titleField = field('Name', existing ? existing.title : '', personal ? 'only you see it' : 'shown in the library');
  titleField.input.id = 'wd-title';
  editorBody.appendChild(titleField.label);
  if (inPlace) {
    var shared = !existing.mine || WIDGETS.placements.filter(function (q) {
      return q.def_id === existing.id; }).length > 1;
    var why = document.createElement('div');
    why.className = 'note';
    why.id = 'wd-in-place';
    why.textContent = shared
      ? 'Changes this one only: it becomes a widget of your own, and everywhere else keeps the original.'
      : 'Changes this widget on \u201c' + (LAYOUT ? LAYOUT.name : 'this dashboard') + '\u201d.';
    editorBody.appendChild(why);
  }

  var typeSel = document.createElement('select');
  typeSel.id = 'wd-type';
  typeSel.disabled = !!existing;
  var typeLabel = document.createElement('label');
  typeLabel.textContent = 'Widget type';
  typeLabel.appendChild(typeSel);
  editorBody.appendChild(typeLabel);
  var desc = document.createElement('div');
  desc.className = 'note';
  editorBody.appendChild(desc);
  // Ready-made definitions (a provider's `presets`): picking one fills the
  // form, which stays editable. New widgets only.
  var presetSel = document.createElement('select');
  presetSel.id = 'wd-preset';
  var presetLabel = document.createElement('label');
  presetLabel.textContent = 'Start from';
  presetLabel.appendChild(presetSel);
  presetLabel.hidden = true;
  editorBody.appendChild(presetLabel);
  var form = document.createElement('div');
  form.id = 'wd-form';
  editorBody.appendChild(form);
  var actions = document.createElement('div');
  actions.className = 'wd-actions';
  var pbtn = document.createElement('button');
  pbtn.type = 'button';
  pbtn.id = 'wd-preview-btn';
  pbtn.textContent = 'Preview';
  actions.appendChild(pbtn);
  if (existing && !inPlace) {
    var del = document.createElement('button');
    del.type = 'button';
    del.id = 'wd-delete';
    del.className = 'danger';
    del.textContent = 'Delete widget';
    del.addEventListener('click', function () {
      var n = WIDGETS.placements.filter(function (p) { return p.def_id === existing.id; }).length;
      if (!confirm('Delete \u201c' + existing.title + '\u201d' +
                   (n ? ' and remove it from ' + n + ' group(s)' : '') + '?')) { return; }
      api('DELETE', base + '/' + existing.id)
        .then(function () { closeEditor(); return reloadWidgets(); })
        .catch(function (e) { note.textContent = e.message; });
    });
    actions.appendChild(del);
  }
  // AUDIENCE (library widgets): groups who see this widget's data without the
  // app it reads -- the family's calendar without a Sonarr login.
  var audField = null;
  if (!personal && !inPlace) {
    audField = field('Also show to', (existing && existing.audience || []).join(', '),
                     'Authentik groups, comma-separated, or * for everyone signed in');
    audField.input.id = 'wd-audience';
    var audNote = document.createElement('div');
    audNote.className = 'note';
    audNote.textContent = 'Overrides the app check for this widget only: these people see its ' +
                          'data even if they cannot open the app it comes from.';
    editorBody.appendChild(audField.label);
    editorBody.appendChild(audNote);
  }
  editorBody.appendChild(actions);
  var preview = document.createElement('div');
  preview.id = 'wd-preview';
  editorBody.appendChild(preview);

  // Label picker: what the query actually returns, offered as {{label}} for
  // the fields marked `template` (line names, the text after a value).
  var labelBox = document.createElement('div');
  labelBox.id = 'wd-labels';
  labelBox.hidden = true;
  form.insertAdjacentElement('afterend', labelBox);

  var TYPES = [], inputs = {}, lastTemplate = null;

  function fillPresets(t) {
    presetSel.innerHTML = '';
    var list = (!existing && t && t.presets) || [];
    presetLabel.hidden = !list.length;
    if (!list.length) { return; }
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'Blank';
    presetSel.appendChild(none);
    list.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.title;
      presetSel.appendChild(o);
    });
  }

  function buildForm(seed) {
    var t = TYPES[typeSel.selectedIndex];
    if (seed === undefined) { fillPresets(t); }
    form.innerHTML = '';
    preview.innerHTML = '';
    labelBox.hidden = true;
    inputs = {};
    lastTemplate = null;
    if (!t) { return; }
    desc.textContent = t.description || '';
    Object.keys(t.config_schema).forEach(function (name) {
      var spec = t.config_schema[name];
      var lab = document.createElement('label');
      lab.textContent = (spec.label || name) + (spec.required ? ' *' : '');
      var input;
      if (spec.type === 'enum') {
        input = document.createElement('select');
        spec.choices.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c; o.textContent = c;
          input.appendChild(o);
        });
        if (spec['default'] != null) { input.value = spec['default']; }
      } else if (spec.type === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!spec['default'];
      } else if (name === 'query') {
        // PromQL gets room: these are rarely short.
        input = document.createElement('textarea');
        input.rows = 3;
        input.spellcheck = false;
      } else {
        input = document.createElement('input');
        input.type = spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text';
        if (spec.type === 'integer') { input.step = '1'; }
        if (spec['default'] != null) { input.value = spec['default']; }
      }
      var have = seed ? seed[name] : existing && existing.config ? existing.config[name] : undefined;
      if (have != null) {
        if (spec.type === 'bool') { input.checked = !!have; } else { input.value = have; }
      }
      input.dataset.field = name;
      if (spec.template) {
        // Remember which template field was last used, so a click on a label
        // lands where the person was typing.
        input.addEventListener('focus', function () { lastTemplate = input; });
      }
      inputs[name] = { input: input, spec: spec };
      if (spec.type === 'bool') {
        // The box beside its words, as editor.js's checkbox() does.
        lab.textContent = '';
        lab.style.cssText = 'display:flex; flex-direction:row; align-items:center; gap:7px;';
        var words = document.createElement('span');
        words.textContent = (spec.label || name) + (spec.required ? ' *' : '');
        lab.appendChild(input);
        lab.appendChild(words);
      } else {
        lab.appendChild(input);
      }
      form.appendChild(lab);
    });
  }

  // Only set fields are sent: the server applies defaults, and an empty
  // number box must mean "not set", not 0.
  function config() {
    var out = {};
    Object.keys(inputs).forEach(function (name) {
      var f = inputs[name], t = f.spec.type, el = f.input;
      if (t === 'bool') { out[name] = el.checked; return; }
      var v = el.value.trim();
      if (v === '') { return; }
      out[name] = t === 'integer' ? parseInt(v, 10) : t === 'number' ? Number(v) : v;
    });
    return out;
  }

  // 400 / 403 / 422 carry the server's reason in `detail`; show it, because
  // "POST failed 400" tells nobody which field is wrong.
  function send(method, path, body) {
    return fetch(path, {
      method: method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) {
          var d = b.detail;
          throw new Error((typeof d === 'string' ? d : null) || (method + ' failed: ' + r.status));
        }
        return b;
      });
    });
  }

  function insertLabel(key) {
    var target = lastTemplate;
    if (!target) {
      var first = Object.keys(inputs).find(function (n) { return inputs[n].spec.template; });
      target = first && inputs[first].input;
    }
    if (!target) { return; }
    var tag = '{{' + key + '}}';
    var at = target.selectionStart != null ? target.selectionStart : target.value.length;
    var end = target.selectionEnd != null ? target.selectionEnd : at;
    target.value = target.value.slice(0, at) + tag + target.value.slice(end);
    target.focus();
    if (target.setSelectionRange) { target.setSelectionRange(at + tag.length, at + tag.length); }
  }

  function loadLabels(t) {
    var wants = Object.keys(inputs).some(function (n) { return inputs[n].spec.template; });
    if (!wants) { labelBox.hidden = true; return; }
    send('POST', 'api/widgets/labels', { type: t.type, config: config() }).then(function (b) {
      labelBox.innerHTML = '';
      var keys = Object.keys(b.labels || {});
      var head = document.createElement('div');
      head.className = 'note';
      head.textContent = b.error ? 'Labels: ' + b.error
        : keys.length ? 'Labels in the result \u2014 click to insert as {{label}}:'
        : 'This result has no labels to name things by. Keep them with by (...) in the query.';
      labelBox.appendChild(head);
      keys.forEach(function (k) {
        var info = b.labels[k];
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'wd-label';
        chip.dataset.label = k;
        var strong = document.createElement('strong');
        strong.textContent = k;
        chip.appendChild(strong);
        var more = info.count > info.values.length ? ', +' + (info.count - info.values.length) : '';
        chip.appendChild(document.createTextNode(' ' + info.values.join(', ') + more));
        chip.title = info.count + ' distinct value' + (info.count === 1 ? '' : 's');
        // mousedown, not click: it fires before the field loses focus, so
        // `lastTemplate` is still the field being edited.
        chip.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        chip.addEventListener('click', function () { insertLabel(k); });
        labelBox.appendChild(chip);
      });
      labelBox.hidden = false;
    }).catch(function () { labelBox.hidden = true; });
  }

  function run() {
    var t = TYPES[typeSel.selectedIndex];
    if (!t) { return; }
    note.textContent = 'Loading\u2026';
    send('POST', 'api/widgets/preview', { type: t.type, config: config() })
      .then(function (payload) { note.textContent = ''; renderWidget(preview, payload); })
      .catch(function (e) { note.textContent = e.message; });
    loadLabels(t);
  }

  function save() {
    var t = TYPES[typeSel.selectedIndex];
    if (!t) { return; }
    var cfg = config();
    // Default the name from what the widget will show, so a quick save is
    // still findable in the library.
    var title = titleField.input.value.trim() || cfg.headline || t.title || t.type;
    var body = { type: t.type, title: title, config: cfg };
    if (audField) {
      body.audience = audField.input.value.split(',')
        .map(function (g) { return g.trim(); }).filter(Boolean);
    }
    (inPlace ? send('PUT', layoutPath('/placements/' + placement + '/widget'),
                    { title: title, config: cfg })
      : existing ? send('PUT', base + '/' + existing.id, body) : send('POST', base, body))
      .then(function (r) {
        // An edited config must not be shown from the old cached data.
        if (existing) { delete WIDGET_DATA[existing.id]; }
        closeEditor();
        return reloadWidgets().then(function () {
          // Made by dropping "New widget" on the page: place it there.
          if (!existing && !inPlace && opts.onCreate && r && r.id != null) { opts.onCreate(r.id); }
        });
      })
      .catch(function (e) { note.textContent = e.message; });
  }

  typeSel.addEventListener('change', function () { buildForm(); });
  var presetTitle = '';
  presetSel.addEventListener('change', function () {
    var t = TYPES[typeSel.selectedIndex];
    var p = presetSel.value === '' ? null : t.presets[Number(presetSel.value)];
    buildForm(p ? p.config : null);
    // The preset's name, unless the person already typed their own.
    var cur = titleField.input.value.trim();
    if (!cur || cur === presetTitle) {
      titleField.input.value = p ? p.title : '';
      presetTitle = p ? p.title : '';
    }
    if (p) { run(); }
  });
  pbtn.addEventListener('click', run);
  document.getElementById('editor-save').textContent = 'Save';
  document.getElementById('editor-save').onclick = save;

  fetch('api/widgets/types').then(function (r) { return r.json(); }).then(function (b) {
    TYPES = (b && b.types) || [];
    TYPES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.type;
      o.textContent = t.title || t.type;
      typeSel.appendChild(o);
    });
    if (!TYPES.length) { desc.textContent = 'No widget types are available to you.'; }
    if (existing) {
      var at = TYPES.map(function (t) { return t.type; }).indexOf(existing.type);
      if (at === -1) {
        desc.textContent = 'This widget\u2019s type (' + existing.type + ') is not available ' +
                           'to you or no longer exists. You can still delete it.';
        document.getElementById('editor-save').disabled = true;
        return;
      }
      typeSel.selectedIndex = at;
    }
    buildForm();
    if (existing) { run(); }
  }).catch(function (e) { note.textContent = 'Could not load widget types: ' + e.message; });

  document.body.classList.add('editing');
  editor.style.left = Math.max(12, innerWidth / 2 - 280) + 'px';
  editor.style.top = '70px';
}
