// Load nav's real page in a DOM and click things.
//
// WHY THIS EXISTS
//   Every nav bug on 2026-09-28/29 got through a check that said "the
//   JavaScript parses". All of them were legal JavaScript:
//
//     * `appendChild` reparents, so a following `removeChild` threw and took
//       every tile click down with it -- the edit dialog simply stopped opening
//     * two `function load()` in one scope; the last won, so `var opts = load()`
//       received a Promise and every view option read undefined
//     * the admin branch returned before the icon and label were appended, so
//       admin tiles rendered as empty boxes
//     * an unscoped `ul { display:grid }` also matched the menu, and an author
//       `display` beats the UA `[hidden] { display:none }` -- so the menu could
//       not be closed
//     * the tile rejected `data:` icons, so every upload silently did nothing
//
//   Parsing finds none of those. Rendering the page and using it finds all of
//   them, which is the difference between a syntax check and a test.
//
//   The page under test is ui/ (index.html + static/): the files the image
//   serves, so testing the source is testing what ships.
//
// Usage:  cd tests && npm ci && npm test
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const PAGE = new URL('../ui/index.html', import.meta.url);

// The page loads its CSS and scripts from /static/ (split out 2026-10-10).
// jsdom would fetch those from nav.example.com, so inline them from the
// source tree instead -- same bytes, same order, no network. A tag naming a
// file that does not exist throws here, which is the point: it would 404 live.
const pageHtml = () => readFileSync(PAGE, 'utf8')
  .replace(/<link rel="stylesheet" href="\/static\/([\w.-]+)">/g, (_, f) =>
    `<style>${readFileSync(new URL(`../ui/static/${f}`, import.meta.url), 'utf8')}</style>`)
  .replace(/<script src="\/static\/([\w.-]+)"><\/script>/g, (_, f) =>
    `<script>${readFileSync(new URL(`../ui/static/${f}`, import.meta.url), 'utf8')}</script>`);

const APPS = {
  user: 'evan@example.com',
  admin: true,
  may_impersonate: true,
  apps: [
    {
      slug: 'sonarr', name: 'Sonarr', url: 'https://sonarr.example.com',
      description: 'TV collection manager', category: 'Media',
      icon: '', clicks_mine: 3, clicks_all: 9, order: 0,
      base: { name: 'Sonarr', description: 'TV collection manager', category: 'Media', icon: '' },
      override: {}
    },
    {
      slug: 'books', name: 'Calibre-Web', url: 'https://books.example.com',
      description: 'Ebook library', category: 'Media',
      // A stored upload. The tile used to reject this and fall back to
      // icons/<slug>.svg, which is why uploads appeared to do nothing.
      icon: 'data:image/png;base64,iVBORw0KGgo=', clicks_mine: 1, clicks_all: 2, order: 1,
      base: { name: 'Calibre-Web', description: 'Ebook library', category: 'Media', icon: '' },
      override: { icon: 'data:image/png;base64,iVBORw0KGgo=' }
    }
  ]
};

// Every page booted, closed at the end. Widgets schedule refreshes on their
// ttl (30-60 s, re-armed while on screen), and an open jsdom window keeps those
// timers -- and so the test process -- alive indefinitely.
const WINDOWS = [];
after(() => { WINDOWS.forEach((w) => w.close()); });

const DEFAULT_LAYOUT = { id: 1, kind: 'template', name: 'Default', template_id: null,
                         is_default: true, group_order: [], group_hidden: [] };
const LAYOUT_LIST = { templates: [{ id: 1, name: 'Default', is_default: true },
                                  { id: 2, name: 'Family', is_default: false }], dashboards: [] };

/** Boot the page with every network call stubbed, and wait for first paint. */
async function boot(payload = APPS, fail = null, bodyFor = null, setup = null) {
  const seen = [];
  // beforeParse, NOT after construction: the page fetches as soon as its
  // script runs, which is during parsing. Installing the stub afterwards left
  // the real (absent) fetch to handle the only call that matters, and every
  // assertion failed on an empty page for the wrong reason.
  const dom = new JSDOM(pageHtml(), {
    runScripts: 'dangerously',
    url: 'https://nav.example.com/',
    pretendToBeVisual: true,
    beforeParse(window) {
      // `setup` runs before the page does: seed localStorage, stub confirm.
      if (setup) { setup(window); }
      // jsdom has no matchMedia; the page asks on every render and when
      // choosing between the light and dark icon.
      window.matchMedia = () => ({
        matches: false, addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}
      });
      window.fetch = (url, opts = {}) => {
        seen.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
        const u = String(url);
        const body =
          u.startsWith('api/apps') && /as_user=|as_group=/.test(u) ? (() => {
            const q = new URLSearchParams(u.split('?')[1] || '');
            const user = q.get('as_user');
            const groups = q.getAll('as_group');
            const own = { slug: 'sonarr', name: 'Sonarr', url: 'https://s.example',
                          description: 'TV', category: 'Media', icon: '',
                          clicks_mine: 0, clicks_all: 0, order: 0 };
            const fromGroup = { slug: 'books', name: 'Calibre-Web', url: 'https://b.example',
                                description: 'Ebook library', category: 'Media', icon: '',
                                clicks_mine: 0, clicks_all: 0, order: 1 };
            const apps = [];
            if (user) { apps.push(own); }
            if (groups.length) {
              apps.push(user ? { ...fromGroup, added: true } : fromGroup);
            }
            const label = user && groups.length
              ? user + ' plus ' + groups.map((g) => '\u201c' + g + '\u201d').join(', ')
              : user || ('anyone whose only group' + (groups.length > 1 ? 's are ' : ' is ') +
                         groups.map((g) => '\u201c' + g + '\u201d').join(', '));
            return {
              user: 'evan@example.com', admin: true, may_impersonate: true,
              impersonating: {
                kind: user && groups.length ? 'both' : user ? 'user' : 'group',
                subject: label, user: user || null, groups,
                undetermined: groups.includes('family') ? ['weirdapp'] : [],
                added: user && groups.length ? ['books'] : []
              },
              apps
            };
          })() :
          // Every reply since templates names its layout; fixtures that
          // predate it get the default template.
          u.startsWith('api/apps') ? { layout: DEFAULT_LAYOUT, ...payload } :
          /^api\/layouts(\?|$)/.test(u) ? LAYOUT_LIST :
          u.startsWith('api/admin/principals') ? {
            groups: ['family', 'staff-media', 'nav-admins'],
            users: [{ email: 'evan@example.com', name: 'Evan' },
                    { email: 'mom@example.com', name: 'Mom' }],
            all_groups: ['family', 'staff-media', 'nav-admins', 'noisy-service-group'],
            all_users: [{ email: 'evan@example.com', name: 'Evan' },
                        { email: 'mom@example.com', name: 'Mom' },
                        { email: 'svc@example.com', name: 'Service Account' }],
            curated: true
          } :
          u.startsWith('api/version') ? { version: 'abc1234def', built_at: '2026-09-29T11:22:33Z' } :
          u.startsWith('api/site') ? {} : {};
        // `fail` lets a test make one route error, to check the page degrades
        // rather than wedging.
        // `bodyFor` replaces the body for one route, to test how the page
        // handles a well-formed reply it did not expect.
        const swap = bodyFor && bodyFor(u);
        const bad = fail && fail(u);
        if (bad) {
          return Promise.resolve({
            ok: false, status: bad.status || 500,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve('')
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          // A COPY per call. A real response is fresh JSON every time; handing
          // back the same object graph let the page's in-place staging edits
          // mutate the fixture, so a re-read after Cancel returned the very
          // values Cancel had just discarded -- a harness artifact that reads
          // exactly like a broken Cancel.
          json: () => Promise.resolve(JSON.parse(JSON.stringify(swap || body))),
          text: () => Promise.resolve('')
        });
      };
    }
  });
  const { window } = dom;
  WINDOWS.push(window);
  await settle(window, () => window.document.querySelectorAll('a.app').length > 0);
  return { window, doc: window.document, seen };
}

/** Let promise chains drain until `cond` holds, or give up with a clear message. */
async function settle(window, cond, what = 'condition', turns = 40) {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise((r) => window.setTimeout(r, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Enter admin mode the way a person does -- the page's functions live in an
 *  IIFE and are deliberately not reachable from outside. */
async function enterAdmin(window, doc) {
  click(doc.getElementById('menu-btn'));
  const item = [...doc.querySelectorAll('#menu-list button')]
    .find((b) => b.textContent.startsWith('Administration'));
  assert.ok(item, 'Administration entry should be in the menu for an admin');
  click(item);
  // Wait for something only the admin RE-RENDER produces. The `admin-mode`
  // class is set synchronously and the old tiles are still on the page, so
  // waiting on either returns immediately and the assertions then run against
  // the pre-admin DOM -- which looked like a page bug and was a race in here.
  await settle(window,
    () => {
      const t = doc.querySelector('a.app');
      return t && !t.hasAttribute('href');
    },
    'tiles to be re-rendered in admin mode');
}

const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));

/** Drive an HTML5 drag from one tile onto another.
 *
 *  jsdom implements neither DragEvent nor DataTransfer, so this synthesises
 *  both. That means it does NOT prove Chrome will start a drag -- but it does
 *  prove what actually broke three times: that the drop target cancels
 *  dragenter and dragover (Chrome silently refuses to drop on an element that
 *  does not) and that the resulting reorder sends the right payload.
 */
function drag(window, fromAnchor, ontoLi) {
  const dt = {
    effectAllowed: 'none', dropEffect: 'none',
    _d: {},
    setData(t, v) { this._d[t] = String(v); },
    getData(t) { return this._d[t] || ''; },
    setDragImage() {}
  };
  const fire = (el, type) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    ev.dataTransfer = dt;
    ev.relatedTarget = null;
    el.dispatchEvent(ev);
    return ev;
  };
  fire(fromAnchor, 'dragstart');
  const enter = fire(ontoLi, 'dragenter');
  const over = fire(ontoLi, 'dragover');
  fire(ontoLi, 'drop');
  fire(fromAnchor, 'dragend');
  return { enter, over, dt };
}

test('tiles render with a name and an icon', async () => {
  const { doc } = await boot();
  const tiles = doc.querySelectorAll('a.app');
  assert.equal(tiles.length, 2, 'both apps should render');
  const names = [...doc.querySelectorAll('a.app .name')].map((n) => n.textContent);
  assert.deepEqual(names.sort(), ['Calibre-Web', 'Sonarr']);
  for (const t of tiles) {
    assert.ok(t.querySelector('img.icon'), 'every tile needs an icon element');
  }
});

test('a data: icon is used, not replaced by the bundled fallback', async () => {
  const { doc } = await boot();
  const srcs = [...doc.querySelectorAll('a.app img.icon')].map((i) => i.getAttribute('src'));
  assert.ok(
    srcs.some((s) => s.startsWith('data:image/')),
    `an uploaded data: icon must survive to the img; got ${JSON.stringify(srcs)}`
  );
});

test('the view menu opens and closes', async () => {
  const { doc } = await boot();
  const btn = doc.getElementById('menu-btn');
  const list = doc.getElementById('menu-list');
  assert.equal(list.hidden, true, 'menu starts closed');
  click(btn);
  assert.equal(list.hidden, false, 'menu opens');
  click(btn);
  assert.equal(list.hidden, true, 'menu closes again');
});

test('the menu offers About, and Administration for an admin', async () => {
  const { doc } = await boot();
  click(doc.getElementById('menu-btn'));
  const labels = [...doc.querySelectorAll('#menu-list button')].map((b) => b.textContent);
  assert.ok(labels.some((l) => l.startsWith('About')), `About missing: ${labels}`);
  assert.ok(labels.some((l) => l.startsWith('Administration')), `Administration missing: ${labels}`);
});

test('admin tiles keep their content', async () => {
  // The admin branch once returned before the icon and label were appended.
  const { doc, window } = await boot();
  await enterAdmin(window, doc);
  const tiles = doc.querySelectorAll('a.app');
  assert.ok(tiles.length > 0, 'tiles should still render in admin mode');
  for (const t of tiles) {
    assert.ok(t.querySelector('img.icon, .icon.letter'), 'admin tile lost its icon');
    assert.ok(t.querySelector('.name'), 'admin tile lost its name');
  }
});

test('admin tiles do not navigate', async () => {
  const { doc, window } = await boot();
  await enterAdmin(window, doc);
  for (const t of doc.querySelectorAll('a.app')) {
    assert.equal(t.hasAttribute('href'), false, 'href must be gone so ctrl/middle click cannot navigate');
  }
});

test('clicking a tile in admin mode opens the editor', async () => {
  // This is the removeChild regression: openEditor threw, so the dialog never
  // appeared and the only evidence was in the console.
  const { doc, window } = await boot();
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  await enterAdmin(window, doc);

  click(doc.querySelector('a.app'));
  assert.deepEqual(errors, [], 'opening the editor must not throw');
  assert.ok(doc.body.classList.contains('editing'), 'the editor should be visible');
  assert.ok(doc.querySelectorAll('#editor-body input[type=text]').length >= 4,
    'editor should show name, description, category and both icon fields');
});

test('the editor closes from the X and from Cancel', async () => {
  const { doc, window } = await boot();
  await enterAdmin(window, doc);

  click(doc.querySelector('a.app'));
  assert.ok(doc.body.classList.contains('editing'));
  click(doc.getElementById('editor-close'));
  assert.equal(doc.body.classList.contains('editing'), false, 'the X must close it');

  click(doc.querySelector('a.app'));
  click(doc.getElementById('editor-cancel'));
  assert.equal(doc.body.classList.contains('editing'), false, 'Cancel must close it');
});

test('About reports a short sha and a locally formatted time', async () => {
  const { doc, window } = await boot();
  click(doc.getElementById('menu-btn'));
  const about = [...doc.querySelectorAll('#menu-list button')].find((b) => b.textContent.startsWith('About'));
  assert.ok(about, 'About entry should be in the menu');
  click(about);
  await settle(window, () => /abc1234|Could not/.test(doc.getElementById('editor-body').textContent),
               'the About dialog to load');
  const text = doc.getElementById('editor-body').textContent;
  assert.match(text, /abc1234/, 'short sha should be shown');
  assert.doesNotMatch(text, /2026-09-29T11:22:33Z/, 'the raw UTC string should be formatted, not printed');
});


test('dragging a tile onto another reorders within the group', async () => {
  const { window, doc, seen } = await boot();
  await enterAdmin(window, doc);

  const named = (n) => [...doc.querySelectorAll('a.app')]
    .find((a) => a.querySelector('.name').textContent === n);
  const order = () => [...doc.querySelectorAll('a.app .name')].map((n) => n.textContent);

  assert.deepEqual(order(), ['Sonarr', 'Calibre-Web'], 'starting order comes from `order`');

  const books = named('Calibre-Web');
  const sonarr = named('Sonarr');
  const { enter, over, dt } = drag(window, books, sonarr.closest('li'));

  // These three are the bug. Each was absent, and each one alone is enough for
  // Chrome to drop the drag on the floor with no error anywhere.
  assert.ok(enter.defaultPrevented,
    'dragenter must be cancelled or Chrome never makes the li a drop target');
  assert.ok(over.defaultPrevented, 'dragover must be cancelled to allow the drop');
  assert.equal(dt.dropEffect, 'move',
    "dropEffect must match dragstart's effectAllowed='move'; a mismatch resolves to none");

  await settle(window, () => order()[0] === 'Calibre-Web', 'the tiles to swap');
  assert.deepEqual(order(), ['Calibre-Web', 'Sonarr'], 'the dragged tile lands before the target');

  // One write for the whole group (tiles and widgets share one sequence in
  // the group grid), in display order -- the server numbers by position.
  const put = seen.filter((r) => r.method === 'PUT' && r.url === 'api/layouts/1/order').pop();
  assert.ok(put, 'the new order must be persisted');
  assert.deepEqual(JSON.parse(put.body),
    { category: 'Media', items: [{ app: 'books' }, { app: 'sonarr' }] },
    'the whole category is renumbered, not just the moved tile');
});

test('reordering uses the displayed order, not the order the API returned', async () => {
  // The regression this guards: reorder() renumbered APPS.filter(...) directly.
  // APPS is in API order; the grid shows sorted(...). Whenever the two differ
  // -- which is always, once anything has been dragged -- dropping one tile
  // rewrote the position of every other tile in the category. Symptom: "I
  // moved the 12th item to 2nd and the 2nd went somewhere random."
  //
  // So the fixture MUST hand back an API order that disagrees with `order`.
  // Returning them already sorted would pass against the broken code.
  const names = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  const apps = names.map((n, i) => ({
    slug: n.toLowerCase(), name: n, url: `https://${n.toLowerCase()}.example`,
    description: n, category: 'Media', icon: '', clicks_mine: 0, clicks_all: 0,
    order: i, base: { name: n, category: 'Media', icon: '' }, override: {}
  }));
  const shuffled = apps.slice().reverse();   // API order: L..A, display order: A..L

  const { window, doc, seen } = await boot({ user: 'e@x', admin: true, apps: shuffled });
  await enterAdmin(window, doc);

  const order = () => [...doc.querySelectorAll('a.app .name')].map((n) => n.textContent);
  assert.deepEqual(order(), names, 'admin mode shows positional order, not API order');

  const tileFor = (n) => [...doc.querySelectorAll('a.app')]
    .find((a) => a.querySelector('.name').textContent === n);

  // The 12th onto the 2nd.
  drag(window, tileFor('L'), tileFor('B').closest('li'));

  const expected = ['A','L','B','C','D','E','F','G','H','I','J','K'];
  await settle(window, () => order()[1] === 'L', 'L to land in 2nd place');
  assert.deepEqual(order(), expected,
    'L takes 2nd and everything from B down shifts by exactly one');

  const put = seen.filter((r) => r.method === 'PUT' && r.url === 'api/layouts/1/order').pop();
  assert.deepEqual(JSON.parse(put.body).items.map((x) => x.app), expected.map((n) => n.toLowerCase()),
    'the persisted sequence matches the displayed order, every tile in it');
});

/** Open the bulk edit table from admin mode. */
async function enterBulk(window, doc) {
  click(doc.getElementById('admin-bulk-btn'));
  await settle(window, () => !!doc.querySelector('table.bulk'), 'the bulk table to render');
  return doc.querySelector('table.bulk');
}

/** Type into a cell and commit it the way leaving the field does. */
function type(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function rowFor(doc, name) {
  return [...doc.querySelectorAll('table.bulk tbody tr')]
    .find((r) => r.querySelector('input[type=text]')?.value === name);
}

test('bulk edit lists every app with its fields exposed', async () => {
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);
  const rows = [...doc.querySelectorAll('table.bulk tbody tr')].filter((r) => !r.classList.contains('grp'));
  assert.equal(rows.length, 2, 'every app gets a row');
  assert.ok(doc.querySelector('table.bulk tr.grp'), 'rows are grouped by category');
  assert.equal(doc.getElementById('bulk-save').disabled, true,
    'Save is inert until something is actually changed');
});

test('bulk edits stage without writing, and Save sends one PUT of only the touched apps', async () => {
  const { window, doc, seen } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const row = rowFor(doc, 'Sonarr');
  const before = seen.filter((r) => r.method === 'PUT').length;
  type(window, row.querySelectorAll('input[type=text]')[0], 'Sonarr HD');

  assert.equal(seen.filter((r) => r.method === 'PUT').length, before,
    'editing a cell must NOT write -- that is the whole point of Save');
  assert.ok(row.classList.contains('dirty'), 'the changed row is marked');
  assert.equal(doc.getElementById('bulk-save').disabled, false, 'Save becomes available');

  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the save PUT');

  // A template: the name is site-wide presentation, written apart from layout.
  const put = seen.filter((r) => r.method === 'PUT' && r.url === 'api/admin/presentation').pop();
  const sent = JSON.parse(put.body).tiles;
  assert.deepEqual(Object.keys(sent), ['sonarr'], 'only the app that changed is sent');
  assert.equal(sent.sonarr.name, 'Sonarr HD');
});

test('Cancel discards staged edits and restores the snapshot', async () => {
  const { window, doc, seen } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  type(window, rowFor(doc, 'Sonarr').querySelectorAll('input[type=text]')[0], 'Wrong');
  type(window, rowFor(doc, 'Wrong').querySelectorAll('input[type=text]')[1], 'also wrong');
  click(doc.getElementById('bulk-cancel'));

  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0,
    'Cancel must not write anything at all');
  await settle(window, () => !doc.querySelector('table.bulk'), 'the table to close');
  await settle(window, () => doc.querySelectorAll('a.app').length > 0, 'the tiles to come back');
  const names = [...doc.querySelectorAll('a.app .name')].map((n) => n.textContent);
  assert.ok(names.includes('Sonarr') && !names.includes('Wrong'),
    `the discarded name must not survive; got ${JSON.stringify(names)}`);
});

test('typing a value and putting it back leaves nothing staged', async () => {
  // Dirty is recomputed against the entry snapshot, not latched. A one-way
  // flag would keep the app in the Save payload and rewrite it for no reason.
  const { window, doc, seen } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const cell = () => rowFor(doc, 'Sonarr') || rowFor(doc, 'Poked');
  type(window, cell().querySelectorAll('input[type=text]')[0], 'Poked');
  assert.equal(doc.getElementById('bulk-save').disabled, false, 'the edit registers');
  assert.ok(cell().classList.contains('dirty'));

  type(window, cell().querySelectorAll('input[type=text]')[0], 'Sonarr');
  assert.equal(doc.getElementById('bulk-save').disabled, true,
    'putting the original value back leaves nothing to save');
  assert.equal(rowFor(doc, 'Sonarr').classList.contains('dirty'), false, 'the row goes clean again');
  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0);
});

test('clearing a stored override removes the field instead of blanking it', async () => {
  // Writing back a value identical to Authentik's would freeze the app at
  // today's name and quietly stop it tracking upstream renames.
  const withOverride = {
    user: 'e@x', admin: true,
    apps: [{
      slug: 'sonarr', name: 'My Sonarr', url: 'https://s.example',
      description: 'TV', category: 'Media', icon: '', clicks_mine: 0, clicks_all: 0, order: 0,
      base: { name: 'Sonarr', description: 'TV', category: 'Media', icon: '' },
      override: { name: 'My Sonarr', icon: 'data:image/png;base64,iVBORw0KGgo=' }
    }]
  };
  const { window, doc, seen } = await boot(withOverride);
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  type(window, rowFor(doc, 'My Sonarr').querySelectorAll('input[type=text]')[0], '');
  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the save PUT');

  const sent = JSON.parse(seen.filter((r) => r.url === 'api/admin/presentation').pop().body).tiles;
  assert.equal('name' in sent.sonarr, false, 'the cleared override is removed, not stored as ""');
  assert.equal(sent.sonarr.icon, 'data:image/png;base64,iVBORw0KGgo=',
    'the untouched icon override on the same app must survive the write');
});

test('each app shows a dark and a light icon swatch that opens a picker', async () => {
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const row = rowFor(doc, 'Calibre-Web');
  const dark = row.querySelector('.swatch.dark');
  const light = row.querySelector('.swatch.light');
  assert.ok(dark && light, 'both themes get their own swatch');
  // books has a dark icon and no light one, so the light swatch inherits it.
  assert.equal(dark.querySelector('img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(light.querySelector('img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=',
    'the light swatch falls back to the dark icon, as the page does at render time');

  click(dark);
  const dlg = doc.querySelector('.icondlg-back');
  assert.ok(dlg, 'clicking a swatch opens the change dialog');
  assert.match(dlg.textContent, /Dark mode icon/);
});

test('applying an icon in the dialog stages it and marks that swatch changed', async () => {
  const { window, doc, seen } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  click(rowFor(doc, 'Sonarr').querySelector('.swatch.dark'));
  const dlg = doc.querySelector('.icondlg-back');
  const url = 'https://cdn.example/sonarr.svg';
  const input = dlg.querySelector('input[type=text]');
  input.value = url;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Apply').click();

  assert.equal(doc.querySelector('.icondlg-back'), null, 'Apply closes the dialog');
  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0,
    'Apply stages only -- Save is still the only thing that writes');

  const row = rowFor(doc, 'Sonarr');
  const dark = row.querySelector('.swatch.dark');
  assert.equal(dark.querySelector('img').getAttribute('src'), url, 'the swatch redraws immediately');
  assert.ok(dark.classList.contains('chg'), 'the changed swatch is outlined');
  assert.equal(row.querySelector('.swatch.light').classList.contains('chg'), false,
    'the untouched light swatch is not');

  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the save PUT');
  // An icon is presentation: site-wide, not the template's.
  assert.equal(JSON.parse(seen.filter((r) => r.url === 'api/admin/presentation').pop().body).tiles.sonarr.icon, url);
});

test('only the fields that changed are outlined', async () => {
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  type(window, rowFor(doc, 'Sonarr').querySelectorAll('input[type=text]')[1], 'New description');
  const row = rowFor(doc, 'Sonarr');
  const inputs = row.querySelectorAll('input[type=text]');
  assert.equal(inputs[1].classList.contains('chg'), true, 'the edited cell is marked');
  assert.equal(inputs[0].classList.contains('chg'), false, 'the name cell is not');
  assert.equal(row.querySelector('td.grip').classList.contains('chg'), false,
    'the grip, which stands in for the group, is not');
  assert.equal(row.querySelectorAll('input[type=checkbox]')[0].classList.contains('chg'), false);
});

test('the View menu is hidden in admin mode', async () => {
  const { window, doc } = await boot();
  assert.ok(doc.querySelector('.menu'), 'viewers get the View menu');
  await enterAdmin(window, doc);
  assert.ok(doc.body.classList.contains('admin-mode'),
    'the View menu is hidden by the body.admin-mode rule');
  assert.equal(window.getComputedStyle(doc.querySelector('.menu')).display, 'none');
});

const bulkRows = (doc) =>
  [...doc.querySelectorAll('table.bulk tbody tr')].filter((r) => !r.classList.contains('grp'));
const bulkNames = (doc) => bulkRows(doc).map((r) => r.querySelector('input[type=text]').value);
const groupRow = (doc, name) =>
  [...doc.querySelectorAll('table.bulk tr.grp')].find((r) => r.dataset.cat === name);
const groupNames = (doc) => [...doc.querySelectorAll('table.bulk tr.grp')].map((r) => r.dataset.cat);

