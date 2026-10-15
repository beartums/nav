# nav UI tests

```
cd tests && npm install && npm test
```

Loads `ui/index.html` in jsdom (its `static/` CSS and scripts inlined in tag order) with `fetch` stubbed, and clicks things.

That file *is* the page: the image serves `ui/` as it is, so testing the
source is testing what ships.

## Why it exists

Every nav bug on 2026-09-28/29 passed a check that said *"the JavaScript
parses"*. All of them were legal JavaScript:

| bug | what parsing said | what it did |
|---|---|---|
| `appendChild` reparents, so the following `removeChild` threw | fine | every tile click died; the edit dialog stopped opening |
| two `function load()` in one scope | fine | `var opts = load()` got a Promise; every view option read `undefined` |
| admin branch returned before appending icon and label | fine | admin tiles were empty boxes |
| unscoped `ul { display:grid }` also matched the menu | fine | author `display` beats `[hidden]`; the menu could not close |
| tile rejected `data:` icons | fine | uploads saved correctly and never appeared |
| `reorder()` renumbered `APPS` (API order) while the grid showed `sorted()` | fine | dropping one tile rewrote the position of every other tile in the group |

A syntax check cannot find any of those. Rendering the page and using it finds
all of them.

## What it does not cover

**Starting a drag.** jsdom implements neither `DragEvent` nor `DataTransfer`,
so nothing here proves Chrome will actually begin a drag or paint a drop
indicator. The reorder test synthesises both and fires the sequence by hand,
which covers the part that kept breaking — that the drop target cancels
`dragenter` and `dragover`, that `dropEffect` matches `effectAllowed`, and
that the resulting `PUT` renumbers the whole category. Moving a tile *between*
groups is still hand-tested.

### Search

Filters what is already loaded — everything the page can show is in `APPS`, so
no round trip. Every term must match, in any order, across name, description,
group and slug. Covered: the multi-term case, the no-match message (an empty
page with a filter still applied is what gets reported as "my tiles are gone"),
Escape clearing rather than blurring, and `/` focusing from the page but not
from inside a field.

### Custom tiles

A custom tile is a bookmark, not a grant — see the comment on `custom_tiles` in
`schema.sql`. It exists because a seeding script that derives links hardcodes
`https://<host>.<domain>` and so cannot express AdGuard on bare metal,
Pomerium's `/.pomerium`, or anything off-network.

The audience picker (`Offered to`) multi-selects groups and users from
`/api/admin/principals`. Stored prefixed — `group:<name>` / `user:<email>` —
because a bare name cannot say which it is. A bare entry is read as a group,
which is what the column held before users could be picked, so old rows need
no migration; there is a test that editing such a tile still shows it ticked,
since showing nobody selected and saving would silently widen it to everyone.
Several selections are OR. A directory that will not load degrades to "everyone
who can open nav" rather than blocking the dialog.

Create, delete and edit-link write immediately rather than staging. Staging
them would mean Cancel had to un-create things, and a half-staged tile has no
real slug for the table to render. The fields *on* a custom tile stage
normally, through the same `admin_overrides` table as an Authentik app, so the
merge has one implementation.

`valid_slug` and `offered_to` live in `api/urls.py`, which is
dependency-free so `test_urls.py` runs under stdlib `unittest` with no pip
install (wired into `.github/workflows/nav-api.yml`).

### Icon controls

One preview, one Choose button and one drop target **per mode**, everywhere.
`iconRow()` lives at module scope for that reason — the site dialog had its
own hand-rolled version with a single drop zone captioned "applies to the icon
field you last clicked in", which is the arrangement the tile editor had
already abandoned: the target was focus, which is invisible, so pasting a
light icon while the dark field held focus quietly replaced the wrong one.

The site dialog had no coverage at all before this. It now has three tests:
two independent controls, the rows not affecting each other's value or
preview, and Save writing `icon` and `icon_light` to their own keys.

### Impersonation ("View as")

Renders the tiles another person or group would see. Gated on its own group
(`NAV_IMPERSONATE_GROUP`, default `staff`) rather than on admin, because it is
a different power: an admin edits the dashboard, an impersonator reads other
people's access.

The tests cover the properties that make it safe rather than the happy path:

- the menu entry appears only when the server says `may_impersonate`
- the subject goes to the SERVER (`?as_user=` / `?as_group=`); the browser
  never filters a full list locally, which would hand every caller everyone's
  access in a response they could just read
- the page reads `impersonating` from the RESPONSE and never trusts the local
  guess that sent the request — otherwise a declined impersonation leaves a
  real dashboard labelled as somebody else's
- entering admin mode ends it; writes go out as the real caller
- the banner states that it grants nothing, and that profiles and click counts
  are not read

**The group case is computed, not sampled.** Authentik answers `for_user` and
has no `for_group`. The first version showed one real member's view, which
answers a different question: real people belong to several groups at once, so
"view as family" rendered everything evan could reach — the opposite of the
check.

