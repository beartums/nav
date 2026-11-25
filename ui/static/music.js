// music.js -- music libraries, self-service: Menu -> My music libraries.
//
// One of nav's page scripts (classic, shared globals; see widgets.js). Server
// half: /api/music (api/music.py). Each library is a pressed button: on = you
// see it. A click saves and nav changes every music app at once (Jellyfin, Plex,
// Navidrome, Music Assistant); the indicators say whether each app agrees.
// Libraries an admin switched off for you aren't offered. Access -> Music
// (access.js) is the admin side.
'use strict';

var MUSIC_ON = false;        // the server's NAV_MUSIC_LIBRARIES (main.js, from /api/apps)

// One app's state for one person, as an indicator; the words are its hover text.
var MUSIC_STATE = {
  ok: ['✓', 'acc-ind-user', 'matches'],
  drift: ['⚠', 'acc-ind-stale', 'differs'],
  fixed: ['★', 'acc-ind-admin', 'sees every library'],
  none: ['–', 'acc-ind-notyet', 'no account'],
  error: ['✕', 'acc-ind-missing', "couldn't be read"]
};
function musicAppInd(a) {
  var s = MUSIC_STATE[a.state] || MUSIC_STATE.error;
  var sp = document.createElement('span');
  sp.className = 'acc-ind mus-ind ' + s[1] + ' mus-ind-' + a.state;
  sp.dataset.app = a.key;
  sp.textContent = s[0];
  sp.title = a.label + ': ' + s[2] + (a.detail && a.detail !== s[2] ? ' — ' + a.detail : '');
  sp.setAttribute('role', 'img');
  sp.setAttribute('aria-label', sp.title);
  return sp;
}

function musicDialog() {
  EDITING = '__music__';
  PASTE_TARGET = null;
  document.getElementById('editor-title').textContent = 'My music libraries';
  var note = document.getElementById('editor-note');
  note.textContent = '';
  editorBody.innerHTML = '';
  var save = document.getElementById('editor-save');
  save.textContent = 'Close';
  save.onclick = closeEditor;
  var box = document.createElement('div');
  box.className = 'mus-box';
  box.textContent = 'Loading…';
  editorBody.appendChild(box);
  var busy = false;

  function draw(v) {
    box.innerHTML = '';
    if (!v.enabled) { box.textContent = 'Music libraries are off on this server.'; return; }
    if (v.person === null) { box.textContent = "nav can't find you in Authentik under this sign-in."; return; }
    var hint = document.createElement('div');
    hint.className = 'note';
    hint.textContent = 'The libraries you see in every music app. A click changes all of them at once.';
    box.appendChild(hint);

    var appsRow = document.createElement('div');
    appsRow.className = 'mus-apps';
    v.apps.forEach(function (a) {
      var one = document.createElement('span');
      one.className = 'mus-app';
      one.appendChild(musicAppInd(a));
      one.appendChild(document.createTextNode(' ' + a.label));
      appsRow.appendChild(one);
    });
    box.appendChild(appsRow);

    var libs = v.libraries.filter(function (l) { return !l.blocked; });
    var grid = document.createElement('div');
    grid.className = 'mus-libs';
    libs.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mus-lib';
      b.dataset.folder = l.folder;
      b.textContent = l.folder;
      b.setAttribute('aria-pressed', String(!l.hidden));
      var where = v.apps.filter(function (a) { return a.folders.indexOf(l.folder) >= 0; })
        .map(function (a) { return a.label; });
      b.title = (l.hidden ? 'Hidden. Click to show it' : 'Shown. Click to hide it') +
        (where.length ? ' (in ' + where.join(', ') + ')' : '');
      b.addEventListener('click', function () {
        if (busy) { return; }
        var hidden = v.libraries.filter(function (x) { return x.hidden !== (x.folder === l.folder); })
          .map(function (x) { return x.folder; });
        send(hidden);
      });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var off = v.libraries.length - libs.length;
    if (off) {
      box.appendChild(Object.assign(document.createElement('div'), {
        className: 'note', textContent: off + ' more librar' + (off === 1 ? 'y is' : 'ies are') + ' off for you (an admin chose).'
      }));
    }
  }
  function send(hidden) {
    busy = true;
    note.textContent = 'Changing your music apps…';
    [].forEach.call(box.querySelectorAll('.mus-lib'), function (b) { b.disabled = true; });
    connSend('PUT', 'api/music', { hidden: hidden }).then(function (v) {
      draw(v);
      var bad = (v.results || []).filter(function (r) { return !r.ok; });
      note.textContent = bad.length
        ? bad.map(function (r) { return r.app + ': ' + r.detail; }).join('; ')
        : ((v.results || []).length ? 'Done.' : 'Saved.');
    }, function (e) {
      note.textContent = e.message;
      [].forEach.call(box.querySelectorAll('.mus-lib'), function (b) { b.disabled = false; });
    }).then(function () { busy = false; });
  }

  connSend('GET', 'api/music').then(draw, function (e) { box.textContent = 'Could not read your libraries: ' + e.message; });
  document.body.classList.add('editing');
  editor.style.left = Math.max(12, innerWidth / 2 - 200) + 'px';
  editor.style.top = '90px';
}