/** Drag a bulk row by its grip onto another row (or a group heading). */
function dragRow(window, fromRow, onto) {
  return drag(window, fromRow.querySelector('td.grip'), onto);
}

test('bulk rows have a drag handle and reorder within their group', async () => {
  const names = ['A','B','C','D'];
  const apps = names.map((n, i) => ({
    slug: n.toLowerCase(), name: n, url: `https://${n.toLowerCase()}.example`,
    description: n, category: 'Media', icon: '', clicks_mine: 0, clicks_all: 0,
    order: i, base: { name: n, description: n, category: 'Media', icon: '' }, override: {}
  }));
  const { window, doc, seen } = await boot({ user: 'e@x', admin: true, apps: apps.slice().reverse() });
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  assert.deepEqual(bulkNames(doc), names, 'the table lists apps in position order');
  assert.ok(bulkRows(doc).every((r) => r.querySelector('td.grip[draggable=true]')),
    'every row gets a grip, and the grip is what is draggable -- not the row, or ' +
    'selecting text in a cell would start a drag');

  const rows = bulkRows(doc);
  dragRow(window, rows[3], rows[1]);            // D onto B
  await settle(window, () => bulkNames(doc)[1] === 'D', 'D to move up');
  assert.deepEqual(bulkNames(doc), ['A','D','B','C']);
  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0,
    'a drop stages like every other edit -- Save is still the only write');

  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the save PUT');
  const sent = JSON.parse(seen.filter((r) => r.url === 'api/layouts/1/tiles').pop().body).tiles;
  assert.deepEqual(['a','d','b','c'].map((sl) => sent[sl].order), [0,1,2,3],
    'the group is renumbered contiguously from 0');
});

test('dragging a row onto another group moves it and renumbers both', async () => {
  const apps = [
    { slug:'a', name:'A', category:'Media',  order:0 },
    { slug:'b', name:'B', category:'Media',  order:1 },
    { slug:'c', name:'C', category:'Admin',  order:0 }
  ].map((x) => ({
    ...x, url:`https://${x.slug}.example`, description:x.name, icon:'',
    clicks_mine:0, clicks_all:0,
    base:{ name:x.name, description:x.name, category:x.category, icon:'' }, override:{}
  }));
  const { window, doc, seen } = await boot({ user: 'e@x', admin: true, apps });
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  // A (first of Media) onto the Admin heading -- the heading appends to that
  // group, and is the only way into one that is currently empty.
  assert.deepEqual(groupNames(doc), ['Media', 'Admin'], 'headings start in their established order');
  dragRow(window, bulkRows(doc)[0], groupRow(doc, 'Admin'));
  await settle(window, () => bulkNames(doc)[0] === 'B', 'A to leave Media');
  assert.deepEqual(groupNames(doc), ['Media', 'Admin'],
    'dragging an APP must not reshuffle the headings: categoriesOf falls back to first-seen order in ' +
    'APPS, so moving the first app into Admin used to jump that heading to the top');

  const rowOf = (n) => bulkRows(doc).findIndex((r) => r.querySelector('input[type=text]').value === n);
  assert.ok(rowOf('A') > rowOf('C'), 'A now sits inside the Admin group, after C');
  assert.ok(bulkRows(doc)[rowOf('A')].querySelector('td.grip').classList.contains('chg'),
    'the grip marks the staged group change, since there is no Group column to mark');

  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the save PUT');
  const sent = JSON.parse(seen.filter((r) => r.url === 'api/layouts/1/tiles').pop().body).tiles;
  assert.equal(sent.a.category, 'Admin', 'the move is persisted as a category change');
  assert.equal(sent.a.order, 1, 'appended after C');
  assert.equal(sent.b.order, 0,
    'the group it LEFT is renumbered too -- a hole there makes the next drop land wrong');
});

test('the bulk table has no Group column and shows the effective icon first', async () => {
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const heads = [...doc.querySelectorAll('table.bulk th')].map((h) => h.textContent);
  assert.deepEqual(heads,
    ['', '', 'Name', 'Description', 'Icons', 'Pos', 'Above fold', 'Hidden', '']);
  assert.equal(doc.querySelector('table.bulk input[list=bulk-groups]'), null,
    'the Group text field is gone; membership is the section the row sits in');

  const row = rowFor(doc, 'Calibre-Web');
  const cells = [...row.children];
  assert.ok(cells[0].classList.contains('grip'), 'grip first');
  assert.ok(cells[1].classList.contains('preview'), 'then the read-only current icon');
  assert.ok(cells[4].classList.contains('icons'), 'the clickable swatches come after the description');
  assert.equal(cells[1].querySelector('img').getAttribute('src'),
    'data:image/png;base64,iVBORw0KGgo=', 'the preview shows what the tile actually renders');
});

/** Three groups, so a reorder can be told apart from a swap. */
function threeGroups() {
  const spec = [
    { slug:'a', name:'A', category:'Media' },
    { slug:'b', name:'B', category:'Admin' },
    { slug:'c', name:'C', category:'Tools' }
  ];
  return { user:'e@x', admin:true, apps: spec.map((x, i) => ({
    ...x, url:`https://${x.slug}.example`, description:x.name, icon:'',
    clicks_mine:0, clicks_all:0, order:0,
    base:{ name:x.name, description:x.name, category:x.category, icon:'' }, override:{}
  })) };
}

test('group headings can be dragged to reorder, staged like everything else', async () => {
  const { window, doc, seen } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  assert.deepEqual(groupNames(doc), ['Media', 'Admin', 'Tools']);
  assert.ok([...doc.querySelectorAll('table.bulk tr.grp')]
    .every((r) => r.querySelector('td.grip[draggable=true]')),
    'every heading gets its own grip');

  // Tools onto Media -- inserts before it.
  drag(window, groupRow(doc, 'Tools').querySelector('td.grip'), groupRow(doc, 'Media'));
  await settle(window, () => groupNames(doc)[0] === 'Tools', 'Tools to move to the top');
  assert.deepEqual(groupNames(doc), ['Tools', 'Media', 'Admin']);

  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0,
    'reordering groups stages -- Save is still the only write');
  assert.equal(doc.getElementById('bulk-save').disabled, false,
    'a group move alone is enough to enable Save, with no app edited');
  assert.match(doc.querySelector('.bulkbar .pending').textContent, /group order/);

  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/groups'), 'the groups PUT');
  const put = seen.filter((r) => r.url === 'api/layouts/1/groups').pop();
  assert.equal(put.method, 'PUT');
  assert.deepEqual(JSON.parse(put.body).order, ['Tools', 'Media', 'Admin'],
    'the same value the rail writes -- two editors for one ordering, not two orderings');
});

test('a moved heading is marked, and moving it back clears the mark', async () => {
  const { window, doc } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  drag(window, groupRow(doc, 'Tools').querySelector('td.grip'), groupRow(doc, 'Media'));
  await settle(window, () => groupNames(doc)[0] === 'Tools', 'the reorder');
  assert.ok(groupRow(doc, 'Tools').querySelector('td.grip').classList.contains('chg'),
    'the heading that moved is marked');
  assert.equal(groupRow(doc, 'Admin').querySelector('td.grip').classList.contains('chg'), false,
    'a heading that stayed at its index is not');

  // Put it back. Dropping on a heading always inserts BEFORE it, so the only
  // way to reach the last slot is to drop onto a row of the last group.
  const lastRow = bulkRows(doc)[bulkRows(doc).length - 1];
  drag(window, groupRow(doc, 'Tools').querySelector('td.grip'), lastRow);
  await settle(window, () => groupNames(doc)[0] === 'Media', 'Tools to go back to the end');
  assert.deepEqual(groupNames(doc), ['Media', 'Admin', 'Tools']);
  assert.equal(doc.getElementById('bulk-save').disabled, true,
    'restoring the original order leaves nothing staged');
});

test('Cancel discards a staged group reorder', async () => {
  const { window, doc, seen } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  drag(window, groupRow(doc, 'Tools').querySelector('td.grip'), groupRow(doc, 'Media'));
  await settle(window, () => groupNames(doc)[0] === 'Tools', 'the reorder');
  click(doc.getElementById('bulk-cancel'));

  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0, 'Cancel writes nothing');
  await settle(window, () => !doc.querySelector('table.bulk'), 'the table to close');
  click(doc.getElementById('admin-bulk-btn'));
  await settle(window, () => !!doc.querySelector('table.bulk'), 'the table to reopen');
  assert.deepEqual(groupNames(doc), ['Media', 'Admin', 'Tools'],
    'reopening shows the server order, not the discarded one');
});

test('dragging an app and dragging a heading do not interfere', async () => {
  const { window, doc } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  // An app drag must not be accepted as a heading reorder, and vice versa:
  // both kinds of handler sit on the heading row.
  const before = groupNames(doc);
  dragRow(window, bulkRows(doc)[0], groupRow(doc, 'Tools'));   // app A -> Tools
  await settle(window, () => bulkNames(doc).indexOf('A') === 2, 'A to land in Tools');
  assert.deepEqual(groupNames(doc), before, 'an app drop must not reorder the headings');
});

const railItem = (doc, name) =>
  [...doc.querySelectorAll('#group-list li')].find((li) => li.firstChild.textContent === name);

test('the first column always shows an icon, never a blank cell', async () => {
  // A blank cell reads as "this app has no icon" when the dashboard is in fact
  // rendering the bundled svg or the letter avatar. It must show the same
  // thing the tile does.
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  // sonarr has no icon at all; books has an uploaded data: one.
  assert.equal(rowFor(doc, 'Sonarr').querySelector('td.preview img').getAttribute('src'),
    'icons/sonarr.svg', 'no stored icon falls back to the bundled one, not to nothing');
  assert.equal(rowFor(doc, 'Calibre-Web').querySelector('td.preview img').getAttribute('src'),
    'data:image/png;base64,iVBORw0KGgo=');

  // And when even the bundled file 404s, the letter avatar takes its place.
  const img = rowFor(doc, 'Sonarr').querySelector('td.preview img');
  img.dispatchEvent(new window.Event('error'));
  const cell = rowFor(doc, 'Sonarr').querySelector('td.preview');
  assert.equal(cell.querySelector('img'), null);
  assert.equal(cell.querySelector('.icon.letter').textContent, 'S');
});

test('groups collapse in the bulk table and still accept drops', async () => {
  const { window, doc } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  assert.equal(bulkNames(doc).length, 3);
  const heading = groupRow(doc, 'Media');
  click(heading.querySelector('td[role=button]'));
  await settle(window, () => bulkNames(doc).length === 2, 'the Media rows to fold away');

  assert.deepEqual(groupNames(doc), ['Media', 'Admin', 'Tools'], 'the heading stays');
  assert.equal(groupRow(doc, 'Media').querySelector('.count').textContent, '1',
    'a collapsed heading says what it is hiding');

  // Collapsed is not a dead end: it is still a drop target.
  dragRow(window, bulkRows(doc)[0], groupRow(doc, 'Media'));
  await settle(window, () => bulkNames(doc).length === 1, 'the dropped row to fold in too');
  assert.equal(groupRow(doc, 'Media').querySelector('.count').textContent, '2');

  click(groupRow(doc, 'Media').querySelector('td[role=button]'));
  await settle(window, () => bulkNames(doc).length === 3, 'the group to reopen');
});

test('dragging a bulk row onto a sidebar group stages the move', async () => {
  const { window, doc, seen } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const target = railItem(doc, 'Tools');
  assert.ok(target, 'the sidebar lists the groups while bulk edit is open');

  drag(window, bulkRows(doc)[0].querySelector('td.grip'), target);
  await settle(window, () => bulkNames(doc).indexOf('A') === 2, 'A to land in Tools');

  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0,
    'a rail drop during bulk edit must stage, not write -- one Save for the session');
  assert.equal(railItem(doc, 'Tools').querySelector('.count').textContent, '2',
    'the rail count follows the staged move');

  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the save PUT');
  assert.equal(JSON.parse(seen.filter((r) => r.url === 'api/layouts/1/tiles').pop().body).tiles.a.category,
    'Tools');
});

test('dragging a sidebar group during bulk edit stages the reorder', async () => {
  const { window, doc, seen } = await boot(threeGroups());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  drag(window, railItem(doc, 'Tools'), railItem(doc, 'Media'));
  await settle(window, () => groupNames(doc)[0] === 'Tools', 'the table to follow the rail');

  assert.equal(seen.filter((r) => r.url === 'api/layouts/1/groups').length, 0,
    'the rail writes group_order immediately when NOT in bulk edit; during it, it stages');
  assert.deepEqual([...doc.querySelectorAll('#group-list li')].map((li) => li.firstChild.textContent),
    ['Tools', 'Media', 'Admin'],
    'the rail shows the staged order, not the server one -- otherwise the two disagree');
});

function typeSearch(window, doc, text) {
  const box = doc.getElementById('search');
  box.value = text;
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  return box;
}
const tileNames = (doc) => [...doc.querySelectorAll('a.app .name')].map((n) => n.textContent);

test('search filters tiles by name, description, group and slug', async () => {
  const { window, doc } = await boot();
  assert.deepEqual(tileNames(doc).sort(), ['Calibre-Web', 'Sonarr']);

  typeSearch(window, doc, 'ebook');            // matches books by DESCRIPTION
  assert.deepEqual(tileNames(doc), ['Calibre-Web']);

  typeSearch(window, doc, 'sonarr');
  assert.deepEqual(tileNames(doc), ['Sonarr']);

  typeSearch(window, doc, 'media library');    // two terms, different fields, any order
  assert.deepEqual(tileNames(doc), ['Calibre-Web'],
    'every term must match, but not in order and not in one field');

  typeSearch(window, doc, '');
  assert.equal(tileNames(doc).length, 2, 'clearing restores everything');
});

test('a search with no matches says so instead of showing an empty page', async () => {
  const { window, doc } = await boot();
  typeSearch(window, doc, 'zzzznope');
  assert.equal(tileNames(doc).length, 0);
  assert.match(doc.getElementById('out').textContent, /No tiles match/,
    'an empty page with a filter still applied is what gets reported as "my tiles are gone"');
  assert.equal(doc.querySelectorAll('#out h2').length, 0, 'and no empty group headings');
});

test('Escape clears the search, and / focuses it', async () => {
  const { window, doc } = await boot();
  const box = typeSearch(window, doc, 'sonarr');
  assert.equal(tileNames(doc).length, 1);

  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(box.value, '', 'Escape clears rather than just blurring');
  assert.equal(tileNames(doc).length, 2);

  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, box, '/ focuses search from anywhere on the page');

  // ...but not while typing into a field.
  const other = doc.createElement('input');
  doc.body.appendChild(other);
  other.focus();
  other.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, other, "/ inside an input types a slash, it does not steal focus");
});

/** A payload with one Authentik app and one custom tile. */
function withCustom() {
  return {
    user: 'e@x', admin: true,
    apps: [
      { slug:'sonarr', name:'Sonarr', url:'https://sonarr.example', description:'TV',
        category:'Media', icon:'', clicks_mine:0, clicks_all:0, order:0,
        base:{ name:'Sonarr', description:'TV', category:'Media', icon:'' }, override:{} },
      { slug:'adguard', name:'AdGuard Home', url:'http://192.0.2.8/', description:'DNS',
        category:'Infrastructure', icon:'', clicks_mine:0, clicks_all:0, order:0,
        custom:true, visible_to:[],
        base:{ name:'AdGuard Home', description:'DNS', category:'Infrastructure', icon:'' },
        override:{} }
    ]
  };
}

test('a custom tile is marked, and only it offers edit-link and delete', async () => {
  const { window, doc } = await boot(withCustom());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const custom = rowFor(doc, 'AdGuard Home');
  const authentik = rowFor(doc, 'Sonarr');
  assert.ok(custom.querySelector('.badge'), 'the custom row is badged as a link');
  assert.equal(authentik.querySelector('.badge'), null, 'an Authentik app is not');
  assert.equal(custom.querySelectorAll('td.act button').length, 2, 'edit-link and delete');
  assert.equal(authentik.querySelectorAll('td.act button').length, 0,
    'an Authentik tile has no URL to edit and cannot be deleted from nav');
});

test('creating a custom tile validates the slug and the URL before writing', async () => {
  const { window, doc, seen } = await boot(withCustom());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  click(doc.getElementById('bulk-add'));
  const dlg = doc.querySelector('.icondlg-back');
  assert.ok(dlg, 'the new-tile dialog opens');
  const [fName, fUrl, fSlug] = dlg.querySelectorAll('input');

  // The slug follows the name until it is touched.
  fName.value = 'Pomerium Session';
  fName.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(fSlug.value, 'pomerium-session', 'the slug is derived from the name');

  const create = doc.getElementById('newtile-create');
  fUrl.value = 'blank://blank';
  create.click();
  assert.equal(seen.filter((r) => r.method === 'PUT').length, 0,
    'a URL the browser cannot navigate to must not be written -- that is the bug ' +
    'that put a dead Pomerium tile on the page');
  assert.match(dlg.textContent, /must start with/);

  fUrl.value = 'https://jotty.example.com/.pomerium';
  create.click();
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the create PUT');
  const put = seen.filter((r) => r.method === 'PUT').pop();
  assert.equal(put.url, 'api/admin/custom-tiles/pomerium-session');
  assert.equal(JSON.parse(put.body).url, 'https://jotty.example.com/.pomerium');
});

test('custom tiles take admin overrides like any other tile', async () => {
  const { window, doc, seen } = await boot(withCustom());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  type(window, rowFor(doc, 'AdGuard Home').querySelectorAll('input[type=text]')[0], 'AdGuard');
  click(doc.getElementById('bulk-save'));
  await settle(window, () => seen.some((r) => r.url === 'api/admin/presentation'), 'the save PUT');
  const sent = JSON.parse(seen.filter((r) => r.url === 'api/admin/presentation').pop().body).tiles;
  assert.equal(sent.adguard.name, 'AdGuard',
    'one override table serves both kinds of tile, so the merge has one implementation');
});

async function openTileDialog(window, doc, opener) {
  click(opener);
  await settle(window, () => !!doc.querySelector('.icondlg-back'), 'the tile dialog');
  return doc.querySelector('.icondlg-back');
}
const audButton = (dlg) => dlg.querySelector('.aud-btn');
async function openAudience(window, dlg) {
  click(audButton(dlg));
  await settle(window, () => dlg.querySelectorAll('.aud-pop label').length > 0,
    'the groups and users to load');
  return dlg.querySelector('.aud-pop');
}
const checkFor = (pop, text) =>
  [...pop.querySelectorAll('label')].find((l) => l.textContent.includes(text))
    .querySelector('input');

test('the audience picker lists groups and users and defaults to everyone', async () => {
  const { window, doc } = await boot(withCustom());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('bulk-add'));

  assert.match(audButton(dlg).textContent, /Everyone who can open nav/,
    'no audience means everyone -- and it has to say so, not sit blank');

  const pop = await openAudience(window, dlg);
  const heads = [...pop.querySelectorAll('h4')].map((h) => h.textContent);
  assert.deepEqual(heads, ['Groups', 'Users']);
  assert.ok(checkFor(pop, 'family'), 'groups are listed');
  assert.ok(checkFor(pop, 'mom@example.com'), 'users are listed, by email');
});