`group_can_see()` in `urls.py` evaluates the bindings instead: a user in that
group **and no other**. That is only safe because this estate's application
bindings are plain group and user bindings. `access.tf` claims it ("groups are
the whole mechanism, no expression policies") and a live audit confirmed it —
39 group bindings, 1 user binding, zero policy bindings, zero negations, every
application on `policy_engine_mode: any`.

🔴 **That assumption has an expiry date.** The moment an expression policy is
bound to an application, evaluating it here would mean reimplementing
Authentik's policy engine. So anything the rule cannot read exactly returns
`None`, the API reports those slugs as `undetermined`, and the banner names
them — neither shown nor ruled out. Tests cover each branch, including that a
user binding never grants (mom's direct audiobookshelf binding must not appear
under "view as family") and that `policy_engine_mode: all` is AND, not OR.

### Tabbed grouping

A third Grouping mode: one category per tab, with swipe. The active tab is per
device (like `collapsed`) — a phone and a desktop legitimately sit on different
tabs. Swipe needs 40px of horizontal travel *and* to be mostly horizontal, so a
diagonal scroll down the page does not jump tabs under your thumb; vertical
scrolling stays native via `touch-action: pan-y`.

🔴 **The swipe listeners are attached once, at module scope, never inside
`renderTabs()`.** They were wired per render at first, and `showTab()`
re-renders — so each swipe left another listener behind: one tab, then two,
then four, with every stale closure holding the `cats` of the render that
created it. It presented as "swiping left gave me the second tab, then the
fourth, then only the fourth and the first". `out` survives every render, so
one listener is correct and stays correct, and it reads `opts.group` and the
tab list at fire time rather than capturing them.

The test that catches it uses **four** groups and swipes repeatedly — with
three, the clamp at the last tab hides the doubling, which is why the original
swipe test passed against the bug. Tabs with no search matches
are dropped, because a tab you can swipe into and find empty is a dead end.

### The View-as list

Its own admin screen, not a column in the bulk table: it lists people and
groups, and the bulk table lists tiles. Bolting one onto the other makes a
table that is two tables.

"Offer everything" writes `null` rather than enumerating what exists today —
the two differ the moment a group is added to Authentik later. The screen shows
`all_groups`/`all_users` (everything) while the picker shows the curated
subset, because the screen that edits a filter has to show what the filter is
hiding.

### The group box

A combobox, not free text and not a `<select>`: almost every tile joins a group
that already exists, and occasionally one needs a new one. Free text produced
"Infrastucture" sitting beside "Infrastructure" with nothing to flag it — a
category is matched by exact string, so a typo silently makes a second group.

Typing filters the existing groups (substring, not prefix). The create row is
disabled when the typed name already exists, compared case-insensitively,
because "Media" and "media" would render as two headings and nobody means
that. The same widget serves the tile dialog and the per-tile editor; it
returns field()'s `{ label, input }` shape so the editor's save path is
unchanged.

Options commit on `mousedown`, not `click` — the input's `blur` would
otherwise close the list before the value was taken. And `choose()` suppresses
one reentry into its own `input` handler: without it, picking an option closed
the list and the dispatched event immediately reopened it.

### Bulk edit

Icons are edited here too, as two swatches per app — a dark plate with a light
edge and a white plate with a dark edge — so an icon that only reads on one
background shows up in the table rather than after it ships. The light swatch
falls back to the dark icon exactly as the page does at render time. Clicking
one opens a picker (URL, file, drag, paste) whose Apply only *stages*.

Rows carry a drag handle. The handle is the draggable element, not the row —
a draggable `<tr>` makes every cell in it a drag source, so selecting text in
Name starts a drag instead. Dropping on a row inserts above it; dropping on a
group heading appends to that group, which is also the only way into a group
that is currently empty. A drop stages like every other edit.

Group headings carry a grip too, and reorder the same way. That writes
`site/group_order` — the same key the rail's group list writes, so the two are
different editors for one ordering, not two orderings. Dropping a heading on a
heading inserts *before* it, which leaves no way to reach the last slot; so a
heading may also be dropped onto an app row, which puts it after that row's
group. Only the heading actually dragged is marked, not every heading whose
index shifted beneath it.

Groups collapse from the heading, using the same per-device state as the
dashboard. A collapsed heading shows a count and stays a drop target, so it is
somewhere to drop into rather than a dead end.

The sidebar keeps working during bulk edit, and stages rather than writes —
outside bulk edit the same handlers write immediately. Bulk drags therefore
announce themselves through the shared `DRAG`, not a local one, or the rail
would simply ignore a row dragged out of the table. While the table is open the
rail reads the staged group order, otherwise the two show different orders for
the thing just dragged.

Saving a group move is a second write: `/api/admin/overrides` is transactional,
`site/group_order` cannot join that transaction. A failure between the two is
possible and the message says which half landed rather than claiming nothing
was written.

There is no Group column: membership is which section the row sits in, and a
text field that has to agree with the row's position is a second source of
truth. The grip stands in for `category` in the change marks, since otherwise
a staged move would light nothing up.

Changes are marked per field, not just per row: a dirty row with no indication
of which of its seven controls moved is not much of an indication. Dirty is
recomputed against the entry snapshot rather than latched, so typing a value
and putting it back leaves nothing staged — a one-way flag would keep the app
in the Save payload and rewrite it for no reason.

The staging semantics are covered directly, because they are the part that is
easy to get subtly wrong: editing a cell must not write, Save must send one
`PUT` containing only the touched slugs, Cancel must write nothing and restore
the snapshot, and clearing a field must delete the override rather than store
the seeded value back (which would pin the app to today's Authentik name and
stop it tracking upstream renames).

One harness note worth keeping: the `fetch` stub returns a deep copy per call.
It used to hand back the same object graph every time, and since staging edits
the app objects in place for live preview, a re-read after Cancel returned the
values Cancel had just discarded — which reads exactly like a broken Cancel and
is not.

This gap used to read "drag and drop is not exercised", and it cost three
rounds of reports. The bug in the end was not in the drag at all: admin mode
inherited the viewer's `sort`, so a drop wrote the right `order` and the next
render sorted by name and put the tile straight back. Everything worked except
the thing you could see. Admin mode now pins the sort to position, and the
test asserts the starting order is positional — so that specific illusion
cannot come back quietly.

**Layout.** jsdom does not lay out or paint, so "the checkboxes are misaligned"
and "the submenu opens in the wrong place" are invisible to it. Both were real
bugs; neither would be caught here.

**The backend.** `fetch` is stubbed. This tests the page against a contract, not
against nav-api.