test('several principals can be selected, and are sent prefixed', async () => {
  const { window, doc, seen } = await boot(withCustom());
  await enterAdmin(window, doc);
  await enterBulk(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('bulk-add'));
  const pop = await openAudience(window, dlg);

  const family = checkFor(pop, 'family');
  family.checked = true;
  family.dispatchEvent(new window.Event('change', { bubbles: true }));
  const mom = checkFor(pop, 'mom@example.com');
  mom.checked = true;
  mom.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.match(audButton(dlg).textContent, /family/);
  assert.match(audButton(dlg).textContent, /mom@example\.com/);

  const [fName, fUrl] = dlg.querySelectorAll('input');
  fName.value = 'AdGuard';
  fName.dispatchEvent(new window.Event('input', { bubbles: true }));
  fUrl.value = 'http://192.0.2.8/';
  click(doc.getElementById('newtile-create'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the create PUT');

  const body = JSON.parse(seen.filter((r) => r.method === 'PUT').pop().body);
  assert.deepEqual(body.visible_to.sort(), ['group:family', 'user:mom@example.com'],
    'groups and users are distinguishable in the stored value, not bare names');
});

test('the picker filters, and editing a tile shows what is already selected', async () => {
  const withAudience = withCustom();
  withAudience.apps[1].visible_to = ['group:staff-media'];
  const { window, doc } = await boot(withAudience);
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const edit = rowFor(doc, 'AdGuard Home').querySelectorAll('td.act button')[0];
  const dlg = await openTileDialog(window, doc, edit);
  assert.match(audButton(dlg).textContent, /staff-media/, 'the existing audience is shown');

  const slug = [...dlg.querySelectorAll('input')][2];
  assert.equal(slug.disabled, true,
    'the slug is the primary key and the icon filename; changing it would orphan ' +
    'the overrides and clicks that hang off it');

  const pop = await openAudience(window, dlg);
  assert.equal(checkFor(pop, 'staff-media').checked, true, 'and ticked in the list');

  const filter = pop.querySelector('input.f');
  filter.value = 'mom';
  filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  const labels = [...pop.querySelectorAll('label')].map((l) => l.textContent);
  assert.equal(labels.length, 1);
  assert.match(labels[0], /mom@example\.com/);
});

test('a directory that will not load does not block creating a tile', async () => {
  // No audience means everyone, which is the default anyway -- so a failed
  // lookup degrades to that and says so rather than refusing.
  const { window, doc, seen } = await boot(withCustom(), (u) =>
    u.startsWith('api/admin/principals') ? { ok: false, status: 503 } : null);
  await enterAdmin(window, doc);
  await enterBulk(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('bulk-add'));

  click(audButton(dlg));
  await settle(window, () => !!dlg.querySelector('.aud-pop .none'), 'the failure notice');
  assert.match(dlg.querySelector('.aud-pop .none').textContent, /Could not load/);

  const [fName, fUrl] = dlg.querySelectorAll('input');
  fName.value = 'AdGuard';
  fName.dispatchEvent(new window.Event('input', { bubbles: true }));
  fUrl.value = 'http://192.0.2.8/';
  click(doc.getElementById('newtile-create'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the create PUT');
  assert.deepEqual(JSON.parse(seen.filter((r) => r.method === 'PUT').pop().body).visible_to, []);
});

test('a bare group name stored before users existed is still ticked', async () => {
  // Rows written before the picker hold `family`, not `group:family`. The
  // reader treats a bare entry as a group; the picker has to agree, or editing
  // such a tile silently shows nobody selected and saving widens it to
  // everyone.
  const legacy = withCustom();
  legacy.apps[1].visible_to = ['family'];
  const { window, doc } = await boot(legacy);
  await enterAdmin(window, doc);
  await enterBulk(window, doc);

  const edit = rowFor(doc, 'AdGuard Home').querySelectorAll('td.act button')[0];
  const dlg = await openTileDialog(window, doc, edit);
  assert.match(audButton(dlg).textContent, /family/, 'the bare name is shown as chosen');

  const pop = await openAudience(window, dlg);
  assert.equal(checkFor(pop, 'family').checked, true,
    'and matches the `group:family` checkbox, not nothing');
});

test('New tile is reachable from the sidebar, not only from Bulk edit', async () => {
  // It lived only in the bulk table's toolbar, which is not where anyone looks
  // for "add a thing" -- reported as "there is no option to create a new tile".
  const { window, doc } = await boot(withCustom());
  await enterAdmin(window, doc);

  const btn = doc.getElementById('admin-newtile-btn');
  assert.ok(btn, 'the sidebar offers it without entering the table');
  const dlg = await openTileDialog(window, doc, btn);
  assert.match(dlg.querySelector('strong').textContent, /New tile/,
    'and it opens in CREATE mode -- the listener must not pass the click event ' +
    'as the tile being edited');
  assert.equal([...dlg.querySelectorAll('input')][2].disabled, false,
    'so the slug is editable, unlike when editing');
});

test('an admin can create a tile without the bulk table open', async () => {
  const { window, doc, seen } = await boot(withCustom());
  await enterAdmin(window, doc);
  assert.equal(doc.querySelector('table.bulk'), null, 'no bulk table');

  const dlg = await openTileDialog(window, doc, doc.getElementById('admin-newtile-btn'));
  const [fName, fUrl] = dlg.querySelectorAll('input');
  fName.value = 'AdGuard Home';
  fName.dispatchEvent(new window.Event('input', { bubbles: true }));
  fUrl.value = 'http://192.0.2.8/';
  click(doc.getElementById('newtile-create'));

  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the create PUT');
  const put = seen.filter((r) => r.method === 'PUT').pop();
  assert.equal(put.url, 'api/admin/custom-tiles/adguard-home');
});

test('the New tile button is admin-only', async () => {
  const { window, doc } = await boot();   // starts as a viewer
  assert.ok(doc.getElementById('admin-newtile-btn'), 'the button exists in the markup');
  assert.equal(doc.body.classList.contains('admin-mode'), false);
  assert.equal(window.getComputedStyle(doc.getElementById('side-menu')).display, 'none',
    'the Manage menu is hidden outside admin mode, so the button is too');
});

test('the New tile button is actually VISIBLE in both places, not merely present', async () => {
  // getElementById finds a button that is display:none, off-screen, or sitting
  // outside the bar. "I could not find it on the bulk edit page either" is a
  // visibility report, so assert visibility rather than existence.
  const { window, doc } = await boot(withCustom());
  await enterAdmin(window, doc);

  const vis = (el) => {
    const cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };

  const barBtn = doc.getElementById('admin-newtile-btn');
  const list = doc.getElementById('side-menu-list');
  assert.equal(list.hidden, true, 'the sidebar Manage menu starts closed');
  click(doc.getElementById('side-menu-btn'));
  assert.equal(list.hidden, false, 'and opens on its button');
  assert.ok(vis(barBtn), 'visible in the Manage menu');
  assert.ok(barBtn.closest('#groups'), 'which is in the sidebar');
  assert.ok(vis(doc.getElementById('side-menu')), 'and is itself shown in admin mode');
  click(barBtn);
  assert.equal(list.hidden, true, 'choosing an item closes the menu');
  click(doc.getElementById('editor-close'));

  await enterBulk(window, doc);
  const tableBtn = doc.getElementById('bulk-add');
  assert.ok(tableBtn, 'the bulk toolbar has one too');
  assert.ok(vis(tableBtn), 'and it is visible');
  assert.ok(tableBtn.closest('.bulkbar'), 'inside the toolbar, next to Save and Cancel');
  assert.deepEqual(
    [...tableBtn.closest('.bulkbar').querySelectorAll('button')].map((b) => b.textContent),
    ['Save', 'Cancel', '+ New tile'],
    'the toolbar order is Save, Cancel, + New tile');
});

/** Three apps across two groups, for the group picker. */
function twoGroups() {
  const spec = [
    { slug:'a', name:'A', category:'Media' },
    { slug:'b', name:'B', category:'Infrastructure' },
    { slug:'c', name:'C', category:'Media' }
  ];
  return { user:'e@x', admin:true, apps: spec.map((x) => ({
    ...x, url:`https://${x.slug}.example`, description:x.name, icon:'',
    clicks_mine:0, clicks_all:0, order:0,
    base:{ name:x.name, description:x.name, category:x.category, icon:'' }, override:{}
  })) };
}
const gpOptions = (root) =>
  [...root.querySelectorAll('.gp-pop button')].map((b) => b.textContent);
function gpType(window, input, text) {
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
const mkRow = (root) => root.querySelector('.gp-pop button.mk');

test('the group box is a dropdown that filters as you type', async () => {
  const { window, doc } = await boot(twoGroups());
  await enterAdmin(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('admin-newtile-btn'));

  const gp = dlg.querySelector('.gp');
  const input = gp.querySelector('input');
  assert.equal(gp.querySelector('.gp-pop').hidden, true, 'closed until used');

  input.dispatchEvent(new window.Event('focus', { bubbles: true }));
  assert.equal(gp.querySelector('.gp-pop').hidden, false, 'focus opens it');
  assert.deepEqual(gpOptions(gp).slice(0, 2), ['Media', 'Infrastructure'],
    'every existing group is listed');

  gpType(window, input, 'inf');
  assert.deepEqual(gpOptions(gp).filter((t) => !t.startsWith('+')), ['Infrastructure'],
    'typing narrows the list -- progressive, not an exact match');

  gpType(window, input, 'zzz');
  assert.deepEqual(gpOptions(gp).filter((t) => !t.startsWith('+')), [],
    'no existing group matches');
});

test('picking an option fills the box and closes the list', async () => {
  const { window, doc } = await boot(twoGroups());
  await enterAdmin(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('admin-newtile-btn'));
  const gp = dlg.querySelector('.gp');
  const input = gp.querySelector('input');

  input.dispatchEvent(new window.Event('focus', { bubbles: true }));
  const opt = [...gp.querySelectorAll('.gp-pop button')].find((b) => b.textContent === 'Media');
  // mousedown, not click: the option has to win the race against the input's
  // blur, or the list closes before the value is taken.
  opt.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(input.value, 'Media');
  assert.equal(gp.querySelector('.gp-pop').hidden, true, 'and the list closes');
});

test('New group is offered, and refuses a name that already exists', async () => {
  const { window, doc } = await boot(twoGroups());
  await enterAdmin(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('admin-newtile-btn'));
  const gp = dlg.querySelector('.gp');
  const input = gp.querySelector('input');

  input.dispatchEvent(new window.Event('focus', { bubbles: true }));
  assert.equal(mkRow(gp).disabled, true, 'nothing typed yet, so nothing to create');

  gpType(window, input, 'Monitoring');
  assert.equal(mkRow(gp).disabled, false);
  assert.match(mkRow(gp).textContent, /Monitoring/);

  gpType(window, input, 'Media');
  assert.equal(mkRow(gp).disabled, true, 'that group already exists');
  assert.match(gp.querySelector('.gp-pop .why').textContent, /already exists/);

  // Case-insensitively, because "Media" and "media" would render as two
  // headings and nobody means that.
  gpType(window, input, 'MEDIA');
  assert.equal(mkRow(gp).disabled, true, 'a case variant is the same group');

  gpType(window, input, 'Monitoring');
  mkRow(gp).dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(input.value, 'Monitoring', 'creating just takes the typed name');
});

test('a new group chosen in the dialog is what gets saved', async () => {
  const { window, doc, seen } = await boot(twoGroups());
  await enterAdmin(window, doc);
  const dlg = await openTileDialog(window, doc, doc.getElementById('admin-newtile-btn'));
  const inputs = [...dlg.querySelectorAll('input')];
  const [fName, fUrl] = inputs;
  const gpInput = dlg.querySelector('.gp input');

  fName.value = 'AdGuard Home';
  fName.dispatchEvent(new window.Event('input', { bubbles: true }));
  fUrl.value = 'http://192.0.2.8/';
  gpType(window, gpInput, 'Monitoring');
  mkRow(dlg.querySelector('.gp')).dispatchEvent(
    new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  click(doc.getElementById('newtile-create'));
  await settle(window, () => seen.some((r) => r.method === 'PUT'), 'the create PUT');
  assert.equal(JSON.parse(seen.filter((r) => r.method === 'PUT').pop().body).category,
    'Monitoring');
});

test('the tile editor uses the same picker, seeded with the current group', async () => {
  const { window, doc } = await boot(twoGroups());
  await enterAdmin(window, doc);
  // Admin mode turns tiles into editors; click one.
  click(doc.querySelector('a.app'));
  await settle(window, () => !!doc.querySelector('#editor .gp'), 'the editor to open');

  const gp = doc.querySelector('#editor .gp');
  const input = gp.querySelector('input');
  input.dispatchEvent(new window.Event('focus', { bubbles: true }));
  assert.ok(gpOptions(gp).includes('Media'), 'the existing groups are offered here too');
  assert.ok(mkRow(gp), 'and a new one can still be made from the editor');
});

async function openSite(window, doc) {
  click(doc.getElementById('admin-site-btn'));
  await settle(window, () => doc.getElementById('editor-title').textContent === 'Site',
    'the site dialog');
  return doc.getElementById('editor-body') || doc.querySelector('#editor');
}

test('site settings gives each icon mode its own control', async () => {
  // It used to have ONE drop zone captioned "applies to the icon field you
  // last clicked in" -- the target was focus, which is invisible, so pasting
  // a light icon while the dark field held focus replaced the wrong one.
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  const body = await openSite(window, doc);

  const labels = [...body.querySelectorAll('label')].map((l) => l.textContent);
  assert.ok(labels.some((t) => /dark mode/.test(t)), 'a dark-mode field');
  assert.ok(labels.some((t) => /light mode/.test(t)), 'a light-mode field');

  // One chooser per icon, not one shared between them.
  const choosers = [...body.querySelectorAll('button')]
    .filter((b) => b.textContent.startsWith('Choose'));
  assert.equal(choosers.length, 2,
    'each mode owns its own Choose button; a shared one cannot say which field it fills');
  assert.equal(body.querySelectorAll('input[type=file]').length, 2, 'and its own file input');

  assert.equal(
    [...body.querySelectorAll('*')].filter((e) => /last clicked in/.test(e.textContent)).length, 0,
    'the shared drop zone is gone');
});

test('the site icon rows are independent of each other', async () => {
  const { window, doc } = await boot();
  await enterAdmin(window, doc);
  const body = await openSite(window, doc);

  const rows = [...body.querySelectorAll('label')]
    .filter((l) => /dark mode|light mode/.test(l.textContent));
  assert.equal(rows.length, 2);

  const dark = rows.find((l) => /dark mode/.test(l.textContent));
  const light = rows.find((l) => /light mode/.test(l.textContent));
  const darkInput = dark.querySelector('input[type=text]');
  const lightInput = light.querySelector('input[type=text]');

  darkInput.value = 'https://example.com/dark.svg';
  darkInput.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.equal(lightInput.value, '', 'typing in one must not touch the other');
  assert.equal(dark.querySelector('img').getAttribute('src'), 'https://example.com/dark.svg',
    'each row previews its OWN value');
  assert.notEqual(light.querySelector('img'), null, 'and the light row has a preview of its own');
});

test('saving site settings writes both icon keys separately', async () => {
  const { window, doc, seen } = await boot();
  await enterAdmin(window, doc);
  const body = await openSite(window, doc);

  const rows = [...body.querySelectorAll('label')];
  const dark = rows.find((l) => /dark mode/.test(l.textContent)).querySelector('input[type=text]');
  const light = rows.find((l) => /light mode/.test(l.textContent)).querySelector('input[type=text]');
  dark.value = 'https://example.com/d.svg';
  light.value = 'https://example.com/l.svg';

  click(doc.getElementById('editor-save'));
  await settle(window, () => seen.filter((r) => r.url.startsWith('api/site/')).length >= 3,
    'the three site PUTs');

  const puts = seen.filter((r) => r.method === 'PUT' && r.url.startsWith('api/site/'));
  const byKey = Object.fromEntries(puts.map((r) => [r.url, JSON.parse(r.body).value]));
  assert.equal(byKey['api/site/icon'], 'https://example.com/d.svg');
  assert.equal(byKey['api/site/icon_light'], 'https://example.com/l.svg',
    'the two icons land in their own keys, not one overwriting the other');
});

async function openImpersonate(window, doc) {
  click(doc.getElementById('menu-btn'));
  const item = doc.getElementById('menu-impersonate');
  assert.ok(item, '"View as…" should be in the menu');
  click(item);
  await settle(window, () => !!doc.querySelector('.icondlg-back .aud-pop h4'),
    'the principal list');
  return doc.querySelector('.icondlg-back');
}
/** Tick a checkbox in the View-as picker by its label text. */
function pickIn(window, dlg, text) {
  const label = [...dlg.querySelectorAll('.aud-pop label')]
    .find((l) => l.textContent.includes(text));
  assert.ok(label, `no option matching ${text}`);
  const cb = label.querySelector('input[type=checkbox]');
  cb.checked = !cb.checked;
  cb.dispatchEvent(new window.Event('change', { bubbles: true }));
  return cb;
}
const viewNow = (doc) => click(doc.getElementById('imp-go'));

test('"View as" is offered only when the server says so', async () => {
  const noImp = JSON.parse(JSON.stringify(APPS));
  noImp.may_impersonate = false;
  const { doc } = await boot(noImp);
  click(doc.getElementById('menu-btn'));
  assert.equal(doc.getElementById('menu-impersonate'), null,
    'hiding it is presentation -- but it must at least be hidden');

  const { doc: d2 } = await boot();      // may_impersonate: true
  click(d2.getElementById('menu-btn'));
  assert.ok(d2.getElementById('menu-impersonate'));
});

test('impersonating a user asks the server for THEIR apps and says whose', async () => {
  const { window, doc, seen } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  viewNow(doc);

  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');
  const req = seen.map((r) => r.url).filter((u) => u.includes('as_user=')).pop();
  assert.ok(req, 'the subject goes to the server; the browser does not filter locally');
  assert.match(req, /as_user=mom%40example\.com/);
  assert.match(doc.getElementById('imp-who').textContent, /Viewing as mom@example\.com/);

  const names = [...doc.querySelectorAll('a.app .name')].map((n) => n.textContent);
  assert.deepEqual(names, ['Sonarr'], "their tile list, not the impersonator's");
});

test('impersonating a group shows a hypothetical single-group user, not a member', async () => {
  // The first version sampled a real member, which answers a different
  // question -- real people belong to several groups at once, so "view as
  // family" rendered everything evan could reach. The server now computes
  // what a user in that group AND NO OTHER could reach.
  const { window, doc, seen } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'family');
  viewNow(doc);

  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');
  assert.match(seen.map((r) => r.url).filter((u) => u.includes('as_group=')).pop(),
    /as_group=family/, 'the group goes to the server; it is not evaluated in the browser');

  const note = doc.getElementById('imp-note').textContent;
  assert.match(note, /hypothetical user/, 'it must not present itself as a real person');
  assert.match(note, /no other group/);
  assert.match(note, /Real members usually belong to more/,
    'and must say the answer is a floor, not an exact match for anyone real');
  assert.doesNotMatch(note, /One member of/, 'the old sampling wording is gone');
});

test('applications that cannot be evaluated are named, not silently dropped', async () => {
  // A policy binding needs Authentik's engine to resolve. Omitting such an
  // app would make an incomplete answer look complete.
  const { window, doc } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'family');
  viewNow(doc);           // the stub marks `weirdapp` undetermined
  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');

  const note = doc.getElementById('imp-note').textContent;
  assert.match(note, /Could not evaluate 1 application/);
  assert.match(note, /weirdapp/, 'name it, so it can be checked by hand');
  assert.match(note, /Neither shown nor ruled out/);
});

test('a group with nothing bound to it says so', async () => {
  const { window, doc } = await boot(APPS, null, (u) =>
    (/as_group=/.test(u)
      ? { user: 'evan@example.com', admin: true, may_impersonate: true, apps: [],
          impersonating: { kind: 'group', groups: ['nav-admins'], user: null,
                           subject: 'anyone whose only group is nav-admins',
                           undetermined: [], added: [], empty: true } }
      : null));
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'nav-admins');
  viewNow(doc);
  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');
  assert.match(doc.getElementById('imp-note').textContent,
    /Nothing is reachable by those groups alone/,
    'an empty result must be explained, not left as a blank page');
});

test('the banner states the limits, including that it grants nothing', async () => {
  const { window, doc } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  viewNow(doc);
  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');

  const note = doc.getElementById('imp-note').textContent;
  assert.match(note, /grants nothing/, 'it is a view, not access');
  assert.match(note, /still goes out as you/);
  assert.match(note, /dashboards and click counts are not read/,
    "their private layout is not read, and the screen should not imply it is");
});

test('stopping impersonation restores the real dashboard', async () => {
  const { window, doc, seen } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  viewNow(doc);
  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');

  click(doc.getElementById('imp-exit'));
  await settle(window, () => !doc.body.classList.contains('impersonating'), 'the banner to go');
  await settle(window, () => doc.querySelectorAll('a.app').length === 2, 'the real tiles');
  const last = seen.map((r) => r.url).filter((u) => u.startsWith('api/apps')).pop();
  assert.equal(/as_user=|as_group=/.test(last), false, 'and the subject is dropped');
});

test('entering admin mode ends impersonation', async () => {
  // Admin writes go out as the real caller. Editing while the screen shows
  // someone else's tiles is how you change the wrong thing confidently.
  const { window, doc } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  viewNow(doc);
  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');

  await enterAdmin(window, doc);
  assert.equal(doc.body.classList.contains('impersonating'), false,
    'the two modes are mutually exclusive');
  assert.ok(doc.body.classList.contains('admin-mode'));
});

test('the server, not the page, decides whether impersonation is in effect', async () => {
  // If the server declines -- subject gone, group emptied, membership revoked
  // -- the banner must come down rather than mislabel a real dashboard as
  // somebody else's. So the flag is read from the RESPONSE, never left as the
  // local guess that sent the request.
  const plain = JSON.parse(JSON.stringify(APPS));   // 2 apps, no impersonating block
  const { window, doc, seen } = await boot(APPS, null,
    (u) => (/as_user=|as_group=/.test(u) ? plain : null));

  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  viewNow(doc);

  // Wait for the request to have actually gone out AND been applied, rather
  // than asserting into the gap before it resolves -- which passes for free.
  await settle(window, () => seen.some((r) => /as_user=/.test(r.url)), 'the request');
  await settle(window, () => doc.getElementById('who').textContent !== '', 'the reply applied');
  assert.equal(doc.body.classList.contains('impersonating'), false,
    'a well-formed reply with no impersonating block must clear the banner');
});

test('several groups can be chosen at once', async () => {
  const { window, doc, seen } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'family');
  pickIn(window, dlg, 'staff-media');
  assert.match(doc.getElementById('imp-summary').textContent, /2 groups/);
  viewNow(doc);

  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');
  const url = seen.map((r) => r.url).filter((u) => u.includes('as_group=')).pop();
  assert.match(url, /as_group=family/);
  assert.match(url, /as_group=staff-media/,
    'both go to the server as repeated params -- one hypothesis, several groups');
});

test('only one person can be chosen; a second replaces the first', async () => {
  // Checkboxes that behave like radios. Silently ignoring the second pick
  // would look like the click missed.
  const { window, doc } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  assert.match(doc.getElementById('imp-summary').textContent, /mom@example\.com/);
  pickIn(window, dlg, 'Evan');
  const summary = doc.getElementById('imp-summary').textContent;
  assert.match(summary, /evan@example\.com/);
  assert.doesNotMatch(summary, /mom@example\.com/, 'the first person is replaced');

  // And unticking clears the choice rather than leaving it stuck selected.
  pickIn(window, dlg, 'Evan');
  assert.match(doc.getElementById('imp-summary').textContent, /Nothing selected/);
  assert.equal(doc.getElementById('imp-go').disabled, true);
});

test('a person plus groups highlights only what the groups would ADD', async () => {
  // The delta is the question. What they already reach is context.
  const { window, doc, seen } = await boot();
  const dlg = await openImpersonate(window, doc);
  pickIn(window, dlg, 'mom@example.com');
  pickIn(window, dlg, 'family');
  viewNow(doc);

  // NOT `a.app` count: the default fixture also renders two tiles, so that
  // condition is already true before the impersonation reply lands and the
  // assertions then run against the pre-impersonation DOM.
  await settle(window, () => doc.body.classList.contains('impersonating'), 'the banner');
  await settle(window, () => doc.querySelector('a.app.added'), 'the added tile');
  const url = seen.map((r) => r.url).filter((u) => u.includes('as_user=')).pop();
  assert.match(url, /as_user=mom%40example\.com/);
  assert.match(url, /as_group=family/, 'one request carries both');

  const added = [...doc.querySelectorAll('a.app.added .name')].map((n) => n.textContent);
  assert.deepEqual(added, ['Calibre-Web'], 'only the tile the group adds is marked');
  const plain = [...doc.querySelectorAll('a.app:not(.added) .name')].map((n) => n.textContent);
  assert.deepEqual(plain, ['Sonarr'], "what they already had is shown but not marked");

  assert.match(doc.getElementById('imp-note').textContent, /would add/);
  assert.match(doc.getElementById('imp-note').textContent, /outlined/);
});

test('View is inert until something is selected', async () => {
  const { window, doc } = await boot();
  const dlg = await openImpersonate(window, doc);
  assert.equal(doc.getElementById('imp-go').disabled, true, 'nothing chosen yet');
  pickIn(window, dlg, 'family');
  assert.equal(doc.getElementById('imp-go').disabled, false);
  pickIn(window, dlg, 'family');      // untick
  assert.equal(doc.getElementById('imp-go').disabled, true, 'and inert again');
});

/** Switch the Grouping view option. */
function setGrouping(window, doc, value) {
  click(doc.getElementById('menu-btn'));
  const item = [...doc.querySelectorAll('#menu-list button')]
    .find((b) => b.textContent.startsWith('Grouping'));
  click(item);
  const choice = [...doc.querySelectorAll('#menu-list button')]
    .find((b) => b.textContent.trim() === value);
  assert.ok(choice, `no Grouping choice "${value}"`);
  click(choice);
}
const tabNames = (doc) =>
  [...doc.querySelectorAll('.tabs button')].map((b) => b.firstChild.textContent);
const activeTab = (doc) =>
  (doc.querySelector('.tabs button[aria-selected="true"]') || {}).firstChild?.textContent;

function swipe(window, el, dx, dy = 0) {
  const t = (x, y) => [{ clientX: x, clientY: y }];
  const start = new window.Event('touchstart', { bubbles: true });
  start.touches = t(200, 200);
  el.dispatchEvent(start);
  const end = new window.Event('touchend', { bubbles: true });
  end.changedTouches = t(200 + dx, 200 + dy);
  el.dispatchEvent(end);
}

test('tabbed grouping puts each group on its own tab', async () => {
  const { window, doc } = await boot(threeGroups());
  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar');

  assert.deepEqual(tabNames(doc), ['Media', 'Admin', 'Tools']);
  assert.equal(activeTab(doc), 'Media', 'the first tab is active by default');
  assert.deepEqual([...doc.querySelectorAll('a.app .name')].map((n) => n.textContent), ['A'],
    'only the active tab’s tiles are rendered');

  click([...doc.querySelectorAll('.tabs button')].find((b) => b.textContent.startsWith('Tools')));
  await settle(window, () => activeTab(doc) === 'Tools', 'the tab to change');
  assert.deepEqual([...doc.querySelectorAll('a.app .name')].map((n) => n.textContent), ['C']);
});

test('swiping left and right moves between tabs', async () => {
  const { window, doc } = await boot(threeGroups());
  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar');
  const out = doc.getElementById('out');

  swipe(window, out, -80);                     // left = next
  await settle(window, () => activeTab(doc) === 'Admin', 'the next tab');
  swipe(window, out, 80);                      // right = previous
  await settle(window, () => activeTab(doc) === 'Media', 'the previous tab');

  // Past the ends, nothing happens rather than wrapping.
  swipe(window, out, 80);
  assert.equal(activeTab(doc), 'Media', 'no wrap-around at the first tab');
});

test('a mostly-vertical drag does not change tab', async () => {
  // Otherwise scrolling the page sideways-ish jumps tabs under your thumb.
  const { window, doc } = await boot(threeGroups());
  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar');
  const out = doc.getElementById('out');

  swipe(window, out, -60, 200);   // long vertical, some horizontal
  assert.equal(activeTab(doc), 'Media', 'treated as a scroll, not a swipe');
  swipe(window, out, -20);        // too short to be deliberate
  assert.equal(activeTab(doc), 'Media', 'a tiny movement is not a swipe');
});

test('searching in tabbed view hides tabs with no matches', async () => {
  const { window, doc } = await boot(threeGroups());
  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar');

  typeSearch(window, doc, 'C');
  await settle(window, () => tabNames(doc).length === 1, 'the other tabs to go');
  assert.deepEqual(tabNames(doc), ['Tools'],
    'a tab you can swipe into and find empty is a dead end');
  assert.equal(activeTab(doc), 'Tools', 'and the active tab follows the matches');
});

async function openViewAsList(window, doc) {
  await enterAdmin(window, doc);
  click(doc.getElementById('admin-viewas-btn'));
  await settle(window, () => !!doc.querySelector('#viewas-table tbody tr'), 'the list');
  return doc.querySelector('.icondlg-back');
}

test('the View-as list is its own screen and shows every principal', async () => {
  const { window, doc } = await boot();
  const dlg = await openViewAsList(window, doc);

  const rows = [...doc.querySelectorAll('#viewas-table tbody tr')];
  assert.equal(rows.length, 7, 'all groups and users, not just the curated ones');
  const labels = rows.map((r) => r.children[2].textContent);
  assert.ok(labels.includes('noisy-service-group'),
    'the screen that edits the curation must show what is available to add back');
  assert.ok(labels.some((l) => l.includes('svc@example.com')));

  const kinds = rows.map((r) => r.children[1].textContent);
  assert.ok(kinds.includes('group') && kinds.includes('person'));

  assert.equal(doc.querySelector('table.bulk#viewas-table') !== null, true);
  assert.equal(doc.querySelectorAll('#bulk-save').length, 0,
    'separate from the tile bulk editor -- a list of people is not a list of tiles');
});

test('saving the View-as list writes only the ticked principals', async () => {
  const { window, doc, seen } = await boot();
  await openViewAsList(window, doc);

  const row = [...doc.querySelectorAll('#viewas-table tbody tr')]
    .find((r) => r.children[2].textContent === 'noisy-service-group');
  const cb = row.querySelector('input[type=checkbox]');
  assert.equal(cb.checked, false, 'it is not in the curated list, so it starts unticked');
  cb.checked = true;
  cb.dispatchEvent(new window.Event('change', { bubbles: true }));

  click(doc.getElementById('viewas-save'));
  await settle(window, () => seen.some((r) => r.url === 'api/site/viewas_list'), 'the save');
  const value = JSON.parse(seen.filter((r) => r.url === 'api/site/viewas_list').pop().body).value;
  assert.ok(value.groups.includes('noisy-service-group'));
  assert.ok(value.groups.includes('family'));
  assert.ok(!value.users.includes('svc@example.com'), 'untouched rows keep their state');
});

test('"Offer everything" clears the setting rather than ticking every box', async () => {
  // The two differ the moment a group is added to Authentik later: null keeps
  // offering everything, a full list freezes today's roster.
  const { window, doc, seen } = await boot();
  await openViewAsList(window, doc);
  click(doc.getElementById('viewas-all'));
  await settle(window, () => seen.some((r) => r.url === 'api/site/viewas_list'), 'the save');
  assert.equal(JSON.parse(seen.filter((r) => r.url === 'api/site/viewas_list').pop().body).value,
    null, 'an explicit null, not an enumeration of what exists today');
});

/** Four groups, so a one-tab step is distinguishable from a two-tab jump. */
function fourGroups() {
  const spec = [['a', 'One'], ['b', 'Two'], ['c', 'Three'], ['d', 'Four']];
  return { user: 'e@x', admin: true, apps: spec.map(([slug, cat]) => ({
    slug, name: slug.toUpperCase(), url: `https://${slug}.example`, description: slug,
    category: cat, icon: '', clicks_mine: 0, clicks_all: 0, order: 0,
    base: { name: slug.toUpperCase(), description: slug, category: cat, icon: '' },
    override: {}
  })) };
}

test('each swipe moves exactly one tab, however many times you swipe', async () => {
  // The regression: the swipe listeners were attached inside renderTabs(), and
  // showTab() re-renders -- so every swipe left another listener behind. The
  // first swipe moved one tab, the next moved two, then four, and the stale
  // closures each held the `cats` of the render that created them. Reported as
  // "swiping left gave me the second tab, then the fourth, then only the
  // fourth and the first".
  //
  // Four groups, because with three the clamp at the end hides the doubling.
  const { window, doc } = await boot(fourGroups());
  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar');
  assert.deepEqual(tabNames(doc), ['One', 'Two', 'Three', 'Four']);
  const out = doc.getElementById('out');

  for (const expected of ['Two', 'Three', 'Four']) {
    swipe(window, out, -80);
    await settle(window, () => activeTab(doc) === expected,
      `one step per swipe (expected ${expected}, got ${activeTab(doc)})`);
  }
  swipe(window, out, -80);
  assert.equal(activeTab(doc), 'Four', 'and it stops at the last tab');

  for (const expected of ['Three', 'Two', 'One']) {
    swipe(window, out, 80);
    await settle(window, () => activeTab(doc) === expected,
      `one step back per swipe (expected ${expected}, got ${activeTab(doc)})`);
  }
});

test('swiping still works after switching away from tabs and back', async () => {
  // The one-time listener must not depend on renderTabs having run, and must
  // stay inert while another grouping mode is showing.
  const { window, doc } = await boot(fourGroups());
  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar');
  const out = doc.getElementById('out');

  setGrouping(window, doc, 'By category');
  await settle(window, () => !doc.querySelector('.tabs'), 'tabs to go away');
  swipe(window, out, -80);           // must do nothing at all here
  assert.equal(doc.querySelector('.tabs'), null, 'a swipe outside tabbed view is inert');

  setGrouping(window, doc, 'Tabbed');
  await settle(window, () => !!doc.querySelector('.tabs'), 'the tab bar again');
  const before = activeTab(doc);
  swipe(window, out, -80);
  await settle(window, () => activeTab(doc) !== before, 'one step');
  assert.equal(tabNames(doc).indexOf(activeTab(doc)), tabNames(doc).indexOf(before) + 1,
    'still exactly one tab, not two');
});

// --- widgets (roadmap #34) ---------------------------------------------------

const TYPES = { types: [
  { type: 'vm.stat', title: 'Metric value', description: 'One number', app: 'grafana',
    shape: 'stat', ttl: 30, config_schema: {
      query: { type: 'string', label: 'PromQL', required: true },
      format: { type: 'enum', choices: ['number', 'percent'], default: 'number' },
      warn: { type: 'number', label: 'Warn at' } } },
  { type: 'vm.timeseries', title: 'Metric chart', app: 'grafana', shape: 'timeseries',
    ttl: 60, config_schema: { query: { type: 'string', required: true },
      unit: { type: 'string', template: true }, legend: { type: 'string', template: true } } }
] };

const STAT = { type: 'vm.stat', shape: 'stat', data: {
  value: 87.25, label: 'NAS used', format: 'percent', decimals: 1, level: 'warn',
  spark: [[1, 80], [2, null], [3, 85], [4, 87.25]] } };

const SERIES = (n) => ({ type: 'vm.timeseries', shape: 'timeseries', data: {
  label: 'CPU', format: 'percent', decimals: 0, range: [0, 300], truncated: 0,
  series: Array.from({ length: n }, (_, k) => ({ name: `wk${k + 1}`,
    points: [[0, 10 + k], [100, 20 + k], [200, null], [300, 30 + k]] })) } });

test('a stat widget formats its value and says its status in words', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  window.renderWidget(el, STAT);
  assert.equal(el.querySelector('.w-label').textContent, 'NAS used');
  assert.match(el.querySelector('.w-value').textContent, /^87\.3%Warning$/);
  // Colour never carries the status alone.
  assert.ok(el.querySelector('.w-level i'), 'status needs its dot');
  // The trend skips the gap rather than drawing through it.
  assert.ok(el.querySelector('svg.w-spark path').getAttribute('d').startsWith('M'));
});

test('a timeseries draws one line per series, a legend only for several, and a table', async () => {
  const { window, doc } = await boot();
  const one = doc.createElement('div');
  window.renderWidget(one, SERIES(1));
  assert.equal(one.querySelectorAll('path.w-line').length, 1);
  assert.equal(one.querySelector('.w-legend'), null, 'a single series is named by its label');
  // The gap at t=200 breaks the line: two Move commands, not one.
  assert.equal((one.querySelector('path.w-line').getAttribute('d').match(/M/g) || []).length, 2);

  const three = doc.createElement('div');
  window.renderWidget(three, SERIES(3));
  assert.equal(three.querySelectorAll('path.w-line').length, 3);
  assert.deepEqual([...three.querySelectorAll('.w-legend span')].map((s) => s.textContent),
                   ['wk1', 'wk2', 'wk3']);
  three.querySelector('.w-table-btn').click();
  const rows = three.querySelectorAll('.w-table tr');
  assert.equal(rows.length, 5, 'header + one row per timestamp');
  assert.equal(rows[0].children.length, 4, 'time + three series');
});

test('the timeseries tooltip lists every series at the focused time', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, SERIES(2));
  const plot = el.querySelector('.w-plot');
  plot.dispatchEvent(new window.FocusEvent('focus'));
  const tip = el.querySelector('.w-tip');
  assert.equal(tip.hidden, false);
  assert.equal(tip.querySelectorAll('strong').length, 2);
  assert.deepEqual([...tip.querySelectorAll('strong')].map((s) => s.textContent), ['30%', '31%']);
});

test('an error payload is an error tile, and an unknown shape says so', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  window.renderWidget(el, { type: 'vm.stat', shape: 'stat', error: 'ValueError: boom' });
  assert.equal(el.querySelector('.w-err').textContent, 'ValueError: boom');
  window.renderWidget(el, { type: 'x', shape: 'pie', data: {} });
  assert.match(el.querySelector('.w-err').textContent, /cannot draw a "pie"/);
});

test('labels are data: a series name is text, never markup', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  const p = SERIES(2);
  p.data.series[0].name = '<img src=x onerror=alert(1)>';
  window.renderWidget(el, p);
  assert.equal(el.querySelector('img'), null);
  assert.equal(el.querySelector('.w-legend span').textContent, '<img src=x onerror=alert(1)>');
});

test('the widget designer builds its form from the schema and previews', async () => {
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u.startsWith('api/widgets/types') ? TYPES :
    u.startsWith('api/widgets/preview') ? STAT : null);
  window.widgetDesigner(null);
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'types');
  assert.ok(doc.getElementById('editor').classList.contains('wide'));
  const fields = [...doc.querySelectorAll('#wd-form [data-field]')].map((e) => e.dataset.field);
  assert.deepEqual(fields, ['query', 'format', 'warn']);
  assert.equal(doc.querySelector('[data-field=query]').tagName, 'TEXTAREA');

  doc.querySelector('[data-field=query]').value = 'max(disk_used_pct)';
  doc.getElementById('wd-preview-btn').click();
  await settle(window, () => doc.querySelector('#wd-preview .w-value'), 'preview');
  const sent = JSON.parse(seen.find((s) => s.url.startsWith('api/widgets/preview')).body);
  // Unset fields are omitted, not sent as 0: the server owns the defaults.
  assert.deepEqual(sent, { type: 'vm.stat', config: { query: 'max(disk_used_pct)', format: 'number' } });

  // Switching type rebuilds the form; closing un-widens the shared dialog.
  const sel = doc.getElementById('wd-type');
  sel.selectedIndex = 1;
  sel.dispatchEvent(new window.Event('change'));
  assert.deepEqual([...doc.querySelectorAll('#wd-form [data-field]')].map((e) => e.dataset.field),
                   ['query', 'unit', 'legend']);
  doc.getElementById('editor-close').click();
  assert.equal(doc.getElementById('editor').classList.contains('wide'), false);
});

test('presets fill the designer, and a library widget can name an audience', async () => {
  const types = { types: [{ ...TYPES.types[0], presets: [
    { title: 'Busiest node CPU', config: { query: 'topk(1, cpu)', format: 'percent', warn: 80 } }] },
    TYPES.types[1]] };
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u.startsWith('api/widgets/types') ? types :
    u.startsWith('api/widgets/preview') ? STAT : widgetRoutes(u));
  await enterAdmin(window, doc);
  window.widgetDesigner(null);
  await settle(window, () => doc.querySelectorAll('#wd-preset option').length === 2, 'presets');
  assert.equal(doc.getElementById('wd-preset').parentNode.hidden, false);
  const pick = doc.getElementById('wd-preset');
  pick.value = '0';
  pick.dispatchEvent(new window.Event('change'));
  assert.equal(doc.querySelector('[data-field=query]').value, 'topk(1, cpu)');
  assert.equal(doc.querySelector('[data-field=format]').value, 'percent');
  assert.equal(doc.getElementById('wd-title').value, 'Busiest node CPU');
  doc.getElementById('wd-audience').value = 'family, staff';
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/admin/widgets' && s.method === 'POST'), 'POST');
  const body = JSON.parse(seen.find((s) => s.url === 'api/admin/widgets').body);
  assert.deepEqual(body.audience, ['family', 'staff']);
  assert.equal(body.title, 'Busiest node CPU');
  // A type with no presets hides the picker.
  window.widgetDesigner(null);
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'types again');
  const sel = doc.getElementById('wd-type');
  sel.selectedIndex = 1;
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('wd-preset').parentNode.hidden, true);
});

test('a list draws sections, links and state words, as text', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  window.renderWidget(el, { type: 'seerr.requests', shape: 'list', data: {
    label: 'Requests', note: '1 pending', items: [
      { label: '<b>Film</b>', sub: 'Film · Mom · 2d ago', badge: { text: 'Pending', level: 'warn' },
        url: 'https://seerr.example/movie/1', section: 'Today' },
      { label: 'Soup', value: 'Dinner', section: 'Tomorrow' }, 'plain'] } });
  assert.match(el.querySelector('.w-label').textContent, /Requests.*1 pending/);
  assert.deepEqual([...el.querySelectorAll('.w-section')].map((h) => h.textContent), ['Today', 'Tomorrow']);
  const a = el.querySelector('a.w-item');
  assert.equal(a.href, 'https://seerr.example/movie/1');
  assert.equal(a.querySelector('.w-item-label').textContent, '<b>Film</b>');
  assert.equal(el.querySelector('b'), null);
  assert.equal(el.querySelector('.w-badge').textContent, 'Pending', 'a word, not only a colour');
  assert.equal(el.querySelectorAll('ul.w-list > li:not(.w-section)').length, 3);
  const empty = doc.createElement('div');
  window.renderWidget(empty, { shape: 'list', data: { items: [], empty: 'Nothing planned.' } });
  assert.equal(empty.querySelector('.w-sub').textContent, 'Nothing planned.');
});

test('the calendar: week from Sunday, month, or agenda by choice; small sizes draw dots, never switch view', async () => {
  const { window, doc } = await boot();
  const day = (n) => { const d = new window.Date(); d.setDate(d.getDate() + n);
    return window.calDay(d); };
  const today = day(0), dow = window.calParse(today).getDay();
  const cal = { type: 'arr.calendar', shape: 'calendar', data: { label: 'Coming up', view: 'week',
    warnings: ['Lidarr: HTTP 500'], events: [
      { kind: 'tv', at: new window.Date(Date.now() + 3600e3).toISOString(), title: 'Show', sub: 'S01E01 · Pilot', done: false },
      { kind: 'movie', date: today, title: 'Film (2026)', sub: 'Digital', done: true },
      { kind: 'music', date: day(40), title: 'Far off', sub: 'Band', done: false }] } };
  const narrow = doc.createElement('div');
  window.renderWidget(narrow, cal, { key: 'cal1', size: 'M', span: [4, 4] });
  assert.equal(narrow.querySelector('.cal-agenda'), null, 'small is still a week, not an agenda');
  assert.equal(narrow.querySelectorAll('.cal-week .cal-col').length, 7);
  assert.ok(narrow.querySelector('.cal-week .cal-dot'), 'too narrow for names: dots');
  assert.match(narrow.querySelector('.cal-warn').textContent, /Lidarr/);
  // Agenda is a choice.
  narrow.querySelector('.cal-toggle [data-mode=agenda]').click();
  assert.deepEqual([...narrow.querySelectorAll('.cal-agenda .cal-t')].map((t) => t.textContent).sort(),
                   ['Show', '✓ Film (2026)'].sort(), 'the next 30 days; downloaded marked; 40 days out left off');

  const wide = doc.createElement('div');
  window.renderWidget(wide, cal, { key: 'cal2', size: 'L', span: [8, 4] });
  const cols = [...wide.querySelectorAll('.cal-week .cal-col')];
  assert.equal(cols.length, 7);
  assert.ok(cols[dow].classList.contains('cal-today'), 'the week starts on Sunday by default');
  assert.equal(cols[dow].querySelector('.cal-h').textContent, 'Today');
  assert.deepEqual([...wide.querySelectorAll('.cal-legend span')].map((s) => s.textContent),
                   ['TV', 'Films', 'Music']);

  // A week_start moves the first column.
  const mon = doc.createElement('div');
  window.renderWidget(mon, { ...cal, data: { ...cal.data, week_start: 1 } }, { key: 'cal3', size: 'L', span: [8, 4] });
  assert.ok([...mon.querySelectorAll('.cal-week .cal-col')][(dow + 6) % 7].classList.contains('cal-today'));

  // Month: remembered per widget, and a short cell draws dots, not chips.
  wide.querySelector('.cal-toggle [data-mode=month]').click();
  assert.ok(wide.querySelector('.cal-month'));
  assert.ok(wide.querySelector('.cal-cell.cal-today'));
  assert.ok(wide.querySelector('.cal-dots .cal-dot'), 'L is too short for chips in a month');
  assert.equal(JSON.parse(window.localStorage.getItem('nav.widgetui')).cal2.cal, 'month');
  const big = doc.createElement('div');
  window.renderWidget(big, cal, { key: 'cal2', size: 'XL', span: [12, 8] });
  assert.ok(big.querySelector('.cal-month .cal-chip'), 'XL has room for names');
});
test('choreboard chips: initial, then icon, then name, then chore, as width allows', async () => {
  const { window, doc } = await boot();
  const d = new window.Date(); d.setDate(d.getDate() + 1);
  const day = window.calDay(d);
  const today = window.calDay(new window.Date());
  const ev = { date: day, title: '🐕 Walk the dog', sub: 'Toby · 4–6 PM', initial: 'T', series: 2,
               icon: '🐕', who: 'Toby', name: 'Walk the dog', detail: '4–6 PM' };
  const parts = (colW) => {
    const box = doc.createElement('div');
    const byDay = {}; byDay[day] = [ev];
    window.calWeek(box, byDay, today, today, { w: 7 * (colW + 6), h: 300 });
    const line = box.querySelector('.cal-pline');
    return [...line.children].map((c) => c.className.split(' ')[0]);
  };
  assert.deepEqual(parts(30), ['cal-init']);
  assert.deepEqual(parts(50), ['cal-init', 'cal-ic']);
  assert.deepEqual(parts(90), ['cal-init', 'cal-ic', 'cal-who']);
  assert.deepEqual(parts(160), ['cal-init', 'cal-ic', 'cal-who', 'cal-t']);
  // The initial is in the person's colour; the full story is in the label.
  const box = doc.createElement('div');
  const byDay = {}; byDay[day] = [ev];
  window.calWeek(box, byDay, today, today, { w: 7 * 36, h: 300 });
  assert.match(box.querySelector('.cal-init').style.background, /series-2/);
  assert.equal(box.querySelector('.cal-pchip').getAttribute('aria-label'), 'Toby — Walk the dog · 4–6 PM');
});

test('choreboard chips stack by height: "+N" when they do not fit, a row of initials when nothing does', async () => {
  const { window, doc } = await boot();
  const d = new window.Date(); d.setDate(d.getDate() + 1);
  const day = window.calDay(d);
  const today = window.calDay(new window.Date());
  const evs = Array.from({ length: 6 }, (_, i) => ({ date: day, title: `C${i}`, initial: 'ABCDEF'[i], series: i + 1,
    icon: '•', who: `P${i}`, name: `Chore ${i}`, detail: '' }));
  const byDay = {}; byDay[day] = evs;
  // Room for three rows: two chips and "+4".
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  window.calWeek(box, byDay, today, today, { w: 7 * 200, h: 44 + 3 * 20 });
  assert.equal(box.querySelectorAll('.cal-pchip').length, 2);
  assert.equal(box.querySelector('.cal-col .cal-more').textContent, '+4');
  box.querySelector('.cal-col.cal-has').click();
  assert.equal(doc.querySelectorAll('.cal-day-pop .cal-pchip').length, 6, 'the popover has them all, in full');
  assert.equal(doc.querySelectorAll('.cal-day-pop .cal-pchip .cal-t').length, 6);
  doc.body.click();
  // No room for a single row: just initials, wrapping.
  const flat = doc.createElement('div');
  window.calWeek(flat, byDay, today, today, { w: 7 * 200, h: 50 });
  assert.equal(flat.querySelectorAll('.cal-pchip').length, 0);
  assert.equal(flat.querySelectorAll('.cal-inits .cal-init').length, window.CAL_MAX_INITIALS);
});

test('choreboard: a legend of people, and the agenda (when chosen) shows everything', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const events = [{ date: day, title: '🗑️ Bins', sub: 'Cara · skipped', initial: 'Ca', series: 3, icon: '🗑️',
                    who: 'Cara', name: 'Bins', detail: 'skipped', struck: true }];
  const wide = doc.createElement('div');
  window.renderWidget(wide, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'Chores', view: 'week',
    events, legend: [{ label: 'Cara', series: 3 }] } }, { key: 'cbL', size: 'XL', span: [12, 8] });
  assert.deepEqual([...wide.querySelectorAll('.cal-legend span')].map((x) => x.textContent), ['Cara']);
  const narrow = doc.createElement('div');
  window.renderWidget(narrow, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'Chores', view: 'agenda',
    events } }, { key: 'cbA', size: 'M', span: [4, 4] });
  const chip = narrow.querySelector('.cal-agenda .cal-pchip');
  assert.ok(chip && chip.classList.contains('cal-struck'));
  assert.deepEqual([...chip.querySelector('.cal-pline').children].map((c) => c.textContent), ['Ca', '🗑️', 'Cara', 'Bins']);
  assert.equal(chip.querySelector('.cal-s').textContent, 'skipped');
});

test('choreboard widget: icons for what the viewer may do, sent through nav-api', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const posts = [];
  window.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      posts.push([String(url), JSON.parse(opts.body)]);
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const ev = { date: day, title: '🐕 Walk the dog', initial: 'T', series: 2, icon: '🐕', who: 'Toby', name: 'Walk the dog',
               detail: '4–6 PM', key: `7:${day}:rule:1`, person_id: 2,
               can: ['done', 'covered', 'swap', 'give', 'skip', 'failed', 'failed_covered', 'skipped'], cannot: {} };
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'Chores', view: 'week',
    events: [ev], actions: true, unread: 3, inbox_url: 'https://cb.example/inbox', people: [{ id: 1, name: 'Evan' }, { id: 2, name: 'Toby' }] } },
    { key: 'def42', size: 'XL', span: [12, 8] });
  const bell = el.querySelector('.cal-bell');
  assert.equal(bell.textContent, '🔔 3');
  assert.equal(bell.getAttribute('href'), 'https://cb.example/inbox');
  el.querySelector('.cal-pchip.cal-act').click();
  const sheet = doc.querySelector('.cal-sheet');
  const icons = [...sheet.querySelectorAll('.cal-icons > .cal-ib')].map((b) => [b.textContent, b.getAttribute('aria-label')]);
  assert.deepEqual(icons, [['✓', 'Mark done'], ['✓⁺', 'Someone else did it'], ['⇄', 'Swap'], ['⇄⁺', 'Give to someone'],
                           ['⏭', 'Skip this day'], ['✗', 'Missed'], ['⋯', 'More']]);
  const more = sheet.querySelector('[aria-label=More]');
  more.click();
  assert.deepEqual([...sheet.querySelectorAll('.cal-menu [role=menuitem]')].map((b) => b.textContent),
                   ['✗⁺ Missed, someone covered', '∅ Not needed']);
  sheet.querySelector('[aria-label="Mark done"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts[0], ['api/widgets/42/action', { action: 'done', params: { key: `7:${day}:rule:1` } }]);
  assert.equal(doc.querySelector('.cal-sheet'), null, 'closed after');
});

test('choreboard widget: the sheet opens at the chore, even from the day popover', async () => {
  const { window, doc } = await boot();
  const d = new window.Date(); d.setDate(d.getDate() + 1);
  const day = window.calDay(d);
  const evs = Array.from({ length: 6 }, (_, i) => ({ date: day, title: `C${i}`, initial: 'ABCDEF'[i], series: i + 1,
    who: `P${i}`, name: `Chore ${i}`, key: `k${i}`, can: ['done'], cannot: {} }));
  const box = doc.createElement('div');
  doc.body.appendChild(box);
  window.CAL_RENDER = { defId: '9', d: { actions: true, people: [] } };
  const byDay = {}; byDay[day] = evs;
  const today = window.calDay(new window.Date());
  window.calWeek(box, byDay, today, today, { w: 7 * 200, h: 44 + 3 * 20 });
  box.querySelector('.cal-col.cal-has').click();            // the day popover
  const inPop = doc.querySelector('.cal-day-pop .cal-pchip.cal-act');
  inPop.getBoundingClientRect = () => ({ left: 300, top: 200, bottom: 220, right: 400, width: 100, height: 20 });
  inPop.click();
  const sheet = doc.querySelector('.cal-sheet');
  assert.equal(sheet.style.left, '300px');
  assert.equal(sheet.style.top, '224px', 'just below the chore, not the corner');
  doc.body.click();
});

test('choreboard widget: swap by person or by chore, then the other, then the day', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const d2 = window.calAdd(day, 3);
  const posts = [];
  window.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push(body);
    if (body.action === 'candidates') {
      return new Response(JSON.stringify({ ok: true, result: { candidates: [
        { key: 'e1', date: day, who: 'Evan', title: '🐕 Dog', window: 'by 6 PM' },
        { key: 'e2', date: d2, who: 'Evan', title: '🗑️ Bins', window: '' },
        { key: 'm1', date: d2, who: 'Mom', title: '🐕 Dog', window: '' }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: 'one of these is already in a pending swap request' }), { status: 409 });
  };
  const ev = { date: day, title: 'x', initial: 'T', series: 2, who: 'Toby', name: 'Walk the dog', key: 'mine',
               person_id: 2, can: ['propose_swap'], cannot: { done: 'opens at 4 PM' } };
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'Chores', view: 'week',
    events: [ev], actions: true, people: [] } }, { key: 'def7', size: 'XL', span: [12, 8] });
  el.querySelector('.cal-pchip.cal-act').click();
  const sheet = doc.querySelector('.cal-sheet');
  assert.match(sheet.textContent, /Done: opens at 4 PM\./);
  sheet.querySelector('[aria-label="Ask to swap"]').click();
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  // Step 1, by person: Evan (2), Mom (1).
  const picks = () => [...sheet.querySelectorAll('.cal-pick')].map((b) => b.textContent);
  assert.deepEqual(picks(), ['Evan (2)', 'Mom (1)']);
  [...sheet.querySelectorAll('.cal-pick')][0].click();
  // Step 2: Evan's chores.
  assert.deepEqual(picks(), ['🐕 Dog (1)', '🗑️ Bins (1)'].sort((x, y) => x.localeCompare(y)));
  // By chore instead: chores, then whose, then the day.
  [...sheet.querySelectorAll('.cal-seg button')].find((b) => b.textContent === 'By chore').click();
  assert.deepEqual(picks(), ['🐕 Dog (2)', '🗑️ Bins (1)'].sort((x, y) => x.localeCompare(y)));
  [...sheet.querySelectorAll('.cal-pick')].find((b) => b.textContent.startsWith('🐕')).click();
  assert.deepEqual(picks(), ['Evan (1)', 'Mom (1)']);
  [...sheet.querySelectorAll('.cal-pick')][1].click();
  assert.deepEqual([...sheet.querySelectorAll('.cal-back')].map((b) => b.textContent), ['‹ 🐕 Dog', '‹ Mom']);
  // The last step is a small calendar: one pickable day, and Agenda lists it.
  assert.equal(sheet.querySelectorAll('.cal-mini input[name=cal-swap]').length + sheet.querySelectorAll('.cal-radios input').length, 1);
  [...sheet.querySelectorAll('.cal-daypick .cal-seg button')].find((b) => b.textContent === 'Agenda').click();
  assert.equal(sheet.querySelectorAll('.cal-radios input[name=cal-swap]').length, 1);
  [...sheet.querySelectorAll('.cal-daypick .cal-seg button')].find((b) => b.textContent === 'Month').click();
  sheet.querySelector('input[type=text]').value = 'practice';
  sheet.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts.at(-1), { action: 'propose_swap', params: { key: 'mine', other: 'm1', note: 'practice' } });
  assert.match(doc.querySelector('.cal-sheet .cal-err').textContent, /already in a pending swap/);
  doc.body.click();
});

test('choreboard widget: a covered chore shows who did it, and says whose it was', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const ev = { date: day, title: 'x', initial: 'Ca', series: 3, who: 'Cara', name: 'Dog', key: 'k', detail: 'covered for Toby',
               covered: { for: 'Toby', missed: false }, can: ['undo'], cannot: {} };
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'Chores', view: 'week',
    events: [ev], actions: true } }, { key: 'def3', size: 'XL', span: [12, 8] });
  const chip = el.querySelector('.cal-pchip');
  assert.equal(chip.querySelector('.cal-init').textContent, 'Ca');
  chip.click();
  assert.match(doc.querySelector('.cal-sheet').textContent, /Cara did it for Toby\./);
  doc.body.click();
});

test('choreboard widget: undo a swap (admin at once, a member asks), and say why not', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const posts = [];
  window.fetch = async (url, opts) => { posts.push(JSON.parse(opts.body)); return new Response('{"ok":true,"result":{}}', { status: 200 }); };
  const mk = (extra) => ({ date: day, title: 'x', initial: 'T', series: 2, who: 'Toby', name: 'Dog', key: 'k1', group: 'sw_9',
                           person_id: 2, cannot: {}, ...extra });
  const show = (ev, key) => {
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'C', view: 'week',
      events: [ev], actions: true } }, { key, size: 'XL', span: [12, 8] });
    el.querySelector('.cal-pchip.cal-act').click();
    return doc.querySelector('.cal-sheet');
  };
  let sheet = show(mk({ can: ['undo_swap'] }), 'def1');
  sheet.querySelector('[aria-label="Undo the swap"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts.at(-1), { action: 'undo_swap', params: { key: 'k1', group: 'sw_9' } });
  sheet = show(mk({ can: ['request_undo'] }), 'def2');
  sheet.querySelector('[aria-label="Ask to undo the swap"]').click();
  assert.ok(sheet.querySelector('label').textContent.startsWith('Why undo the swap?'));
  doc.body.click();
  sheet = show(mk({ can: [], cannot: { undo_swap: 'a later swap on Sun Oct 25 has to be undone first' } }), 'def3');
  assert.match(sheet.textContent, /Undo swap: a later swap on Sun Oct 25 has to be undone first\./);
  doc.body.click();
  sheet = show(mk({ can: ['approve_swap'], pending: { id: 4, kind: 'undo', from: 'Toby', to: 'Evan', reason: 'plans' } }), 'def4');
  assert.match(sheet.textContent, /Undo pending: Toby asked to undo this swap — plans\. Nothing changes until Evan approves\./);
  doc.body.click();
});

test('choreboard widget: an admin changing a pending day is asked to approve or decline it first', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const posts = [];
  window.fetch = async (url, opts) => { posts.push(JSON.parse(opts.body)); return new Response('{"ok":true,"result":{}}', { status: 200 }); };
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'C', view: 'week', actions: true,
    events: [{ date: day, title: 'x', initial: 'T', series: 2, who: 'Toby', name: 'Dog', key: 'k1', person_id: 2,
               can: ['skip', 'approve_swap'], cannot: {}, pending: { id: 4, kind: 'swap', from: 'Toby', to: 'Evan', reason: 'plans' } }] } },
    { key: 'def5', size: 'XL', span: [12, 8] });
  el.querySelector('.cal-pchip.cal-act').click();
  const sheet = doc.querySelector('.cal-sheet');
  sheet.querySelector('[aria-label="Skip this day"]').click();
  assert.match(sheet.textContent, /pending swap \(Toby asked Evan — plans\)\. Doing this settles it first/);
  [...sheet.querySelectorAll('.cal-settle button')].find((b) => b.textContent.startsWith('Decline')).click();
  sheet.querySelector('input[type=text]').value = 'sick';
  sheet.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts.at(-1), { action: 'skip', params: { key: 'k1', request: 4, pending: 'decline', note: 'sick' } });
  doc.body.click();
});

test('choreboard widget: an admin can act as someone, and every call says so', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const calls = [];
  window.fetch = async (url, opts) => {
    calls.push([String(url), opts && opts.body ? JSON.parse(opts.body) : null]);
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  };
  const ev = { date: day, title: 'x', initial: 'T', series: 2, who: 'Toby', name: 'Dog', key: 'k1', person_id: 2, can: ['done'], cannot: {} };
  const draw = (extra) => {
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'C', view: 'week', actions: true,
      events: [ev], people: [{ id: 1, name: 'Evan' }, { id: 2, name: 'Toby' }], ...extra } }, { key: 'def6', size: 'XL', span: [12, 8] });
    return el;
  };
  assert.equal(draw({}).querySelector('.cal-as'), null, 'not an admin: no picker');
  let el = draw({ can_act_as: true });
  el.querySelector('.cal-as-pick').click();
  [...doc.querySelectorAll('.cal-as-menu [role=menuitem]')].find((b) => b.textContent === 'Toby').click();
  assert.equal(window.WIDGET_AS['6'], 2);
  assert.ok(calls.some(([u]) => u === 'api/widgets/6/data?as=2'), 'refetched as Toby');
  el = draw({ can_act_as: true, acting_as: { id: 2, name: 'Toby' } });
  assert.equal(el.querySelector('.cal-as-on').textContent, '👤 as Toby ✕');
  el.querySelector('.cal-pchip.cal-act').click();
  doc.querySelector('.cal-sheet [aria-label="Mark done"]').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter(([u]) => u.endsWith('/action')).at(-1)[1].as, 2);
  el.querySelector('.cal-as-on').click();
  assert.equal(window.WIDGET_AS['6'], undefined);
});

test('choreboard legend: click people to show only theirs, none chosen shows everyone', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const ev = (who_id, who) => ({ date: day, title: who, initial: who[0], series: who_id, who, name: 'Dog', key: 'k' + who_id,
                                  person_id: who_id, who_id, can: [], cannot: {} });
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  const draw = () => window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'C', view: 'week',
    events: [ev(1, 'Evan'), ev(2, 'Toby'), ev(3, 'Cara')],
    legend: [{ label: 'Evan', series: 1, id: 1 }, { label: 'Toby', series: 2, id: 2 }, { label: 'Cara', series: 3, id: 3 }] } },
    { key: 'def7', size: 'XL', span: [12, 8] });
  draw();
  const chips = () => [...el.querySelectorAll('.cal-pchip')].map((c) => c.textContent).join(' ');
  const who = (n) => [...el.querySelectorAll('.cal-who')].find((b) => b.textContent === n);
  assert.match(chips(), /Evan.*Toby|Toby.*Evan/);
  who('Toby').click();
  assert.doesNotMatch(chips(), /Evan|Cara/);
  assert.match(chips(), /Toby/);
  who('Cara').click();
  assert.match(chips(), /Cara/);
  assert.equal(who('Evan').className, 'cal-who off');
  who('Toby').click(); who('Cara').click();
  assert.match(chips(), /Evan/);
  draw();
  assert.equal(el.querySelectorAll('.cal-who.on').length, 0, 'remembered per widget: none chosen');
});

test('choreboard widget: a member asks someone to take their chore', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const posts = [];
  window.fetch = async (url, opts) => { posts.push(JSON.parse(opts.body)); return new Response('{"ok":true,"result":{}}', { status: 200 }); };
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'C', view: 'week', actions: true,
    people: [{ id: 2, name: 'Toby' }, { id: 4, name: 'Mom' }],
    events: [{ date: day, title: 'x', initial: 'T', series: 2, who: 'Toby', name: 'Dog', key: 'k1', person_id: 2,
               can: ['propose_swap', 'propose_give'], cannot: {} }] } }, { key: 'def9', size: 'XL', span: [12, 8] });
  el.querySelector('.cal-pchip.cal-act').click();
  const sheet = doc.querySelector('.cal-sheet');
  sheet.querySelector('[aria-label="Ask someone to take it"]').click();
  assert.match(sheet.textContent, /asked to accept it/);
  sheet.querySelector('input[type=text]').value = 'practice';
  sheet.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(posts.at(-1), { action: 'propose_give', params: { key: 'k1', person_id: 4, done_by: 4, note: 'practice' } });
  doc.body.click();
});

test('choreboard widget: the bell is always there, and hovering it shows the latest notifications', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const draw = (extra) => {
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'C', view: 'week', actions: true,
      events: [{ date: day, title: 'x', initial: 'T', series: 2, who: 'Toby', name: 'Dog', key: 'k', can: [] }],
      inbox_url: 'https://cb.example/inbox', ...extra } }, { key: 'def10', size: 'XL', span: [12, 8] });
    return el;
  };
  let bell = draw({ unread: 0, notes: [] }).querySelector('.cal-bell');
  assert.equal(bell.textContent, '🔔', 'no unread: still a bell, no count');
  bell = draw({ unread: 1, notes: [
    { title: 'Toby wants to swap with you', body: 'Toby asks: you do their Dog…', at: new window.Date().toISOString(),
      read: false, url: 'https://cb.example/requests/9' },
    { title: 'Skipped: Bins', body: '', at: '2026-10-01T00:00:00Z', read: true, url: 'https://cb.example/calendar?date=2026-10-01' }] })
    .querySelector('.cal-bell');
  assert.equal(bell.textContent, '🔔 1');
  bell.dispatchEvent(new window.Event('mouseenter'));
  const pop = doc.querySelector('.cal-notes');
  assert.ok(pop, 'hover opens the summary');
  const items = [...pop.querySelectorAll('.cal-note-item')];
  assert.equal(items.length, 2);
  assert.ok(items[0].classList.contains('unread') && !items[1].classList.contains('unread'));
  assert.equal(items[0].getAttribute('href'), 'https://cb.example/requests/9');
  assert.match(pop.textContent, /Open the inbox/);
  assert.equal(draw({ unread: 0 }).querySelector('.cal-bell'), null, 'no inbox data (no act_as): no bell');
  window.calNotesClose();
});

test('choreboard swap calendar: only swappable days pick, your day is marked, views switch', async () => {
  const { window } = await boot();
  try { window.localStorage.removeItem('nav.swapView'); } catch (e) { /* fine */ }
  const box = window.calDayPicker([{ key: 'a', date: '2026-10-14', window: '' }, { key: 'b', date: '2026-10-28', window: 'by 6 PM' }],
                                  '2026-10-12');
  assert.match(box.querySelector('.cal-dp-title').textContent, /October 2026/);
  assert.equal(box.querySelectorAll('.cal-mini .cal-dp.ok').length, 2);
  assert.equal(box.querySelector('.cal-mini .cal-dp.own').textContent, '12');
  assert.equal(box.querySelector('input[name=cal-swap]:checked').value, 'a', 'the first day is picked to start');
  box.querySelectorAll('input[name=cal-swap]')[1].click();
  assert.equal(box.querySelector('input[name=cal-swap]:checked').value, 'b');
  [...box.querySelectorAll('.cal-seg button')].find((x) => x.textContent === 'Week').click();
  assert.equal(box.querySelectorAll('.cal-mini .cal-dp').length, 7);
  [...box.querySelectorAll('.cal-seg button')].find((x) => x.textContent === 'Agenda').click();
  assert.equal(box.querySelectorAll('.cal-radios input').length, 2);
  assert.equal(window.localStorage.getItem('nav.swapView'), 'list', 'remembered');
});

test('calendar strip: one week from Sunday, days with something on filled in their kind\'s colour, a key', async () => {
  const { window, doc } = await boot();
  const today = window.calDay(new window.Date());
  const sunday = window.calAdd(today, -window.calParse(today).getDay());
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'ticketmaster.venue', shape: 'calendar', data: { label: 'Barclays Center', view: 'week',
    strip: true, week_start: 0, range: [window.calAdd(sunday, -1), window.calAdd(sunday, 30)],
    legend: [{ label: 'Basketball', series: 1 }, { label: 'Concert', series: 3 }],
    events: [{ date: window.calAdd(sunday, 3), title: '7:30 PM Nets vs Knicks', sub: 'Sports', series: 1 },
             { date: window.calAdd(sunday, 3), title: '10 AM Tour', series: 3 },
             { date: window.calAdd(sunday, 4), title: 'Gone', series: 3, struck: true }] } },
    { key: 'def11', size: 'M', span: [4, 2] });
  const days = [...el.querySelectorAll('.cal-sday')];
  assert.equal(days.length, 7);
  assert.equal(days[0].querySelector('.cal-sn').textContent, String(window.calParse(sunday).getDate()), 'starts on Sunday');
  assert.equal(days.findIndex((d) => d.classList.contains('cal-today')), window.calParse(today).getDay());
  assert.equal(el.querySelectorAll('.cal-dot').length, 0, 'filled, not dotted');
  assert.ok(days[3].classList.contains('cal-on') && !days[2].classList.contains('cal-on'));
  assert.equal(days[3].style.getPropertyValue('--ev'), 'var(--series-1)');
  assert.equal(days[3].style.getPropertyValue('--ev2'), 'var(--series-3)', 'two kinds: both colours');
  assert.ok(!days[4].classList.contains('cal-on'), 'a cancelled event does not light its day');
  assert.deepEqual([...el.querySelectorAll('.cal-skey span')].map((x) => x.textContent), ['Basketball', 'Concert']);
  assert.match(days[3].getAttribute('aria-label'), /Nets vs Knicks/);
  el.querySelector('[aria-label="Next week"]').click();
  assert.equal(el.querySelector('.cal-sday .cal-sn').textContent, String(window.calParse(window.calAdd(sunday, 7)).getDate()));
  assert.ok(el.querySelector('[aria-label="Next week"]').disabled === false);
});

test('combined week: weather, a mark, rows of dots and initials; the day popover has it all', async () => {
  const { window, doc } = await boot();
  const today = window.calDay(new window.Date());
  const sunday = window.calAdd(today, -window.calParse(today).getDay());
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'combined.week', shape: 'week', data: { label: 'This week', week_start: 0,
    units: { temp: '°F' }, weather: { [today]: { icon: 'clear', hi: 64.4, lo: 51, text: 'Clear', pop: 10 } },
    marks: [{ label: 'Barclays Center', icon: '🏟', events: [{ date: today, title: '7:30 PM Nets vs Knicks' }] }],
    rows: [{ label: 'Coming up', events: [{ date: today, title: 'Show', kind: 'tv' }, { date: today, title: 'Film', kind: 'movie' }] },
           { label: 'Chores', day_url: 'https://cb.example/calendar?date=',
             events: [{ date: today, title: '🐕 Walk the dog', initial: 'T', series: 2, who: 'Toby', name: 'Walk the dog' }] }],
    range: [window.calAdd(sunday, -7), window.calAdd(sunday, 20)] } }, { key: 'def12', size: 'L', span: [8, 4] });
  const cols = [...el.querySelectorAll('.wk-col')];
  assert.equal(cols.length, 7);
  const t = cols[window.calParse(today).getDay()];
  assert.ok(t.classList.contains('cal-today'));
  assert.equal(t.querySelector('.wk-t').textContent, '64/51');
  assert.equal(t.querySelector('.wk-mark').textContent, '🏟');
  const rows = t.querySelectorAll('.wk-row');
  assert.equal(rows[0].querySelectorAll('.cal-dot').length, 2, 'releases as dots');
  assert.equal(rows[1].querySelector('.wk-init').textContent, 'T', 'chores as initials');
  assert.deepEqual([...el.querySelectorAll('.wk-labels .wk-l')].map((x) => x.textContent).filter(Boolean), ['Coming up', 'Chores']);
  t.dispatchEvent(new window.Event('focus'));
  const pop = doc.querySelector('.cal-day-pop');
  assert.match(pop.textContent, /Clear · 64°F \/ 51°F · 10% rain/);
  assert.match(pop.textContent, /Barclays Center/);
  assert.match(pop.textContent, /Nets vs Knicks/);
  assert.equal(pop.querySelector('.wk-pop-link').getAttribute('href'), 'https://cb.example/calendar?date=' + today);
  window.calDayClose();
  el.querySelector('[aria-label="Next week"]').click();
  assert.equal(el.querySelector('.wk-col .wk-n').textContent, String(window.calParse(window.calAdd(sunday, 7)).getDate()));
});

test('choreboard widget without actions: chips are not buttons', async () => {
  const { window, doc } = await boot();
  const day = window.calDay(new window.Date());
  const el = doc.createElement('div');
  window.renderWidget(el, { type: 'choreboard.calendar', shape: 'calendar', data: { label: 'Chores', view: 'week',
    events: [{ date: day, title: 'x', initial: 'T', series: 2, who: 'T', name: 'n', key: 'k', can: ['done'] }], actions: false } },
    { key: 'def8', size: 'XL', span: [12, 8] });
  assert.equal(el.querySelector('.cal-act'), null);
  assert.equal(el.querySelector('.cal-bell'), null, 'no unread, no bell');
});

test('too small to read: one dot per kind, names in the day popover', async () => {
  const { window, doc } = await boot();
  const d = new window.Date(); d.setDate(d.getDate() + 1);
  const day = window.calDay(d);
  const events = [{ kind: 'tv', date: day, title: 'A', sub: 'S1', done: false },
                  { kind: 'tv', date: day, title: 'B', sub: 'S2', done: false },
                  { kind: 'movie', date: day, title: 'C', sub: 'Digital', done: false }];
  const cal = { type: 'arr.calendar', shape: 'calendar', data: { label: 'Coming up', view: 'week', events } };
  // A week whose columns are under CAL_CHIP_MIN_W: room for dots, not titles.
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  const room = { w: 7 * (window.CAL_CHIP_MIN_W - 4), h: 200 };
  const box = doc.createElement('div');
  const byDay = {}; byDay[day] = events;
  window.calWeek(box, byDay, window.calDay(new window.Date()), window.calDay(new window.Date()), room);
  assert.equal(box.querySelectorAll('.cal-chip').length, 0, 'no unreadable slivers');
  const col = box.querySelector('.cal-col.cal-has');
  assert.equal(col.querySelectorAll('.cal-dot').length, 2, 'one dot per kind, not per release');
  el.appendChild(box);
  col.click();
  assert.deepEqual([...doc.querySelectorAll('.cal-day-pop .cal-t')].map((t) => t.textContent), ['A', 'B', 'C']);
  doc.body.click();
  // Wide enough: chips as before.
  const wide = doc.createElement('div');
  window.calWeek(wide, byDay, window.calDay(new window.Date()), window.calDay(new window.Date()), { w: 900, h: 300 });
  assert.equal(wide.querySelectorAll('.cal-chip').length, 3);
});

test('a month day opens enlarged, with everything the cell could not fit', async () => {
  const { window, doc } = await boot();
  const d = new window.Date(); d.setDate(15);
  const day = window.calDay(d);
  const events = ['A', 'B', 'C', 'D', 'E'].map((t) => ({ kind: 'tv', date: day, title: t, sub: 'S01E0' + t.length, done: false }));
  const cal = { type: 'arr.calendar', shape: 'calendar', data: { label: 'Coming up', view: 'month', events } };
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, cal, { key: 'calpop', size: 'L', span: [8, 4] });
  const cell = el.querySelector('.cal-cell.cal-has');
  assert.ok(cell, 'a day with events is marked');
  assert.equal(cell.getAttribute('title'), null, 'no native tooltip under the popover');
  cell.click();
  const pop = doc.querySelector('.cal-day-pop');
  assert.ok(pop, 'a tap opens it');
  assert.deepEqual([...pop.querySelectorAll('.cal-t')].map((t) => t.textContent), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(pop.querySelectorAll('.cal-s').length, 5, 'with subs');
  cell.click();
  assert.equal(doc.querySelector('.cal-day-pop'), null, 'a second tap closes it');
  cell.click();
  doc.body.click();
  assert.equal(doc.querySelector('.cal-day-pop'), null, 'a tap elsewhere closes it');
});

test('a signed-out session says so, instead of blaming nav-api', async () => {
  // Pomerium redirects an expired session's api/ calls to authenticate; with
  // redirect:'manual' that arrives as an opaque response, not a network error.
  let expired = false;
  const { window, doc, seen } = await boot(APPS, null, null, (w) => {
    Object.defineProperty(w, 'fetch', {
      configurable: true,
      get() { return this._f; },
      set(f) {
        // The harness installs its stub first; the page wraps whatever is there.
        this._f = this._f ? f : (url, o) => expired && String(url).startsWith('api/')
          ? Promise.resolve({ type: 'opaqueredirect', status: 0, ok: false, json: () => Promise.reject(new Error('opaque')) })
          : f(url, o);
      }
    });
  });
  assert.equal(doc.getElementById('signedout').hidden, true, 'signed in: no banner');
  assert.equal(seen.find((r) => r.url.startsWith('api/apps')).url.startsWith('api/apps'), true);
  expired = true;
  let err = null;
  await window.fetch('api/apps').catch((e) => { err = e; });
  assert.ok(err && err.signedOut, 'the redirect is a sign-out, not an outage');
  assert.equal(window.apiFailure(err), 'Signed out — reload to sign in again');
  assert.equal(doc.getElementById('signedout').hidden, false, 'and the banner offers a reload');
  assert.match(window.apiFailure(new Error('Failed to fetch')), /^Could not reach nav-api/);
});

test('the calendar steps a week or a month, only as far as its range', async () => {
  const { window, doc } = await boot();
  const day = (n) => { const d = new window.Date(); d.setDate(d.getDate() + n); return window.calDay(d); };
  // The range is whole months -- the start of last month to the end of next --
  // so "two months on is past it" holds on any date. A fixed +-69 days reached
  // into the month after next whenever today was late in a month (2026-10-24).
  const now = new window.Date();
  const range = [window.calDay(new window.Date(now.getFullYear(), now.getMonth() - 1, 1)),
                 window.calDay(new window.Date(now.getFullYear(), now.getMonth() + 2, 0))];
  const cal = { type: 'arr.calendar', shape: 'calendar', data: { label: 'Coming up', view: 'week',
    range, warnings: [], events: [
      { kind: 'movie', date: day(8), title: 'Next week', sub: 'Digital', done: false }] } };
  const el = doc.createElement('div');
  window.renderWidget(el, cal, { key: 'nav1', size: 'L', span: [8, 4] });
  const nav = () => [...el.querySelectorAll('.cal-nav button')];
  const first = () => el.querySelector('.cal-col .cal-h').textContent;
  const sunday = window.calWeekOf(day(0));
  assert.equal(first(), window.calName(sunday, day(0), false), 'the week from its Sunday');
  assert.equal(nav().length, 2, 'no Today button at today');
  nav()[1].click();
  assert.equal(first(), window.calName(window.calAdd(sunday, 7), day(0), false), 'next: the week after');
  assert.ok([...el.querySelectorAll('.cal-t')].some((t) => t.textContent === 'Next week'));
  assert.equal(nav()[2].textContent, 'Today');
  nav()[2].click();
  assert.equal(first(), window.calName(sunday, day(0), false), 'Today goes back');

  // Month: one back and one on are always covered; two on never are.
  el.querySelector('.cal-toggle [data-mode=month]').click();
  nav()[1].click();
  assert.equal(nav()[1].disabled, true, 'the month after next is past the range');
  assert.equal(nav()[0].disabled, false);
  const t = new window.Date(), nm = new window.Date(t.getFullYear(), t.getMonth() + 1, 1);
  assert.equal(el.querySelector('.cal-month-name').textContent,
    nm.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  assert.equal(el.querySelector('.cal-today'), null, 'today is not in next month');

  // An agenda (chosen, never forced by size) marks itself.
  const narrow = doc.createElement('div');
  window.renderWidget(narrow, cal, { key: 'nav2', size: 'M', span: [4, 4] });
  assert.equal(narrow.classList.contains('cal-is-agenda'), false);
  narrow.querySelector('.cal-toggle [data-mode=agenda]').click();
  assert.ok(narrow.classList.contains('cal-is-agenda'));
});

test('connections: keys are write-only, and Save sends only what changed', async () => {
  const CONNS = { can_store: true, connections: [
    { slug: 'sonarr', label: 'Sonarr', url: 'http://sonarr:8989', public_url: 'https://sonarr.x',
      url_set: false, public_set: false, default_url: 'http://sonarr:8989', key: 'stored', hint: '…abcd' },
    { slug: 'mealie', label: 'Mealie', url: 'http://mealie:9000', public_url: 'https://mealie.x',
      url_set: false, public_set: false, default_url: 'http://mealie:9000', key: 'none', hint: null }] };
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u.startsWith('api/admin/connections') && !u.endsWith('/test') ? CONNS :
    u.endsWith('/test') ? { ok: false, detail: 'HTTP 401: the key was refused' } : null);
  await enterAdmin(window, doc);
  doc.getElementById('admin-connections-btn').click();
  await settle(window, () => doc.querySelectorAll('fieldset.conn').length === 2, 'connections');
  const [son, mea] = doc.querySelectorAll('fieldset.conn');
  assert.equal(son.querySelector('.conn-state').textContent, 'Key stored …abcd');
  const keyBox = son.querySelector('input[type=password]');
  assert.equal(keyBox.value, '', 'a stored key is never put back in the page');
  assert.equal(mea.querySelector('.conn-state').textContent, 'No key');

  mea.querySelector('input[type=password]').value = 'tok123';
  mea.querySelectorAll('input')[0].value = 'http://elsewhere:9000';
  [...son.querySelectorAll('button')].find((b) => b.textContent === 'Remove key').click();
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.filter((r) => r.method === 'PUT').length === 2, 'two PUTs');
  const puts = seen.filter((r) => r.method === 'PUT');
  assert.deepEqual(puts.map((r) => [r.url, JSON.parse(r.body)]), [
    ['api/admin/connections/sonarr', { key: '' }],
    ['api/admin/connections/mealie', { url: 'http://elsewhere:9000', key: 'tok123' }]]);

  [...doc.querySelectorAll('fieldset.conn')][0].querySelector('button').click();
  await settle(window, () => /refused/.test(doc.querySelector('.conn-test').textContent), 'test result');
  assert.ok(doc.querySelector('.conn-test').classList.contains('conn-bad'));
});

test('connections: a custom one is added for remote widgets, and can be deleted', async () => {
  const CONNS = { can_store: true, connections: [
    { slug: 'printer', label: 'Printer', custom: true, auth: 'header:X-Token', url: 'https://ink.lan/api',
      public_url: 'https://ink.lan/api', url_set: true, public_set: false, default_url: '', key: 'none' }] };
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u.startsWith('api/admin/connections') ? CONNS : null, (w) => { w.confirm = () => true; });
  await enterAdmin(window, doc);
  doc.getElementById('admin-connections-btn').click();
  await settle(window, () => doc.querySelector('fieldset.conn legend'), 'connections');
  assert.equal(doc.querySelector('fieldset.conn legend').textContent, 'Printer (printer)');
  const form = doc.querySelector('details.conn-add');
  const inputs = form.querySelectorAll('input');
  inputs[0].value = 'nas'; inputs[2].value = 'https://nas.lan'; inputs[4].value = 'k1';
  doc.getElementById('conn-add-btn').click();
  await settle(window, () => seen.some((r) => r.method === 'POST' && r.url === 'api/admin/connections'), 'POST');
  assert.deepEqual(JSON.parse(seen.find((r) => r.method === 'POST').body),
                   { slug: 'nas', url: 'https://nas.lan', auth: 'bearer', key: 'k1' });
  await settle(window, () => doc.querySelector('fieldset.conn'), 'reloaded');
  [...doc.querySelectorAll('fieldset.conn button')].find((b) => b.textContent === 'Delete connection').click();
  await settle(window, () => seen.some((r) => r.method === 'DELETE'), 'DELETE');
  assert.equal(seen.find((r) => r.method === 'DELETE').url, 'api/admin/connections/printer');
});

test('a list item links only to http(s): remote JSON is not trusted', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  window.renderWidget(el, { shape: 'list', data: { items: [
    { label: 'bad', url: 'javascript:alert(1)' }, { label: 'good', url: 'https://x.example/' }] } });
  assert.deepEqual([...el.querySelectorAll('a')].map((a) => a.textContent), ['good']);
});

test('a refused preview shows a message instead of a stale chart', async () => {
  const { window, doc } = await boot(APPS,
    (u) => u.startsWith('api/widgets/preview') ? { status: 403 } : null,
    (u) => u.startsWith('api/widgets/types') ? TYPES : null);
  window.widgetDesigner(null);
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'types');
  doc.querySelector('[data-field=query]').value = 'up';
  doc.getElementById('wd-preview-btn').click();
  await settle(window, () => /403/.test(doc.getElementById('editor-note').textContent), 'error note');
  assert.equal(doc.querySelector('#wd-preview .widget'), null);
});

// --- saved and placed widgets --------------------------------------------------

const SAVED = {
  defs: [
    { id: 1, type: 'vm.stat', title: 'NAS used', shape: 'stat', missing: false,
      config: { query: 'max(nas_used_pct)', format: 'percent', warn: 80 } },
    { id: 2, type: 'vm.timeseries', title: 'CPU', shape: 'timeseries', missing: false,
      config: { query: 'node_cpu_pct' } }
  ],
  placements: [
    { id: 10, def_id: 1, category: 'Media', ord: 0, size: null },
    { id: 11, def_id: 1, category: 'Monitoring', ord: 0, size: null },
    { id: 12, def_id: 2, category: 'Monitoring', ord: 1, size: null }
  ]
};

const widgetRoutes = (u) =>
  u === 'api/widgets' ? SAVED :
  u === 'api/widgets/types' ? TYPES :
  u.startsWith('api/widgets/1/data') ? STAT :
  u.startsWith('api/widgets/2/data') ? SERIES(2) :
  u.startsWith('api/widgets/preview') ? STAT : null;

const headings = (doc) => [...doc.querySelectorAll('h2.cat')].map((h) => h.textContent.replace('▾', ''));

test('placed widgets lead their group, and a widgets-only group still renders', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes);
  await settle(window, () => doc.querySelectorAll('.widget-cell .w-value').length === 2, 'stat data');
  assert.deepEqual(headings(doc), ['Media', 'Monitoring']);
  // In Media, the widget comes first in the group's one shared grid.
  const media = doc.querySelectorAll('h2.cat')[0];
  const g = media.nextElementSibling;
  assert.ok(g.classList.contains('ugrid'));
  assert.deepEqual([...g.children].map((c) => c.dataset.key), ['w:10', 'app:books', 'app:sonarr']);
  // One definition placed twice is ONE fetch, drawn in both places.
  assert.equal(seen.filter((x) => x.url.startsWith('api/widgets/1/data')).length, 1);
  await settle(window, () => doc.querySelector('.widget-cell[data-def="2"] path.w-line'), 'chart');
  assert.equal(doc.querySelectorAll('.widget-cell .w-remove').length, 0, 'no admin controls outside admin mode');
});

test('widgets step aside for a search and fold away with a collapsed group', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes);
  await settle(window, () => doc.querySelector('.widget-cell'), 'widgets');
  const search = doc.getElementById('search');
  search.value = 'son';
  search.dispatchEvent(new window.Event('input'));
  await settle(window, () => !doc.querySelector('.widget-cell'), 'widgets hidden while searching');
  assert.deepEqual(headings(doc), ['Media'], 'a widgets-only group is not a search match');
  search.value = '';
  search.dispatchEvent(new window.Event('input'));
  await settle(window, () => doc.querySelector('.widget-cell'), 'widgets back');
  click(doc.querySelectorAll('h2.cat')[0]);
  await settle(window, () => !doc.querySelector('.widget-cell[data-placement="10"]'), 'Media folded');
  assert.ok(doc.querySelector('.widget-cell[data-placement="11"]'), 'Monitoring still open');
});

test('a hidden widget is off the page; an above-the-fold one survives its group collapsing', async () => {
  const saved = JSON.parse(JSON.stringify(SAVED));
  saved.placements[0].above_fold = true;           // Media's stat stays when Media folds
  saved.placements[2].hidden = true;               // Monitoring's chart is hidden
  const routes = (u) => (u === 'api/widgets' ? saved : widgetRoutes(u));
  const { window, doc } = await boot(APPS, null, routes);
  await settle(window, () => doc.querySelector('.widget-cell[data-placement="10"]'), 'widgets');
  assert.equal(doc.querySelector('.widget-cell[data-placement="12"]'), null, 'hidden: not drawn');
  click(doc.querySelectorAll('h2.cat')[0]);
  await settle(window, () => doc.querySelector('h2.cat.closed'), 'Media folded');
  assert.ok(doc.querySelector('.widget-cell[data-placement="10"]'), 'above the fold: still shown');
  assert.equal(doc.querySelector('h2.cat .count').textContent, '1 of 3', 'counted with the tiles');
});

test('a group holding only widgets is in the rail, counted', async () => {
  const saved = JSON.parse(JSON.stringify(SAVED));
  saved.placements.push({ id: 13, def_id: 2, category: 'Charts only', ord: 0, size: null });
  const routes = (u) => (u === 'api/widgets' ? saved : widgetRoutes(u));
  const { window, doc } = await boot(APPS, null, routes);
  await enterAdmin(window, doc);
  await settle(window, () => [...doc.querySelectorAll('#group-list li')].some((li) => li.textContent.includes('Charts only')),
               'the widget-only group in the rail');
  const li = [...doc.querySelectorAll('#group-list li')].find((x) => x.textContent.includes('Charts only'));
  assert.equal(li.querySelector('.count').textContent, '1');
});

test('while impersonating, widgets show their layout but never the data', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes);
  await settle(window, () => doc.querySelector('.widget-cell'), 'widgets');
  const before = seen.filter((x) => /api\/widgets\/\d+\/data/.test(x.url)).length;
  // Re-render as if the server answered for someone else.
  const { window: w2, doc: d2, seen: s2 } = await boot(
    { ...APPS, impersonating: { kind: 'user', subject: 'mom@example.com', user: 'mom@example.com',
                                groups: [], undetermined: [], added: [] } },
    null, widgetRoutes);
  await settle(w2, () => d2.querySelector('.widget-cell'), 'widgets');
  assert.equal(s2.filter((x) => /api\/widgets\/\d+\/data/.test(x.url)).length, 0);
  assert.match(d2.querySelector('.widget-cell .w-sub').textContent, /not shown while viewing as someone else/);
  assert.ok(before > 0);
});

test('tabs: a widget-only group gets a tab, and widgets sit above its tiles', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes,
    (w) => w.localStorage.setItem('nav.view', JSON.stringify({ group: 'tabs' })));
  await settle(window, () => doc.querySelectorAll('.tabs button').length === 2, 'tabs');
  const tabs = [...doc.querySelectorAll('.tabs button')].map((b) => b.firstChild.textContent);
  assert.deepEqual(tabs, ['Media', 'Monitoring']);
  const g = doc.querySelector('.tabs').nextElementSibling;
  assert.ok(g.classList.contains('ugrid'));
  assert.equal(g.firstElementChild.dataset.key, 'w:10', 'the widget leads the tab');
});

test('the widget palette: one list, the type as a tag, no filter on a packed layout', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes);
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelectorAll('#widget-lib .wl-list li').length === 2, 'library');
  assert.equal(doc.querySelectorAll('#widget-lib .wl-chip').length, 0, 'packed: only widgets to place, nothing to filter');
  assert.deepEqual([...doc.querySelectorAll('#widget-lib .wl-tag')].map((x) => x.textContent).sort(),
                   ['Metric chart', 'Metric value']);
  // The palette opens from the bar's widgets icon.
  assert.ok(doc.getElementById('widget-palette').hidden);
  click(doc.getElementById('admin-widgets-btn'));
  assert.equal(doc.getElementById('widget-palette').hidden, false);
  assert.equal(doc.getElementById('admin-widgets-btn').getAttribute('aria-expanded'), 'true');
  // Adding is by dragging (tested separately); no select clutters the list.
  assert.equal(doc.querySelector('#widget-lib select'), null);
  const nas = [...doc.querySelectorAll('#widget-lib li')].find((li) => li.querySelector('.wl-name').textContent === 'NAS used');
  assert.equal(nas.querySelector('.wl-where').textContent, 'in 2 groups');

  // Remove from a group is per placement, from the widget itself.
  const x = doc.querySelector('.widget-cell[data-placement="10"] .w-remove');
  assert.ok(x, 'admin mode puts a remove control on each placed widget');
  click(x);
  await settle(window, () => seen.some((s) => s.url === 'api/layouts/1/placements/10'), 'DELETE');
  assert.equal(seen.find((s) => s.url === 'api/layouts/1/placements/10').method, 'DELETE');
});

test('the sidebar folds away from the bar, remembered per device', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes);
  await enterAdmin(window, doc);
  const t = doc.querySelector('#adminbar .side-toggle');
  assert.equal(t.title, 'Show or hide the sidebar', 'an icon, described on hover');
  click(t);
  assert.ok(doc.body.classList.contains('side-collapsed'));
  assert.equal(window.localStorage.getItem('nav.side'), 'collapsed');
  click(t);
  assert.ok(!doc.body.classList.contains('side-collapsed'));
});

test('"New widget" dragged onto the page designs one and places it where it was dropped', async () => {
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u === 'api/admin/widgets' ? { ok: true, id: 1 } : widgetRoutes(u));
  await enterAdmin(window, doc);
  await settle(window, () => doc.getElementById('widget-new'), 'palette');
  const g = doc.querySelector('.ugrid[data-cat="Media"]');
  const target = g.querySelector('[data-key="app:sonarr"]');
  drag(window, doc.getElementById('widget-new'), target);
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'the designer opens');
  doc.querySelector('[data-field=query]').value = 'up';
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/layouts/1/placements' && s.method === 'POST'),
               'placed after saving');
  assert.equal(JSON.parse(seen.find((s) => s.url === 'api/layouts/1/placements').body).category, 'Media');
});

test('saving a new widget writes a definition; editing one PUTs it, type fixed', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes,
    (w) => { w.confirm = () => true; });
  await enterAdmin(window, doc);
  window.widgetDesigner(null);
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'types');
  doc.querySelector('[data-field=query]').value = 'up';
  doc.getElementById('wd-title').value = 'Up';
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/admin/widgets' && s.method === 'POST'), 'POST');
  assert.deepEqual(JSON.parse(seen.find((s) => s.url === 'api/admin/widgets').body),
                   { type: 'vm.stat', title: 'Up', config: { query: 'up', format: 'number' }, audience: [] });
  await settle(window, () => !doc.body.classList.contains('editing'), 'dialog closes');

  // Edit from the library: prefilled, type locked, previewed on open.
  click([...doc.querySelectorAll('#widget-lib .wl-name')].find((x) => x.textContent === 'NAS used'));
  await settle(window, () => doc.querySelector('[data-field=query]'), 'edit form');
  assert.equal(doc.getElementById('wd-type').disabled, true);
  assert.equal(doc.getElementById('wd-title').value, 'NAS used');
  assert.equal(doc.querySelector('[data-field=query]').value, 'max(nas_used_pct)');
  assert.equal(doc.querySelector('[data-field=warn]').value, '80');
  await settle(window, () => doc.querySelector('#wd-preview .w-value'), 'preview on open');
  doc.querySelector('[data-field=warn]').value = '85';
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/admin/widgets/1' && s.method === 'PUT'), 'PUT');
  assert.equal(JSON.parse(seen.find((s) => s.url === 'api/admin/widgets/1').body).config.warn, 85);

  // Delete, from the same dialog.
  click([...doc.querySelectorAll('#widget-lib .wl-name')].find((x) => x.textContent === 'NAS used'));
  await settle(window, () => doc.getElementById('wd-delete'), 'delete button');
  click(doc.getElementById('wd-delete'));
  await settle(window, () => seen.some((s) => s.url === 'api/admin/widgets/1' && s.method === 'DELETE'), 'DELETE');
});

test('a widgets outage costs the widgets, never the tiles', async () => {
  const { window, doc } = await boot(APPS, (u) => u === 'api/widgets' ? { status: 500 } : null);
  assert.ok(doc.querySelectorAll('a.app').length > 0);
  assert.equal(doc.querySelector('.widget-row'), null);
});

// --- legend folding, per-line identifiers, the label picker -----------------------

test('the legend folds away, and a saved widget remembers it per device', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes);
  await settle(window, () => doc.querySelector('.widget-cell[data-def="2"] .w-legend'), 'chart legend');
  const cell = () => doc.querySelector('.widget-cell[data-def="2"]');
  click(cell().querySelector('.w-legend-btn'));
  assert.equal(cell().querySelector('.w-legend').hidden, true);
  assert.equal(cell().querySelector('.w-legend-btn').textContent, 'Show legend');
  assert.equal(JSON.parse(window.localStorage.getItem('nav.widgetui')).def2.legend, false);
  // Still identifiable without it: the table names every line.
  click(cell().querySelector('.w-table-btn'));
  assert.equal(cell().querySelectorAll('.w-table th').length, 3);
});

test('a folded legend stays folded on the next load', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes,
    (w) => w.localStorage.setItem('nav.widgetui', JSON.stringify({ def2: { legend: false } })));
  await settle(window, () => doc.querySelector('.widget-cell[data-def="2"] .w-legend'), 'chart');
  assert.equal(doc.querySelector('.widget-cell[data-def="2"] .w-legend').hidden, true);
});

test("each line's own identifier shows in the tooltip", async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  const p = SERIES(2);
  p.data.series[0].unit = 'grifPool';
  p.data.series[1].unit = 'backup';
  p.data.format = 'number';
  window.renderWidget(el, p);
  el.querySelector('.w-plot').dispatchEvent(new window.FocusEvent('focus'));
  assert.deepEqual([...el.querySelectorAll('.w-tip strong')].map((x) => x.textContent),
                   ['30 grifPool', '31 backup']);
});

test('the designer offers the query labels and inserts one where you were typing', async () => {
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u.startsWith('api/widgets/types') ? TYPES :
    u.startsWith('api/widgets/labels') ? { labels: {
      instance: { values: ['wk1', 'wk2'], count: 5 }, job: { values: ['node'], count: 1 } } } :
    u.startsWith('api/widgets/preview') ? SERIES(2) : null);
  window.widgetDesigner(null);
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'types');
  const sel = doc.getElementById('wd-type');
  sel.selectedIndex = 1;
  sel.dispatchEvent(new window.Event('change'));
  doc.querySelector('[data-field=query]').value = 'node_cpu_pct';
  doc.getElementById('wd-preview-btn').click();
  await settle(window, () => doc.querySelectorAll('#wd-labels .wd-label').length === 2, 'label chips');
  assert.ok(seen.some((x) => x.url === 'api/widgets/labels'));
  assert.match(doc.querySelector('.wd-label[data-label=instance]').textContent, /wk1, wk2, \+3/);

  // Focus the unit field, then click a label: it lands there, not in legend.
  const unit = doc.querySelector('[data-field=unit]');
  unit.dispatchEvent(new window.FocusEvent('focus'));
  unit.value = 'on ';
  unit.setSelectionRange(3, 3);
  click(doc.querySelector('.wd-label[data-label=instance]'));
  assert.equal(unit.value, 'on {{instance}}');
  assert.equal(doc.querySelector('[data-field=legend]').value, '');
});

// --- the shared group grid: order, drag, sizes ---------------------------------

/** Fire a synthetic drag (see drag()) from `from` onto `onto`. */
function dragTo(window, from, onto) { return drag(window, from, onto); }

test('admin mode interleaves tiles and widgets by their shared position', async () => {
  const apps = { ...APPS, apps: APPS.apps.map((a) => ({ ...a, order: a.slug === 'sonarr' ? 0 : 2 })) };
  const saved = { ...SAVED, placements: [{ id: 10, def_id: 1, category: 'Media', ord: 1, size: null }] };
  const { window, doc } = await boot(apps, null, (u) => u === 'api/widgets' ? saved : widgetRoutes(u));
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('.ugrid .widget-cell'), 'grid');
  assert.deepEqual([...doc.querySelector('.ugrid').children].map((c) => c.dataset.key),
                   ['app:sonarr', 'w:10', 'app:books']);
});

test('dragging a widget before a tile writes one layout for the group', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes);
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('.widget-cell[data-placement="10"]'), 'grid');
  const w = doc.querySelector('.widget-cell[data-placement="10"]');
  const sonarr = doc.querySelector('[data-key="app:sonarr"]');
  const { enter, over } = dragTo(window, w, sonarr);
  assert.ok(enter.defaultPrevented && over.defaultPrevented, 'the grid must accept the drop');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/order'), 'layout PUT');
  const body = JSON.parse(seen.find((r) => r.url === 'api/layouts/1/order').body);
  assert.equal(body.category, 'Media');
  // sonarr has order 0, books 1 in the fixture; the widget lands before sonarr.
  assert.deepEqual(body.items, [{ widget: 10 }, { app: 'sonarr' }, { app: 'books' }]);
});

test('dropping on empty grid space appends; a tile can move into a widget group', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes);
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('.ugrid[data-cat="Monitoring"]'), 'grid');
  const books = doc.querySelector('[data-key="app:books"] a.app');
  dragTo(window, books, doc.querySelector('.ugrid[data-cat="Monitoring"]'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/order'), 'layout PUT');
  const body = JSON.parse(seen.find((r) => r.url === 'api/layouts/1/order').body);
  assert.equal(body.category, 'Monitoring');
  assert.deepEqual(body.items, [{ widget: 11 }, { widget: 12 }, { app: 'books' }]);
});

test('a library widget dragged into a group is placed, then positioned', async () => {
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u === 'api/layouts/1/placements' ? { ok: true, id: 99 } : widgetRoutes(u));
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelectorAll('#widget-lib li.wl-drag').length === 2, 'library');
  const cpu = [...doc.querySelectorAll('#widget-lib li.wl-drag')]
    .find((li) => li.querySelector('.wl-name').textContent === 'CPU');
  dragTo(window, cpu, doc.querySelector('[data-key="app:sonarr"]'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/placements'), 'placement POST');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/1/placements').body),
                   { def_id: 2, category: 'Media', ord: -1 });
});

test('sizes map to spans, and the arrow keys resize a tile and a widget', async () => {
  const { window, doc, seen } = await boot(APPS, null, widgetRoutes);
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('.widget-cell[data-placement="12"]'), 'grid');
  const sonarr = doc.querySelector('[data-key="app:sonarr"]');
  // Columns are half a tile wide (group-grid.js), so an M tile spans 4.
  assert.equal(sonarr.dataset.size, 'M');
  assert.equal(sonarr.style.gridColumn, 'span 4');
  const chart = doc.querySelector('.widget-cell[data-placement="12"]');
  assert.equal(chart.dataset.size, 'M');
  assert.equal(chart.style.gridColumn, 'span 8');
  assert.equal(chart.style.gridRow, 'span 6');

  const key = (el, k) => el.querySelector('.resize-handle')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key(sonarr, 'ArrowLeft');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/tiles' && r.method === 'PUT'), 'tile size');
  assert.equal(JSON.parse(seen.find((r) => r.url === 'api/layouts/1/tiles').body).tiles.sonarr.size, 'S');
  await settle(window, () => doc.querySelector('[data-key="app:sonarr"]').dataset.size === 'S', 'redrawn small');
  assert.equal(doc.querySelector('[data-key="app:sonarr"]').style.gridColumn, 'span 2');

  key(doc.querySelector('.widget-cell[data-placement="12"]'), 'ArrowRight');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/placements/12'), 'widget size');
  // A widget moves by cells, not named sizes: M (8x6) one column wider.
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/1/placements/12').body), { size: '9x6' });

  // Back to the default -- the span is M's, so it is M again -- stores NO size, so a later default change reaches it.
  key(doc.querySelector('.widget-cell[data-placement="12"]'), 'ArrowLeft');
  await settle(window, () => seen.filter((r) => r.url === 'api/layouts/1/placements/12').length === 2, 'reset');
  assert.deepEqual(JSON.parse(seen.filter((r) => r.url === 'api/layouts/1/placements/12')[1].body), { size: null });
});

test('a widget takes any span, by cells, drawn as the largest size inside it', async () => {
  const big = { ...SAVED, placements: SAVED.placements.map((p) => p.id === 12 ? { ...p, size: 'XL' }
    : p.id === 11 ? { ...p, size: '16x10' } : p) };
  const { window, doc, seen } = await boot(APPS, null, (u) => u === 'api/widgets' ? big : widgetRoutes(u));
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('.widget-cell[data-placement="11"]'), 'grid');
  const custom = doc.querySelector('.widget-cell[data-placement="11"]');
  assert.equal(custom.style.gridColumn, 'span 16');
  assert.equal(custom.style.gridRow, 'span 10');
  assert.equal(custom.dataset.base, 'L', 'a stat at 16x10 is drawn as its L');
  assert.ok(custom.classList.contains('size-L') && custom.classList.contains('size-custom'));
  const key = (el, k) => el.querySelector('.resize-handle')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key(doc.querySelector('.widget-cell[data-placement="12"]'), 'ArrowRight');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/placements/12'), 'grow');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/1/placements/12').body), { size: '13x8' });
  key(custom, 'ArrowUp');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/placements/11'), 'shrink a row');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/1/placements/11').body), { size: '16x9' });
  // Between the presets too: a 6x2 weather is a strip, a 2x8 clock lists its zones.
  assert.equal(window.sizeBase('stat', '5x3'), 'S');
  assert.equal(window.sizeBase('list', '2x2'), 'S', 'nothing fits: the smallest');
  assert.equal(window.sizeForSpan('weather', 24, 2, 24), 'W', 'the full row at W height is W');
  assert.equal(window.sizeForSpan('clock', 4, 4, 24), 'M');
  const wx = doc.createElement('div');
  window.renderWidget(wx, WEATHER, { size: 'S', span: [6, 2] });
  assert.ok(wx.querySelector('.wx-narrow .wx-strip'));
  const tall = doc.createElement('div');
  window.renderWidget(tall, WEATHER, { size: 'M', span: [4, 8] });
  assert.equal(tall.querySelectorAll('.wx-days li').length, 7, 'room for the week');
});

test('the tile editor offers Size and keeps it on save', async () => {
  const apps = { ...APPS, apps: APPS.apps.map((a) => a.slug === 'sonarr'
    ? { ...a, size: 'L', override: { size: 'L' } } : a) };
  const { window, doc, seen } = await boot(apps);
  await enterAdmin(window, doc);
  assert.equal(doc.querySelector('[data-key="app:sonarr"]').dataset.size, 'L');
  click(doc.querySelector('[data-key="app:sonarr"] a.app'));
  await settle(window, () => doc.getElementById('editor-size'), 'editor');
  assert.equal(doc.getElementById('editor-size').value, 'L');
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/1/tiles'), 'save');
  assert.equal(JSON.parse(seen.find((r) => r.url === 'api/layouts/1/tiles').body).tiles.sonarr.size, 'L');
});

test('icons-only view keeps its own layout, widgets in a row above', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes,
    (w) => w.localStorage.setItem('nav.view', JSON.stringify({ collapse: 'on' })));
  await settle(window, () => doc.querySelector('.widget-row'), 'widget row');
  assert.equal(doc.querySelector('.ugrid'), null);
  assert.ok(doc.querySelector('ul.tiles.collapsed'));
});

test('column-first fill uses the same grid, handles and all', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes,
    (w) => w.localStorage.setItem('nav.view', JSON.stringify({ flow: 'col', sort: 'defined' })));
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('.ugrid[data-cat="Media"]'), 'grid');
  const g = doc.querySelector('.ugrid[data-cat="Media"]');
  assert.ok(g.classList.contains('colfirst'));
  // Half-size cells: two M tiles (4x2) + one M stat (4x4) on 24 columns is
  // area 32 -> 2 rows, but the stat is 4 tall, so 4 rows.
  assert.equal(g.dataset.rows, '4');
  // Placed at explicit cells, never left to spill into implicit columns.
  for (const li of g.children) { assert.match(li.style.gridColumn, /^\d+ \/ span \d+$/); }
  assert.ok(g.querySelectorAll('.resize-handle').length >= 3, 'resizing works here too');
});

test('a drop renumbers from the order on screen, not the stored sequence', async () => {
  // The packer backfills: the item SHOWN second can be seventh in the stored
  // sequence. Renumbering by the sequence then moved items nobody touched
  // ("moved Calibre to 2nd, Navidrome went to 7th"). onScreenOrder() reads the
  // placed cells, so the sequence becomes what the person saw.
  const { window, doc } = await boot(APPS);
  const ul = doc.createElement('ul');
  ul.className = 'ugrid colfirst';
  ul.dataset.cat = 'Shown';
  // Sequence a, b, c -- but on screen c sits above b in the first column.
  [['a', '1 / span 4', '1 / span 2'], ['b', '1 / span 4', '5 / span 2'], ['c', '1 / span 4', '3 / span 2']]
    .forEach(([k, col, row]) => {
      const li = doc.createElement('li');
      li.dataset.key = k; li.style.gridColumn = col; li.style.gridRow = row;
      ul.appendChild(li);
    });
  doc.body.appendChild(ul);
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'offscreen' }];
  const got = window.onScreenOrder('Shown', items).map((x) => x.key);
  assert.deepEqual(got, ['a', 'c', 'b', 'offscreen'], 'column-first reads down the placed cells; unplaced keep their place after');
  assert.deepEqual(window.onScreenOrder('Absent', items).map((x) => x.key), ['a', 'b', 'c', 'offscreen'],
    'no grid on screen: the stored sequence stands');
  ul.remove();
});

test('column-first packing adds rows rather than spilling past the columns', async () => {
  const { window } = await boot(APPS);
  // Area 40 on 8 columns says 5 rows, but after two 4x4 blocks side by side
  // the 4x2 has nowhere to go in 5: it takes a 6th row, not a 9th column.
  const sp = [[4, 4], [4, 4], [4, 2]];
  const p = JSON.parse(JSON.stringify(window.packColumns(sp, 8)));
  assert.deepEqual(p, { rows: 6, at: [[0, 0], [4, 0], [0, 4]] });
  const q = JSON.parse(JSON.stringify(window.packColumns([[4, 2], [4, 2], [4, 4]], 24)));
  assert.deepEqual(q, { rows: 4, at: [[0, 0], [0, 2], [4, 0]] });
});

// --- compact widgets and the full view over them --------------------------------

const COMPACT = { ...SAVED, placements: [
  { id: 10, def_id: 1, category: 'Media', ord: 0, size: 'XS' },
  { id: 12, def_id: 2, category: 'Media', ord: 1, size: 'XS' },
  { id: 13, def_id: 2, category: 'Media', ord: 2, size: 'S' }
] };
const compactRoutes = (u) => u === 'api/widgets' ? COMPACT : widgetRoutes(u);

test('XS widgets are the smallest spans, and draw compactly', async () => {
  const { window, doc } = await boot(APPS, null, compactRoutes);
  await settle(window, () => doc.querySelector('[data-placement="12"] path.w-line'), 'chart');
  const stat = doc.querySelector('[data-placement="10"]');
  assert.equal(stat.style.gridColumn, 'span 2');
  assert.equal(stat.style.gridRow, 'span 2');
  // The status word moves into the dot's label; no trend line at XS.
  const lv = stat.querySelector('.w-level');
  assert.equal(lv.textContent, '');
  assert.equal(lv.getAttribute('aria-label'), 'Warning');
  assert.equal(stat.querySelector('.w-spark'), null);

  const spark = doc.querySelector('[data-placement="12"]');
  assert.equal(spark.style.gridColumn, 'span 4');
  assert.equal(spark.style.gridRow, 'span 2');
  assert.equal(spark.querySelectorAll('svg text').length, 0, 'XS has no axes');
  assert.equal(spark.querySelector('.w-legend'), null);
  assert.equal(spark.querySelector('.w-tools'), null);

  const small = doc.querySelector('[data-placement="13"]');
  assert.equal(small.style.gridColumn, 'span 4');
  assert.equal(small.style.gridRow, 'span 4');
  assert.ok(small.querySelectorAll('svg text').length > 0, 'S keeps a minimal frame');
  assert.equal(small.querySelector('.w-legend'), null);
});

test('focusing a compact widget opens the full widget, Escape closes it', async () => {
  const { window, doc } = await boot(APPS, null, compactRoutes);
  await settle(window, () => doc.querySelector('[data-placement="12"] path.w-line'), 'chart');
  const cell = doc.querySelector('[data-placement="12"]');
  assert.equal(cell.tabIndex, 0, 'compact widgets are keyboard-focusable');
  cell.dispatchEvent(new window.FocusEvent('focus'));
  const peek = doc.querySelector('.w-peek');
  assert.ok(peek, 'the full view opens');
  // FULL: legend, table and tooltip are all back.
  assert.equal(peek.querySelectorAll('.w-legend span').length, 2);
  assert.ok(peek.querySelector('.w-table-btn'));
  assert.ok(peek.querySelectorAll('svg text').length > 4, 'full axes');
  cell.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.querySelector('.w-peek'), null);
});

test('hovering opens the full view after a pause, and leaving closes it', async () => {
  const { window, doc } = await boot(APPS, null, compactRoutes);
  await settle(window, () => doc.querySelector('[data-placement="10"] .w-value'), 'stat');
  const cell = doc.querySelector('[data-placement="10"]');
  cell.dispatchEvent(new window.MouseEvent('mouseenter'));
  assert.equal(doc.querySelector('.w-peek'), null, 'not instantly -- passing over must not flash');
  await new Promise((r) => window.setTimeout(r, 350));
  const peek = doc.querySelector('.w-peek');
  assert.ok(peek);
  assert.match(peek.querySelector('.w-value').textContent, /Warning$/, 'the word is back in full view');
  cell.dispatchEvent(new window.MouseEvent('mouseleave', { relatedTarget: doc.body }));
  assert.equal(doc.querySelector('.w-peek'), null);
});

test('full-size widgets have no hover panel', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes);
  await settle(window, () => doc.querySelector('[data-placement="12"] path.w-line'), 'chart');
  const cell = doc.querySelector('[data-placement="12"]');
  cell.dispatchEvent(new window.FocusEvent('focus'));
  assert.equal(doc.querySelector('.w-peek'), null);
});

test('a tile can be XS: icon alone in one narrow column, name kept for readers', async () => {
  const apps = { ...APPS, apps: APPS.apps.map((a) => a.slug === 'sonarr'
    ? { ...a, size: 'XS', override: { size: 'XS' } } : a) };
  const { window, doc, seen } = await boot(apps);
  await enterAdmin(window, doc);
  const t = doc.querySelector('[data-key="app:sonarr"]');
  assert.equal(t.dataset.size, 'XS');
  assert.equal(t.style.gridColumn, 'span 1');
  assert.equal(t.querySelector('.name').textContent, 'Sonarr', 'still in the DOM, shown on hover');
  assert.equal(window.getComputedStyle(t.querySelector('.text')).display, 'none');
  // Smallest size: the arrow keys cannot go below it.
  t.querySelector('.resize-handle').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(seen.filter((r) => r.url === 'api/layouts/1/tiles' && r.method === 'PUT').length, 0);
  // The editor offers it.
  click(t.querySelector('a.app'));
  await settle(window, () => doc.getElementById('editor-size'), 'editor');
  assert.equal(doc.getElementById('editor-size').value, 'XS');
  assert.ok([...doc.getElementById('editor-size').options].some((o) => o.value === 'XS'));
});

// --- chart thresholds, and resize robustness -----------------------------------

const THRESH = (lv, size) => ({ type: 'vm.timeseries', shape: 'timeseries', data: {
  label: 'Disk', format: 'percent', decimals: 0, range: [0, 300], truncated: 0,
  warn: 80, crit: 90, higher_is: 'bad', level: lv,
  series: [{ name: 'wk1', points: [[0, 60], [100, 70], [300, 85]] },
           { name: 'wk2', points: [[0, 40], [100, 45], [300, 50]] }] } });

test('a chart draws its thresholds and says its status', async () => {
  const { window, doc } = await boot();
  const el = doc.createElement('div');
  window.renderWidget(el, THRESH('warn'));
  // 85 is the top of the data; 90 (critical) sits just above and is pulled
  // into view rather than drawn off the chart.
  assert.equal(el.querySelectorAll('line.w-threshold').length, 2);
  assert.deepEqual([...el.querySelectorAll('text.w-threshold-label')].map((t) => t.textContent),
                   ['warn 80%', 'critical 90%']);
  const lv = el.querySelector('.w-label .w-level');
  assert.equal(lv.textContent, 'Warning', 'full size: dot and word');

  const small = doc.createElement('div');
  window.renderWidget(small, THRESH('crit'), { size: 'XS' });
  const dot = small.querySelector('.w-label .w-level');
  assert.equal(dot.textContent, '');
  assert.equal(dot.getAttribute('aria-label'), 'Critical', 'compact: the dot carries the word');
  assert.equal(small.querySelectorAll('text.w-threshold-label').length, 0, 'no labels when compact');
});

test('grabbing a widget resize corner never starts a drag of the widget', async () => {
  const { window, doc } = await boot(APPS, null, widgetRoutes);
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelector('[data-placement="12"] .resize-handle'), 'handle');
  const h = doc.querySelector('[data-placement="12"] .resize-handle');
  assert.equal(h.draggable, false);
  const md = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  h.dispatchEvent(md);
  assert.ok(md.defaultPrevented, 'mousedown on the corner must not begin a native drag');
  const ds = new window.Event('dragstart', { bubbles: true, cancelable: true });
  h.dispatchEvent(ds);
  assert.ok(ds.defaultPrevented, 'and a dragstart from it is cancelled outright');
});

test('a refused resize says so and re-reads, rather than looking saved', async () => {
  const alerts = [];
  const { window, doc, seen } = await boot(APPS,
    (u) => u === 'api/layouts/1/tiles' ? { status: 422 } : null, null,
    (w) => { w.alert = (m) => alerts.push(m); });
  await enterAdmin(window, doc);
  const before = seen.filter((r) => r.url.startsWith('api/apps')).length;
  doc.querySelector('[data-key="app:sonarr"] .resize-handle')
    .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await settle(window, () => alerts.length > 0, 'an alert');
  assert.match(alerts[0], /Resize failed/);
  await settle(window, () => seen.filter((r) => r.url.startsWith('api/apps')).length > before, 're-read');
});

test('hovering a library widget peeks at it, fetching it if it is placed nowhere', async () => {
  const unplaced = { defs: [...SAVED.defs, { id: 7, type: 'vm.timeseries', title: 'Loose', shape: 'timeseries' }],
                     placements: SAVED.placements };
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u === 'api/widgets' ? unplaced : u.startsWith('api/widgets/7/data') ? SERIES(2) : widgetRoutes(u));
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelectorAll('#widget-lib li').length === 3, 'library');
  const loose = [...doc.querySelectorAll('#widget-lib li')].find((li) => li.querySelector('.wl-name').textContent === 'Loose');
  assert.equal(seen.filter((r) => r.url.startsWith('api/widgets/7/data')).length, 0, 'not fetched until wanted');
  loose.dispatchEvent(new window.MouseEvent('mouseenter'));
  await new Promise((r) => window.setTimeout(r, 350));
  await settle(window, () => doc.querySelector('.w-peek .w-legend'), 'peek');
  assert.equal(seen.filter((r) => r.url.startsWith('api/widgets/7/data')).length, 1);
  loose.dispatchEvent(new window.MouseEvent('mouseleave', { relatedTarget: doc.body }));
  assert.equal(doc.querySelector('.w-peek'), null);
  // Leaving before it arrives must not leave a panel behind.
  const nas = [...doc.querySelectorAll('#widget-lib li')].find((li) => li.querySelector('.wl-name').textContent === 'NAS used');
  nas.dispatchEvent(new window.MouseEvent('mouseenter'));
  nas.dispatchEvent(new window.MouseEvent('mouseleave', { relatedTarget: doc.body }));
  await new Promise((r) => window.setTimeout(r, 350));
  assert.equal(doc.querySelector('.w-peek'), null);
});

test('a resize drag commits even when its pointerup never arrives', async () => {
  const mk = (s, i) => ({ slug: s, name: s, url: 'https://' + s + '.x', description: 'd', category: 'Media',
    icon: '', clicks_mine: 0, clicks_all: 0, order: i, size: 'S', base: {}, override: { size: 'S', order: i } });
  const { window, doc, seen } = await boot({ ...APPS, apps: ['plex', 'seer'].map(mk) }, null, null,
    (w) => w.localStorage.setItem('nav.view', JSON.stringify({ flow: 'col', sort: 'defined' })));
  await enterAdmin(window, doc);
  const drag = (slug, end) => {
    const t = doc.querySelector(`[data-key="app:${slug}"]`);
    const h = t.querySelector('.resize-handle');
    // jsdom has no layout: a 24-column grid of 53px cells, an S tile (2x2).
    Object.defineProperty(t.parentNode, 'clientWidth', { value: 24 * 53 + 23 * 10 });
    t.getBoundingClientRect = () => ({ width: 116, height: 76 });
    const ev = (type, x, y) => h.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
    ev('pointerdown', 200, 200);
    ev('pointermove', 200 - 63, 200 - 43);           // to one cell: XS
    assert.equal(t.dataset.size, 'XS', 'drawn XS while dragging');
    ev(end, 137, 157);
  };
  const puts = () => seen.filter((r) => r.method === 'PUT' && r.url === 'api/layouts/1/tiles').map((r) => r.body);
  drag('plex', 'lostpointercapture');             // the release went missing
  assert.deepEqual(puts(), ['{"tiles":{"plex":{"size":"XS","order":0}}}']);
  drag('seer', 'pointerup');
  // ...and the next resize's render does not grow the first one back.
  assert.equal(doc.querySelector('[data-key="app:plex"]').dataset.size, 'XS');
  assert.equal(doc.querySelector('[data-key="app:seer"]').dataset.size, 'XS');
  assert.equal(puts().length, 2, 'once each: pointerup after lostpointercapture is not a second save');
});

// --- templates (roadmap #34 step 6) -------------------------------------------

const FAMILY = { id: 2, kind: 'template', name: 'Family', template_id: null,
                 is_default: false, group_order: ['Media'], group_hidden: [] };
const familyRoutes = (u) => u.startsWith('api/apps') && /layout=2/.test(u) ? { ...APPS, layout: FAMILY } : null;
const pick = (window, doc, v) => {
  const sel = doc.getElementById('admin-tpl');
  sel.value = v;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
};

test('the admin picks which template to edit; reads and writes follow it', async () => {
  const { window, doc, seen } = await boot(APPS, null, familyRoutes);
  await enterAdmin(window, doc);
  await settle(window, () => doc.querySelectorAll('#admin-tpl option').length > 2, 'picker');
  const opts = [...doc.querySelectorAll('#admin-tpl option')].map((o) => o.textContent);
  assert.deepEqual(opts.slice(0, 2), ['Default (default)', 'Family']);
  assert.ok(!opts.includes('Delete…'), 'the default cannot be deleted');
  assert.match(doc.getElementById('admin-tpl-note').textContent, /everyone without a dashboard/);

  pick(window, doc, 't:2');
  await settle(window, () => doc.getElementById('admin-tpl').value === 't:2', 'Family shown');
  assert.ok(seen.some((r) => /^api\/apps\?include_hidden=true&layout=2$/.test(r.url)));
  assert.ok(seen.some((r) => r.url === 'api/widgets?layout=2'));
  assert.equal(window.localStorage.getItem('nav.admintpl'), '2', 'remembered on this device');
  assert.match(doc.getElementById('admin-tpl-note').textContent, /nobody sees it/);
  assert.ok([...doc.querySelectorAll('#admin-tpl option')].some((o) => o.value === 'delete'));

  // A tile edit splits: the name site-wide, the size into THIS template.
  const t = doc.querySelector('[data-key="app:sonarr"]');
  t.querySelector('.resize-handle').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/2/tiles'), 'template write');
  assert.equal(JSON.parse(seen.find((r) => r.url === 'api/layouts/2/tiles').body).tiles.sonarr.size, 'S');
  // Leaving admin mode shows the default again, whatever was being edited.
  click(doc.getElementById('admin-done'));
  await settle(window, () => seen.filter((r) => r.url === 'api/apps').length > 0, 'plain reload');
});

test('the picker makes, renames and deletes templates', async () => {
  const answers = ['Kids', 'Family room'];
  const { window, doc, seen } = await boot(APPS, null, (u) =>
    u === 'api/layouts' ? null : familyRoutes(u), (w) => {
      w.prompt = () => answers.shift();
      w.confirm = () => true;
      w.localStorage.setItem('nav.admintpl', '2');
    });
  await enterAdmin(window, doc);
  await settle(window, () => doc.getElementById('admin-tpl').value === 't:2', 'Family');
  pick(window, doc, 'dup');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts' && r.method === 'POST'), 'POST');
  assert.deepEqual(JSON.parse(seen.find((r) => r.method === 'POST').body),
                   { kind: 'template', name: 'Kids', from_id: 2 });
  assert.equal(doc.getElementById('admin-tpl').value, 't:2', 'the select shows a template, never an action');
  pick(window, doc, 'rename');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/2' && r.method === 'PUT'), 'rename');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/2').body), { name: 'Family room' });
  pick(window, doc, 'delete');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/2' && r.method === 'DELETE'), 'delete');
  await settle(window, () => window.localStorage.getItem('nav.admintpl') === 'null', 'back to the default');
});

test('a template deleted elsewhere falls back to the default', async () => {
  const { window, doc, seen } = await boot(APPS, (u) => /layout=7/.test(u) ? { status: 404 } : null, null,
    (w) => w.localStorage.setItem('nav.admintpl', '7'));
  await enterAdmin(window, doc);
  await settle(window, () => seen.some((r) => r.url === 'api/apps?include_hidden=true'), 'retry without it');
  assert.equal(window.localStorage.getItem('nav.admintpl'), 'null');
  assert.equal(doc.getElementById('out').className.includes('err'), false);
});

// --- personal dashboards (roadmap #34 step 7) ----------------------------------

const DASH = { id: 5, kind: 'dashboard', name: 'My dashboard', template_id: 1,
               is_default: false, group_order: [], group_hidden: [] };
const USER = { ...APPS, admin: false, may_impersonate: false };
function dashRoutes(state) {
  return (u) => {
    if (u.startsWith('api/apps') && /layout=5/.test(u)) { return { ...USER, layout: DASH }; }
    if (u === 'api/layouts') {
      return state.created
        ? { ...LAYOUT_LIST, dashboards: [{ id: 5, name: 'My dashboard', template_id: 1 }] }
        : LAYOUT_LIST;
    }
    return widgetRoutes(u);
  };
}
const menuItem = (doc, text) => [...doc.querySelectorAll('#menu-list button')]
  .find((b) => b.textContent.replace('✓ ', '') === text);

test('a user makes the shared page their own, then arranges it', async () => {
  // The stub answers by URL alone, so the list doubles as the POST's reply.
  const { window, doc, seen } = await boot(USER, null, (u) =>
    u === 'api/layouts' ? { ...LAYOUT_LIST, ok: true, id: 5 } : dashRoutes({ created: false })(u));
  click(doc.getElementById('menu-btn'));
  const shared = menuItem(doc, 'Default (shared)');
  assert.ok(shared, 'the shared default is listed');
  assert.equal(shared.getAttribute('aria-checked'), 'true');
  assert.ok(!menuItem(doc, 'Administration…'), 'not an admin');
  click(menuItem(doc, 'Make it mine…'));
  await settle(window, () => doc.getElementById('dash-name'), 'dialog');
  assert.equal(doc.getElementById('dash-name').value, 'My dashboard');
  assert.equal(doc.getElementById('dash-from').value, '1', 'starts as the page on screen');
  click(doc.getElementById('dash-create'));
  await settle(window, () => doc.body.classList.contains('edit-mode'), 'edit mode');
  assert.deepEqual(JSON.parse(seen.find((r) => r.method === 'POST' && r.url === 'api/layouts').body),
                   { kind: 'dashboard', name: 'My dashboard', from_id: 1 });
  assert.equal(window.localStorage.getItem('nav.layout'), '5', 'this device shows it from now on');
  assert.ok(seen.some((r) => r.method === 'PUT' && /^api\/device\//.test(r.url)), 'on record');
  assert.ok(seen.some((r) => r.url === 'api/apps?include_hidden=true&layout=5'));
  assert.equal(doc.getElementById('edit-name').textContent, '“My dashboard”');

  // Arranging writes to the dashboard, all of a tile's fields in one place.
  const t = doc.querySelector('[data-key="app:sonarr"]');
  t.querySelector('.resize-handle').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/5/tiles'), 'dashboard write');
  assert.equal(seen.filter((r) => r.url === 'api/admin/presentation').length, 0,
               'a dashboard never writes the site-wide half');
  // A palette to drag from, not the admin's library to edit.
  assert.equal(doc.getElementById('widget-new'), null);
  assert.equal(doc.getElementById('admin-bulk-btn').offsetParent, null);

  click(doc.getElementById('edit-done'));
  await settle(window, () => !doc.body.classList.contains('edit-mode'), 'done');
  await settle(window, () => doc.querySelector('a.app[href]'), 'tiles are links again');
});

test('in edit mode a user makes, edits and deletes widgets of their own', async () => {
  const MINE = { id: 9, type: 'vm.stat', title: 'My up', shape: 'stat', missing: false, mine: true,
                 config: { query: 'up' } };
  const lib = { ...SAVED, defs: [...SAVED.defs, MINE], layout_id: 5, placements: [] };
  const { window, doc, seen } = await boot(USER, null, (u) =>
    u.startsWith('api/widgets?') ? lib :
    u === 'api/widgets' ? { ok: true, id: 9 } :
    u.startsWith('api/widgets/9') ? { ok: true, id: 9 } :
    dashRoutes({ created: true })(u), (w) => {
    w.localStorage.setItem('nav.layout', '5');
    w.confirm = () => true;
  });
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.getElementById('widget-new-mine'), 'my widgets');
  const mine = doc.querySelector('#widget-lib .wl-mine');
  assert.deepEqual([...mine.querySelectorAll('.wl-name')].map((e) => e.textContent), ['My up']);

  click(doc.getElementById('widget-new-mine'));
  await settle(window, () => doc.querySelectorAll('#wd-type option').length === 2, 'types');
  assert.equal(doc.getElementById('editor-title').textContent, 'New personal widget');
  doc.querySelector('[data-field=query]').value = 'up';
  doc.getElementById('wd-title').value = 'Up';
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/widgets' && s.method === 'POST'), 'POST');
  assert.equal(seen.filter((s) => /^api\/admin\/widgets/.test(s.url)).length, 0);

  click(doc.querySelector('#widget-lib .wl-mine button.wl-name'));
  await settle(window, () => doc.querySelector('[data-field=query]'), 'edit form');
  assert.equal(doc.getElementById('editor-title').textContent, 'Edit personal widget');
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/widgets/9' && s.method === 'PUT'), 'PUT');
  click(doc.querySelector('#widget-lib .wl-mine button.wl-name'));
  await settle(window, () => doc.getElementById('wd-delete'), 'delete button');
  click(doc.getElementById('wd-delete'));
  await settle(window, () => seen.some((s) => s.url === 'api/widgets/9' && s.method === 'DELETE'), 'DELETE');
});

test('in edit mode a placed widget is edited in place, the library is a palette', async () => {
  const lib = { ...SAVED, layout_id: 5 };
  const { window, doc, seen } = await boot(USER, null, (u) =>
    u.startsWith('api/widgets?') ? lib :
    u.startsWith('api/layouts/5/placements/') ? { ok: true, id: 11, def_id: 9, copied: true } :
    dashRoutes({ created: true })(u), (w) => w.localStorage.setItem('nav.layout', '5'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.querySelector('#widget-lib .wl-list .wl-name'), 'library');
  assert.equal(doc.querySelector('#widget-lib .wl-list li:not(.wl-mine) button.wl-name'), null,
               'library widgets: a palette to drag from, not edited here');
  const cell = doc.querySelector('.widget-cell[data-placement="11"]');
  click(cell.querySelector('.w-edit'));
  await settle(window, () => doc.querySelector('[data-field=warn]'), 'form');
  assert.equal(doc.getElementById('editor-title').textContent, 'Edit this widget');
  assert.match(doc.getElementById('wd-in-place').textContent, /this one only/);
  assert.equal(doc.getElementById('wd-delete'), null, 'removing is the ×');
  assert.equal(doc.querySelector('[data-field=warn]').value, '80', 'starts from what it shows');
  doc.querySelector('[data-field=warn]').value = '90';
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((s) => s.url === 'api/layouts/5/placements/11/widget'), 'PUT');
  const put = seen.find((s) => s.url === 'api/layouts/5/placements/11/widget');
  assert.equal(put.method, 'PUT');
  assert.deepEqual(JSON.parse(put.body), { title: 'NAS used', config: { query: 'max(nas_used_pct)',
    format: 'percent', warn: 90 } });
  assert.equal(seen.filter((s) => /^api\/(admin\/)?widgets\/\d/.test(s.url) && s.method !== 'GET').length, 0,
               'no definition is written directly');
});

test('admin mode does not offer personal widgets to a template', async () => {
  const lib = { ...SAVED, defs: [...SAVED.defs, { id: 9, type: 'vm.stat', title: 'My up',
                shape: 'stat', mine: true, config: {} }] };
  const { window, doc } = await boot(APPS, null, (u) => u.startsWith('api/widgets?') || u === 'api/widgets'
    ? lib : widgetRoutes(u));
  await enterAdmin(window, doc);
  await settle(window, () => doc.getElementById('widget-new'), 'library');
  assert.equal(doc.querySelector('#widget-lib .wl-mine'), null);
  assert.ok(![...doc.querySelectorAll('#widget-lib .wl-name')].some((e) => e.textContent === 'My up'));
});

test('a device opens on its dashboard, and falls back if it is gone', async () => {
  const state = { created: true };
  const one = await boot(USER, null, dashRoutes(state), (w) => w.localStorage.setItem('nav.layout', '5'));
  assert.ok(one.seen.some((r) => r.url === 'api/apps?layout=5'));
  click(one.doc.getElementById('menu-btn'));
  assert.equal(menuItem(one.doc, 'My dashboard').getAttribute('aria-checked'), 'true');
  assert.ok(menuItem(one.doc, 'Revert to template…'));
  assert.ok(menuItem(one.doc, 'Edit layout'));

  const two = await boot(USER, (u) => /layout=5/.test(u) ? { status: 404 } : null, null,
    (w) => w.localStorage.setItem('nav.layout', '5'));
  await settle(two.window, () => two.seen.some((r) => r.url === 'api/apps'), 'retry on the default');
  assert.equal(two.window.localStorage.getItem('nav.layout'), 'null');
});

test('revert and delete act on the dashboard shown', async () => {
  const state = { created: true };
  const { window, doc, seen } = await boot(USER, null, dashRoutes(state), (w) => {
    w.localStorage.setItem('nav.layout', '5');
    w.confirm = () => true;
  });
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Revert to template…'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/5/revert' && r.method === 'POST'), 'revert');
  await settle(window, () => doc.querySelector('#menu-list button'), 'menu rebuilt');
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Delete…'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/5' && r.method === 'DELETE'), 'delete');
  await settle(window, () => window.localStorage.getItem('nav.layout') === 'null', 'back to shared');
});

// --- clock and weather renderers ------------------------------------------------

const CLOCK = (data) => ({ type: 'clock', shape: 'clock', data: {
  zones: [{ label: 'Home', tz: null }, { label: 'Tokyo', tz: 'Asia/Tokyo' }],
  style: 'digital', seconds: false, date: true, hours: '24', ...data } });

test('a digital clock shows each zone, its date and its offset', async () => {
  const { window, doc } = await boot(APPS);
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, CLOCK({}), {});
  const times = [...el.querySelectorAll('.c-time')].map((x) => x.textContent);
  assert.equal(times.length, 2);
  assert.match(times[0], /^\d{2}:\d{2}$/, '24-hour, no seconds');
  assert.deepEqual([...el.querySelectorAll('.c-label')].map((x) => x.textContent), ['Home', 'Tokyo']);
  assert.ok(el.querySelectorAll('.c-date')[0].textContent.length > 3, 'the date is shown');
  // XS: one zone, just the time.
  const xs = doc.createElement('div');
  doc.body.appendChild(xs);
  window.renderWidget(xs, CLOCK({ seconds: true }), { size: 'XS' });
  assert.equal(xs.querySelectorAll('.c-time').length, 1);
  assert.equal(xs.querySelector('.c-date'), null);
  assert.equal(xs.querySelector('.w-sub'), null, 'no room to say so: the hover view has the rest');
});

test('an analog clock turns its hands to the time', async () => {
  const { window, doc } = await boot(APPS);
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, CLOCK({ style: 'analog', seconds: true,
                                  zones: [{ label: 'UTC', tz: 'UTC' }] }), {});
  const m = el.querySelector('.c-m').getAttribute('transform');
  const now = new Date();
  const deg = Number(/rotate\(([\d.]+)\)/.exec(m)[1]);
  assert.ok(Math.abs(deg - (now.getUTCMinutes() * 6 + now.getUTCSeconds() / 10)) < 7, 'minute hand');
  assert.ok(el.querySelector('.c-s'), 'a second hand when asked for');
  assert.match(el.querySelector('svg.c-face').getAttribute('aria-label'), /^UTC /);
});

test('a big clock shows every zone; analog captions go under the face', async () => {
  const { window, doc } = await boot(APPS);
  const zones = ['A', 'B', 'C', 'D', 'E'].map((l, i) => ({ label: l, tz: i ? 'Asia/Tokyo' : null }));
  const at = (data, size, span) => {
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    window.renderWidget(el, CLOCK({ zones, ...data }), { size, span });
    return el;
  };
  const wide = at({ style: 'analog' }, 'L', [20, 5]);
  assert.equal(wide.querySelectorAll('svg.c-face').length, 5);
  assert.equal(wide.querySelector('.w-sub'), null);
  const item = wide.querySelector('.c-item');
  assert.equal(item.firstChild.tagName.toLowerCase(), 'svg', 'face first');
  assert.equal(item.querySelector('.c-cap').firstChild.className, 'c-label', 'then the label, under it');
  const dig = at({}, 'L', [8, 6]);
  assert.equal(dig.querySelectorAll('.c-time').length, 5);
  assert.ok(dig.querySelector('.c-item.c-sep'), 'zones ruled apart');
  // Too small for every zone: all of them anyway -- the widget scrolls.
  const small = at({}, 'S', [4, 2]);
  assert.equal(small.querySelectorAll('.c-time').length, 5, 'no zone dropped');
  assert.equal(small.querySelectorAll('.c-date').length, 5, 'dates kept');
  const smallFaces = at({ style: 'analog' }, 'S', [4, 2]);
  assert.equal(smallFaces.querySelectorAll('svg.c-face').length, 5);
});

const WEATHER = { type: 'weather', shape: 'weather', data: {
  place: 'Seattle, Washington', units: { temp: '°F', wind: 'mph' },
  current: { time: '2026-10-11T08:15', temp: 43.2, feels: 39, humidity: 90, wind: 4, is_day: true,
             text: 'Clear', icon: 'clear' },
  hourly: Array.from({ length: 24 }, (_, i) => ({ t: `2026-10-11T${String((8 + i) % 24).padStart(2, '0')}:00`,
    temp: 43 + i % 10, pop: i * 3, is_day: true, text: 'Rain', icon: 'rain' })),
  daily: Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${11 + i}`, hi: 56 + i, lo: 42 + (i % 3),
    pop: 10 * i, sunrise: '2026-10-11T07:22', sunset: '2026-10-11T18:28', text: 'Fog', icon: 'fog' })) } };

test('wide weather toggles hourly and a compact week, remembered per widget', async () => {
  const { window, doc } = await boot(APPS);
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, WEATHER, { size: 'W', key: 'def3' });
  const btn = (m) => el.querySelector(`.wx-toggle [data-mode=${m}]`);
  assert.equal(btn('hourly').getAttribute('aria-pressed'), 'true', 'hourly first');
  assert.equal(el.querySelector('.wx-strip .wx-h-t').textContent, 'Now');
  click(btn('daily'));
  const days = el.querySelectorAll('.wx-strip .wx-h');
  assert.equal(days.length, 7);
  assert.equal(days[1].querySelector('.wx-h-t').textContent.length > 0, true);
  assert.equal(days[1].querySelector('.wx-h-v').firstChild.textContent, '57°/43°', 'high / low');
  assert.equal(days[1].querySelector('.wx-h-p').textContent, '10%');
  assert.equal(el.querySelector('.wx-days'), null, 'not the long week list');
  assert.equal(window.localStorage.getItem('nav.wx.def3'), 'daily');
  const again = doc.createElement('div');
  doc.body.appendChild(again);
  window.renderWidget(again, WEATHER, { size: 'W', key: 'def3' });
  assert.equal(again.querySelector('.wx-toggle [data-mode=daily]').getAttribute('aria-pressed'), 'true');
});

test('W spans the whole row', async () => {
  const { window } = await boot(APPS);
  const el = window.document.createElement('li');
  assert.equal(String(window.applySpan(el, 'weather', 'W', 24)), '24,2');
  assert.equal(String(window.applySpan(el, 'weather', 'W', 8)), '8,2');
});

test('weather draws more as it grows', async () => {
  const { window, doc } = await boot(APPS);
  const at = (size) => {
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    window.renderWidget(el, WEATHER, size ? { size } : {});
    return el;
  };
  const xs = at('XS');
  assert.equal(xs.querySelector('.wx-temp').textContent, '43°');
  assert.equal(xs.querySelector('.wx-card .wx-cond').textContent, '56° / 42°', 'the range under the reading');
  assert.equal(xs.querySelector('.wx-hours'), null);
  const card = doc.createElement('div');
  window.renderWidget(card, WEATHER, { size: 'XS', span: [3, 2] });
  assert.equal(card.querySelector('.wx-cond').textContent, 'Seattle, Washington \u00b7 Clear', 'a column more: the place');
  const s = at('S');
  assert.ok(s.querySelector('.wx-narrow'), 'S: the strip alone, toggled');
  assert.equal(s.querySelector('.wx-strip .wx-h-t').textContent, 'Now', 'its first hour is now');
  assert.equal(s.querySelector('.wx-strip .wx-h-v').firstChild.textContent, '43°', 'now is the current temperature');
  assert.ok([...s.querySelectorAll('.wx-strip .wx-h')].every((h) => /%$/.test(h.querySelector('.wx-h-p').textContent)),
    'every column shows its rain chance, 0% included');
  assert.equal(s.querySelectorAll('.wx-strip .wx-h').length, 8, 'four columns fit: three hours each, a day ahead');
  assert.match(s.querySelector('.wx-narrow').title, /^Seattle, Washington: 43°/);
  const wide = doc.createElement('div');
  window.renderWidget(wide, WEATHER, { size: 'S', span: [20, 2], key: 'wide' });
  assert.equal(wide.querySelectorAll('.wx-strip .wx-h').length, 24, 'room for hourly');
  const m = at('M');
  assert.ok(m.querySelector('.wx-tall .wx-toggle'), 'M: now, then the strip, toggled');
  assert.equal(m.querySelectorAll('.wx-strip .wx-h').length, 8);
  assert.equal(m.querySelector('.wx-days'), null);
  assert.ok(window.wantsPeek('weather', 'M') && window.wantsPeek('weather', 'W'), 'the full view on hover');
  assert.ok(!window.wantsPeek('weather', 'L') && !window.wantsPeek('stat', 'M'));
  const full = at(null);
  assert.equal(full.querySelectorAll('.wx-days li').length, 7, 'the week');
  assert.equal(full.querySelector('.wx-days li .wx-d-n').textContent, 'Today');
  assert.ok(full.querySelector('svg.wx-chart path.wx-line'), 'the hours as a line');
  assert.equal(full.querySelector('.wx-h-t').textContent, 'Now');
  // The place's hours, not the viewer's: 08:00 there is "8 AM" (or "08") anywhere.
  assert.match(full.querySelectorAll('.wx-h-t')[1].textContent, /9/);
});

// --- tile health -----------------------------------------------------------------

test('a down tile fades with a red dot and says why; up shows nothing', async () => {
  const health = { hosts: {
    'sonarr.example.com': { state: 'down', detail: 'timed out', at: 1 },
    'books.example.com': { state: 'up', detail: 'HTTP 200', at: Math.floor(Date.now() / 1000) } } };
  const { window, doc, seen } = await boot(APPS, null, (u) => u.startsWith('api/health') ? health : undefined);
  await settle(window, () => doc.querySelector('a.app.health-down'), 'painted');
  const q = seen.find((r) => r.url.startsWith('api/health')).url;
  assert.match(q, /host=sonarr\.example\.com/);
  assert.match(q, /host=books\.example\.com/, 'only the page\'s own tiles\' hosts');
  const down = doc.querySelector('a.app.health-down');
  assert.equal(down.dataset.host, 'sonarr.example.com');
  assert.equal(down.querySelector('.h-dot').getAttribute('aria-label'), 'Down: timed out');
  const up = doc.querySelector('a.app[data-host="books.example.com"]');
  assert.equal(up.querySelector('.h-dot'), null, 'up: no dot');
  assert.match(up.dataset.health, /^Up \(checked \d+s ago\)$/);
});

test('the page knows its own version and nav-api\'s, separately', async () => {
  const { window } = await boot(APPS, null, (u) => u.startsWith('/static/version.json') ? { page: 'abcd1234' }
    : u.startsWith('api/version') ? { version: 'f00dfeed99', built_at: '2026-10-11T00:00:00Z' } : undefined);
  await settle(window, () => window.eval('PAGE_VERSION') === 'abcd1234', 'page version');
  assert.equal(window.eval('API_VERSION'), 'f00dfeed99');
  window.eval("versionNote('page')");
  assert.equal(window.document.getElementById('new-version').textContent, 'New page — reload');
});

// --- free layout and dashboard tabs (2026-10-25) ----------------------------------

const FREE = { id: 7, kind: 'dashboard', name: 'Free one', template_id: null, mode: 'free',
               is_default: false, group_order: [], group_hidden: [] };
function freeRoutes(apps, list) {
  return (u) => {
    if (u.startsWith('api/apps') && /layout=7/.test(u)) { return { ...USER, apps, layout: FREE }; }
    if (u === 'api/layouts') {
      return list || { ...LAYOUT_LIST, dashboards: [{ id: 5, name: 'My dashboard', mode: 'packed' },
                                                    { id: 7, name: 'Free one', mode: 'free' }] };
    }
    if (u.startsWith('api/widgets?') || u === 'api/widgets') { return { defs: SAVED.defs, placements: [], layout_id: 7 }; }
    return dashRoutes({ created: true })(u);
  };
}
const placed = (over) => USER.apps.map((a) => ({ ...a, x: null, y: null, ...(over[a.slug] || {}) }));

test('dashboards are tabs: the shared one, yours, and + for a new (free by default)', async () => {
  const { window, doc, seen } = await boot(USER, null, freeRoutes(placed({})));
  await settle(window, () => doc.querySelectorAll('#dashtabs .dtab').length === 4, 'tabs');
  const tabs = [...doc.querySelectorAll('#dashtabs .dtab')].map((b) => b.textContent);
  assert.deepEqual(tabs, ['Default', 'My dashboard', 'Free one', '+']);
  assert.equal(doc.querySelector('#dashtabs .dtab.on').textContent, 'Default');
  click([...doc.querySelectorAll('#dashtabs .dtab')].find((b) => b.textContent === 'Free one'));
  await settle(window, () => seen.some((r) => /api\/apps\?layout=7/.test(r.url)), 'switched');
  assert.equal(window.localStorage.getItem('nav.layout'), '7');
  // An empty free dashboard says so, rather than showing nothing.
  await settle(window, () => /This dashboard is empty/.test(doc.getElementById('out').textContent), 'empty');
  click(doc.getElementById('dashtab-add'));
  await settle(window, () => doc.getElementById('dash-name'), 'dialog');
  assert.ok(doc.getElementById('dash-mode-free').checked, 'free by default from +');
  doc.getElementById('dash-name').value = 'Another';
  click(doc.getElementById('dash-create'));
  await settle(window, () => seen.some((r) => r.method === 'POST' && r.url === 'api/layouts'), 'created');
  assert.deepEqual(JSON.parse(seen.find((r) => r.method === 'POST' && r.url === 'api/layouts').body),
                   { kind: 'dashboard', name: 'Another', mode: 'free' }, 'free copies nothing');
});

test('a free dashboard draws placed things at their cells, and only those', async () => {
  const { window, doc } = await boot(USER, null, freeRoutes(placed({ sonarr: { x: 4, y: 2 } })),
    (w) => w.localStorage.setItem('nav.layout', '7'));
  await settle(window, () => doc.querySelector('ul.ugrid.free'), 'free grid');
  const g = doc.querySelector('ul.ugrid.free');
  assert.equal(g.style.gridTemplateColumns, 'repeat(24, minmax(0, 1fr))');
  const keys = [...g.querySelectorAll('[data-key]')].map((li) => li.dataset.key);
  assert.deepEqual(keys, ['app:sonarr'], 'Calibre-Web has no cell: not on the page');
  const li = g.querySelector('[data-key="app:sonarr"]');
  assert.equal(li.style.gridColumn, '5 / span 4');
  assert.equal(li.style.gridRow, '3 / span 2');
});

test('arranging a free dashboard: drag an app from the panel to a cell; overlaps are refused', async () => {
  const { window, doc, seen } = await boot(USER, null, freeRoutes(placed({ sonarr: { x: 0, y: 0 } })),
    (w) => w.localStorage.setItem('nav.layout', '7'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.querySelector('#widget-lib .wl-app'), 'the panel lists unplaced apps');
  assert.deepEqual([...doc.querySelectorAll('#widget-lib .wl-app .wl-name')].map((x) => x.textContent), ['Calibre-Web']);
  const g = doc.querySelector('ul.ugrid.free');
  // jsdom has no layout: every pointer is cell 0,0 -- where Sonarr already sits.
  drag(window, doc.querySelector('#widget-lib .wl-app'), g);
  assert.equal(seen.filter((r) => r.url === 'api/layouts/7/tiles').length, 0, 'refused: the cells are taken');
  // Move Sonarr off 0,0 by hand, then the drop lands.
  window.eval("APPS.filter(function (a) { return a.slug === 'sonarr'; })[0].x = 10; render();");
  drag(window, doc.querySelector('#widget-lib .wl-app'), doc.querySelector('ul.ugrid.free'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/tiles'), 'placed');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/7/tiles').body).tiles.books,
                   { ...(USER.apps.find((a) => a.slug === 'books').override), x: 0, y: 0 });
  await settle(window, () => doc.querySelector('ul.ugrid.free [data-key="app:books"]'), 'drawn at once');
});

test('on a free dashboard the panel shows All / Apps / Widgets, apps with their icons', async () => {
  const { window, doc } = await boot(USER, null, freeRoutes(placed({ sonarr: { x: 0, y: 0 } })),
    (w) => w.localStorage.setItem('nav.layout', '7'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.querySelector('#widget-lib .wl-chip'), 'chips');
  assert.deepEqual([...doc.querySelectorAll('#widget-lib .wl-chip')].map((x) => x.textContent), ['All', 'Apps', 'Widgets']);
  assert.ok(doc.querySelector('#widget-lib .wl-app .icon'), 'an app shows its icon');
  click(doc.querySelector('#widget-lib .wl-chip[data-filter="widgets"]'));
  assert.equal(doc.querySelectorAll('#widget-lib .wl-app').length, 0);
  assert.ok(doc.querySelectorAll('#widget-lib .wl-list li').length > 0, 'widgets only');
  click(doc.querySelector('#widget-lib .wl-chip[data-filter="apps"]'));
  assert.equal(doc.getElementById('widget-new-mine'), null, 'no New widget among the apps');
  assert.equal(JSON.parse(window.localStorage.getItem('nav.widgetlib')).filter, 'apps');
});

test('on a free dashboard a tile resizes by cells, down to one cell', async () => {
  const { window, doc, seen } = await boot(USER, null, freeRoutes(placed({ sonarr: { x: 0, y: 0 } })),
    (w) => w.localStorage.setItem('nav.layout', '7'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.querySelector('ul.ugrid.free [data-key="app:sonarr"] .resize-handle'), 'handle');
  const h = () => doc.querySelector('ul.ugrid.free [data-key="app:sonarr"] .resize-handle');
  h().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/tiles'), 'saved');
  assert.equal(JSON.parse(seen.filter((r) => r.url === 'api/layouts/7/tiles').pop().body).tiles.sonarr.size, '5x2',
               'a span, not the next named size');
  assert.equal(window.minSpan('tile').join('x'), '1x1');
  assert.equal(window.minSpan('clock').join('x'), '2x1', 'a clock can be one row');
  assert.equal(window.minSpan('calendar').join('x'), '4x1', 'so can a venue strip');
});

test('a one-row venue strip is just the seven days, the name on hover', async () => {
  const { window, doc } = await boot();
  const today = window.calDay(new window.Date());
  const el = doc.createElement('div');
  doc.body.appendChild(el);
  window.renderWidget(el, { type: 'ticketmaster.venue', shape: 'calendar', data: { label: 'Barclays Center', view: 'week',
    strip: true, week_start: 0, legend: [{ label: 'Concert', series: 3 }],
    range: [window.calAdd(today, -10), window.calAdd(today, 30)],
    events: [{ date: today, title: '8 PM Show', series: 3 }] } }, { key: 'thin1', span: [8, 1] });
  assert.equal(el.querySelectorAll('.cal-sday').length, 7);
  assert.equal(el.querySelector('.cal-head'), null, 'no header');
  assert.equal(el.querySelector('.cal-skey'), null, 'no key');
  assert.match(el.title, /Barclays Center — Concert/);
});

// --- groups on a free page ------------------------------------------------------------

function freeWith(groups, apps) {
  const lay = { ...FREE, free_groups: groups };
  return (u) => {
    if (u.startsWith('api/apps') && /layout=7/.test(u)) { return { ...USER, apps, layout: lay }; }
    return freeRoutes(apps)(u);
  };
}

test('a growing group packs its members and grows; a frame is drawn behind what sits in it', async () => {
  const apps = placed({ sonarr: { category: 'fg:g1' }, books: { x: 13, y: 1 } });
  const groups = [{ id: 'g1', name: 'Media', kind: 'dynamic', x: 0, y: 0, w: 8, h: 2 },
                  { id: 'f1', name: 'Books', kind: 'static', x: 12, y: 0, w: 8, h: 4 }];
  const { window, doc } = await boot(USER, null, freeWith(groups, apps), (w) => w.localStorage.setItem('nav.layout', '7'));
  await settle(window, () => doc.querySelector('li.fgroup[data-key="g:g1"] ul.fg-body [data-key="app:sonarr"]'), 'member');
  const dyn = doc.querySelector('li.fgroup[data-key="g:g1"]');
  assert.equal(dyn.querySelector('.fg-name').textContent, 'Media');
  assert.equal(dyn.style.gridRow, '1 / span 3', 'title row + the member (M = 2 rows)');
  assert.equal(dyn.querySelector('ul.fg-body').style.gridTemplateColumns, 'repeat(8, minmax(0, 1fr))', 'its own width');
  const frame = doc.querySelector('li.fgroup[data-key="g:f1"]');
  assert.equal(frame.style.gridColumn, '13 / span 8');
  // The framed tile is a page item at its own cell, not inside the frame element.
  assert.equal(frame.querySelector('[data-key="app:books"]'), null);
  assert.equal(doc.querySelector('ul.ugrid.free > [data-key="app:books"]').style.gridColumn, '14 / span 4');
});

test('what may go where: items avoid items and growing groups; frames may hold items', async () => {
  const apps = placed({ books: { x: 13, y: 1 } });
  const groups = [{ id: 'g1', name: 'G', kind: 'dynamic', x: 0, y: 0, w: 8, h: 2 },
                  { id: 'f1', name: 'F', kind: 'static', x: 12, y: 0, w: 8, h: 4 }];
  const { window, doc } = await boot(USER, null, freeWith(groups, apps), (w) => w.localStorage.setItem('nav.layout', '7'));
  await settle(window, () => doc.querySelector('li.fgroup'), 'groups');
  const fits = (r, what, skip) => window.freeFits(r, what, skip || '');
  assert.equal(fits({ x: 2, y: 0, w: 4, h: 2 }, 'item'), false, 'not over a growing group');
  assert.equal(fits({ x: 17, y: 2, w: 2, h: 2 }, 'item'), true, 'inside a frame is fine');
  assert.equal(fits({ x: 13, y: 1, w: 4, h: 2 }, 'item'), false, 'not over another item');
  assert.equal(fits({ x: 13, y: 1, w: 4, h: 2 }, 'item', 'app:books'), true, 'except itself');
  assert.equal(fits({ x: 6, y: 0, w: 8, h: 2 }, 'static'), false, 'groups never overlap');
  assert.equal(fits({ x: 0, y: 10, w: 8, h: 2 }, 'dynamic'), true);
  assert.equal(fits({ x: 20, y: 0, w: 6, h: 2 }, 'item'), false, 'not past the last column');
});

test('arranging: drag "+ Group" onto the page; drop an app into a growing group', async () => {
  const apps = placed({ books: { x: 12, y: 0 } });      // something on the page, so it paints
  const groups = [{ id: 'g1', name: 'G', kind: 'dynamic', x: 0, y: 6, w: 8, h: 2 }];
  const { window, doc, seen } = await boot(USER, null, freeWith(groups, apps), (w) => w.localStorage.setItem('nav.layout', '7'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.getElementById('group-new'), 'the + Group button');
  // jsdom: every pointer is cell 0,0 -- free, since the group sits at row 6.
  const g = drag(window, doc.getElementById('group-new'), doc.querySelector('ul.ugrid.free'));
  // The v1.10.0 bug: the drag allowed 'copy', the page answered 'move', and
  // Chrome refused the drop. jsdom doesn't enforce that -- so assert it.
  assert.equal(g.dt.effectAllowed, 'copy');
  assert.equal(g.dt.dropEffect, 'copy', 'the drop effect must be one the drag allowed');
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/free-groups'), 'groups saved');
  const sent = JSON.parse(seen.filter((r) => r.url === 'api/layouts/7/free-groups').pop().body).groups;
  assert.equal(sent.length, 2);
  assert.deepEqual({ ...sent[1], id: 'x' }, { id: 'x', name: 'New group', kind: 'static', x: 0, y: 0, w: 8, h: 4 });
  // An app from the panel onto the growing group's own grid: it joins, in order.
  const body = doc.querySelector('li.fgroup[data-key="g:g1"] ul.fg-body');
  const app = [...doc.querySelectorAll('#widget-lib .wl-app')].find((li) => li.textContent.includes('Sonarr'));
  drag(window, app, body);
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/order'), 'order saved');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/7/order').body),
                   { category: 'fg:g1', items: [{ app: 'sonarr' }] });
  await settle(window, () => doc.querySelector('li.fgroup[data-key="g:g1"] [data-key="app:sonarr"]'), 'drawn inside');
  assert.ok(![...doc.querySelectorAll('#widget-lib .wl-app')].some((li) => li.textContent.includes('Sonarr')),
            'no longer offered in the panel');
});

// --- backgrounds --------------------------------------------------------------------

test('page background: the bar\'s 🎨 picks a theme colour, saved on the layout and painted', async () => {
  const { window, doc, seen } = await boot(USER, null, freeRoutes(placed({ sonarr: { x: 0, y: 0 } })),
    (w) => w.localStorage.setItem('nav.layout', '7'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.body.classList.contains('edit-mode'), 'edit mode');
  click(doc.getElementById('edit-bg-btn'));
  const sw = doc.querySelector('#bg-picker .bg-sw[data-c="green"]');
  assert.ok(sw, 'the picker offers the theme colours');
  click(sw);
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/style'), 'saved');
  assert.deepEqual(JSON.parse(seen.find((r) => r.url === 'api/layouts/7/style').body), { bg: { c: 'green' } });
  assert.match(doc.body.style.background, /series-3/, 'mixed from the palette, so it follows the theme');
  click(doc.querySelector('#bg-picker .bg-sw[data-c=""]'));
  await settle(window, () => JSON.parse(seen.filter((r) => r.url === 'api/layouts/7/style').pop().body).bg === null, 'cleared');
});

test('a tile is drawn in its colour; editing a tile on a free page keeps its place and colour', async () => {
  const { window, doc, seen } = await boot(USER, null,
    freeRoutes(placed({ sonarr: { x: 3, y: 1, colour: 'violet', override: { x: 3, y: 1, colour: 'violet' } } })),
    (w) => w.localStorage.setItem('nav.layout', '7'));
  await settle(window, () => doc.querySelector('[data-key="app:sonarr"] a.app'), 'tile');
  assert.match(doc.querySelector('[data-key="app:sonarr"] a.app').style.background, /series-7/);
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  // Edit mode's own redraw (after its fetches) replaces the tiles: click the
  // one drawn for editing, once the panel says that redraw is done.
  await settle(window, () => doc.body.classList.contains('edit-mode') &&
                             doc.querySelector('#widget-lib .wl-chip') &&
                             doc.querySelector('ul.ugrid.free [data-key="app:sonarr"] .resize-handle'), 'edit');
  click(doc.querySelector('ul.ugrid.free [data-key="app:sonarr"] a.app'));
  await settle(window, () => doc.getElementById('editor-colour'), 'editor');
  assert.equal(doc.getElementById('editor-colour').textContent, 'violet');
  doc.getElementById('editor-save').click();
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/tiles'), 'saved');
  const f = JSON.parse(seen.filter((r) => r.url === 'api/layouts/7/tiles').pop().body).tiles.sonarr;
  assert.equal(f.x, 3); assert.equal(f.y, 1, 'still on the page');
  assert.equal(f.colour, 'violet');
});

test('a group takes a background from its title\'s 🎨', async () => {
  const apps = placed({ books: { x: 12, y: 0 } });
  const groups = [{ id: 'g1', name: 'G', kind: 'static', x: 0, y: 4, w: 8, h: 3 }];
  const { window, doc, seen } = await boot(USER, null, freeWith(groups, apps), (w) => w.localStorage.setItem('nav.layout', '7'));
  click(doc.getElementById('menu-btn'));
  click(menuItem(doc, 'Edit layout'));
  await settle(window, () => doc.querySelector('li.fgroup .fg-btn[title="Background"]'), 'button');
  click(doc.querySelector('li.fgroup .fg-btn[title="Background"]'));
  click(doc.querySelector('#bg-picker .bg-sw[data-c="amber"]'));
  await settle(window, () => seen.some((r) => r.url === 'api/layouts/7/free-groups'), 'saved');
  assert.deepEqual(JSON.parse(seen.filter((r) => r.url === 'api/layouts/7/free-groups').pop().body).groups[0].bg, { c: 'amber' });
  assert.match(doc.querySelector('li.fgroup').style.background, /series-4/);
});
