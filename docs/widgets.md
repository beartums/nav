# nav widgets: building a remote widget

A **remote widget** is any HTTP service that returns JSON in one of nav's
**shapes**. nav-api fetches it on a schedule, checks the reply against the
shape, and the page draws it. You don't change nav's code or redeploy it, and
the service can be in any language and run anywhere nav-api can reach.

Built-in widgets (clock, weather, the *arr calendar, Seerr, Mealie, Donetick, OpenChore, Choreboard, PromQL)
are the same thing with the fetch written in Python inside nav-api
(`api/providers.py`). The shapes below are the contract for both.

## Setting one up (admin)

1. **Optional: a Connection for its key.** In admin mode, open the sidebar's **Manage ▾** → **Connections…** →
   *Add a connection for a remote widget*. Fill in:
   - a name (e.g. `printer`)
   - a base URL (e.g. `https://ink.lan/api`)
   - how the key is sent: `bearer` → `Authorization: Bearer <key>`,
     `x-api-key` → `X-Api-Key: <key>`, or `header:<Name>` → `<Name>: <key>`
   - the key itself

   The key is encrypted in nav's database and is never shown again.
2. **The widget.** In the sidebar, **+ New widget…** → type **Remote widget**:

| Field | Meaning |
|---|---|
| URL | What nav-api GETs. Must be http(s). Credentials don't go in the URL; put them in a Connection. |
| Drawn as | The shape: `stat`, `timeseries`, `list`, `status`, `clock`, `weather` or `calendar`. |
| App | Who sees it: people who can open this Authentik application (its slug), or `*` for everyone signed in. |
| Connection | Optional. Its key is sent **only if the URL is under that connection's base URL**. |
| Refresh every | Seconds between fetches, 15–3600 (default 300). |
| Ask per viewer | Off: one fetch serves every viewer. On: nav sends `X-Nav-User` and caches each person's reply separately. |

Press **Preview** to see the reply drawn, or the error. As with any library
widget, **Also show to** adds Authentik groups who see it without the app.

Only nav administrators can create, preview or edit remote widgets. nav-api
makes the request from inside the network, so whoever picks the URL can make
it call any internal address.

## The request nav makes

```
GET <url>
Accept: application/json
User-Agent: nav-api/<7-char version>
X-Nav-Shape: <the shape it will be drawn as>
X-Nav-User: <viewer's email>          only with "Ask per viewer"
<auth header>                          only with a matching Connection
```

- **Timeout:** 10 s. **Size limit:** 1 MB. **Redirects are not followed:** a
  3xx is an error, so give the final URL.
- **Caching:** the reply is reused for *Refresh every* seconds. Every viewer
  shares it unless *Ask per viewer* is on, and identical requests in flight are
  merged into one. An error is cached for 15 s, so a down service isn't hammered.
- **Who triggers it:** a fetch happens when a page that shows the widget asks
  for its data and the cached reply has expired. Pages refresh widgets on their
  own; no fetch happens when nobody is looking.
- **Identity:** without *Ask per viewer*, nav doesn't tell you who is
  looking, and your reply must not depend on it.

## The reply

A **JSON object**, HTTP 2xx, in the chosen shape.

**Errors.** Any JSON object with a string `"error"`, at any status, draws as
an error tile showing that text: `{"error": "cartridge missing"}`. Use it for
"I'm up but can't answer". A non-2xx without that field shows `HTTP <status>`.
A reply that is missing a field the shape requires shows "broke the
\<shape\> contract: …".

**Text is never HTML.** Every string is drawn as text, so `<b>` shows as
`<b>`. In lists, only `http://` and `https://` URLs become links.

Times are **seconds since the epoch** (numbers) unless a field says ISO.

---

## Shapes

Sizes are grid cells (columns × rows; a cell is about 53 × 33 px). A widget can
take any size from 2×2 to 48×32. It draws the largest named size that fits and
lays out into the rest. Named sizes are listed per shape.

### `stat`: one number

| Field | Type | |
|---|---|---|
| `value` | number \| null | **Required.** `null` shows "—". |
| `label` | string | Headline above it. |
| `sub` | string | Small line under it. |
| `unit` | string | After the value, e.g. `"%"`, `"/s"`. |
| `format` | `"number"` \| `"percent"` \| `"bytes"` \| `"seconds"` | Default number (auto-compact: 12.9K). `percent` expects 0–100. `bytes` → KiB/MiB…, `seconds` → s/m/h/d. |
| `decimals` | integer | Default 1. |
| `level` | `"ok"` \| `"warn"` \| `"crit"` | A status dot plus the word, never colour alone. |
| `spark` | `[[t, v], …]` | Optional trend line. `v` may be null for a gap. |

```json
{"value": 42, "label": "Ink", "unit": "%", "format": "number", "decimals": 0,
 "level": "warn", "sub": "cyan lowest", "spark": [[1760000000, 60], [1760003600, 42]]}
```

Sizes: XS 2×2 (number only; hover shows the rest), S 4×2, M 4×4, L 6×4.

### `timeseries`: lines over time

| Field | Type | |
|---|---|---|
| `series` | `[{name, points: [[t, v], …], unit?}]` | **Required.** At most 8 are drawn. `unit` per line names it in the tooltip. |
| `label` | string | Headline. |
| `range` | `[t0, t1]` | x-axis span. Default: the data's own. |
| `format`, `decimals`, `unit` | as `stat` | Axis and tooltip formatting. |
| `warn`, `crit` | number | Drawn as reference lines. |
| `level` | `"ok"` \| `"warn"` \| `"crit"` | The status compact sizes show as a dot. |
| `truncated` | integer | How many series weren't drawn; shown as a note. |

```json
{"label": "Queue depth", "range": [1760000000, 1760086400], "warn": 50,
 "series": [{"name": "jobs", "points": [[1760000000, 3], [1760043200, 61], [1760086400, 12]]}]}
```

Sizes: XS 4×2 (sparkline), S 4×4, M 8×6, L 12×6, XL 12×8. Two or more series
get a legend; there's a table view toggle.

### `list`: rows

| Field | Type | |
|---|---|---|
| `items` | array | **Required.** Strings, or objects as below. |
| `label` | string | Headline. |
| `note` | string | Beside the headline, e.g. `"3 pending"`. |
| `empty` | string | Shown when `items` is empty. Default "Nothing to show." |

Item object:

| Field | Type | |
|---|---|---|
| `label` | string | The row's text. |
| `sub` | string | A smaller line under it (up to two lines). |
| `value` | string \| number | Right-aligned, muted. |
| `badge` | `{text, level}` | Right-aligned state word with a dot. `level`: `good` \| `warn` \| `crit` \| anything else (grey). Replaces `value`. |
| `url` | string | Makes the row a link (http/https only). |
| `section` | string | Starts a heading whenever it changes from the previous item's. |

```json
{"label": "Requests", "note": "1 pending", "items": [
  {"label": "Dune (2021)", "sub": "Film · Mom · 2d ago",
   "badge": {"text": "Pending", "level": "warn"}, "url": "https://seerr.example/movie/438631"},
  {"label": "Soup", "section": "Tomorrow", "value": "Dinner"}]}
```

Sizes: S 4×2 (hover shows all), M 4×4, L 4×6. Overflow scrolls.

### `status`: up or down

| Field | Type | |
|---|---|---|
| `state` | `"up"` \| `"down"` \| `"degraded"` \| `"unknown"` | **Required.** |
| `label` | string | |
| `sub` | string | |

```json
{"state": "degraded", "label": "Backups", "sub": "last success 31 h ago"}
```

Sizes: XS 2×2 (dot; the word is its tooltip), S 4×2.

### `calendar`: things on days

| Field | Type | |
|---|---|---|
| `events` | array | **Required.** |
| `label` | string | Headline. |
| `view` | `"week"` \| `"month"` \| `"agenda"` | Which view it opens on. Each viewer can switch it. |
| `warnings` | string[] | Shown in one line under the calendar, e.g. one source of several failing. |
| `range` | `["YYYY-MM-DD", "YYYY-MM-DD"]` | The days your events cover. ‹ and › step a week or month only while the view stays inside it. Without it, the page assumes 37 days back to 44 ahead. |
| `legend` | `[{label, series}]` | Your own legend, replacing the kinds one. E.g. one entry per person. |
| `strip` | boolean | Draw a one-week strip instead (small widgets): seven days, a mark on each day with something on, hover for the day's events. |
| `week_start` | 0–6 | The first day of the week for week, month and strip views (0 Sunday … 6 Saturday). Default Sunday. |

Event:

| Field | Type | |
|---|---|---|
| `title` | string | |
| `sub` | string | Second line where there's room, and in the tooltip. |
| `at` | ISO 8601 instant | Placed on the **viewer's** local day, with a time in the tooltip. |
| `date` | `"YYYY-MM-DD"` | A calendar day, **never shifted** by time zone. Give `at` or `date`. |
| `kind` | `"tv"` \| `"movie"` \| `"music"` | Colour and legend (TV, Films, Music). Others are drawn in a fourth colour with no legend entry. |
| `done` | boolean | Faded with ✓. |
| `series` | 1–8 | A palette colour, overriding `kind`'s. Match it to a `legend` entry. |
| `initial` | string | One or two letters. When a cell is too small for titles, each event shows as this, in its colour, instead of a dot per kind: "who has something that day". More than five become "+N"; the day's popover lists all. |
| `struck` | boolean | Drawn struck through (skipped, missed). |

The week view shows the week containing today (from `week_start`), the month
view the current month, the agenda the next 30 days; each steps from there. To allow a month either way, send about 70 days back and
ahead, and say so in `range`. Narrow sizes draw an agenda and open the full
calendar on hover.

```json
{"label": "Bins", "view": "week", "events": [
  {"date": "2026-10-14", "title": "Recycling", "kind": "tv"},
  {"at": "2026-10-15T18:00:00Z", "title": "Garden waste", "sub": "kerbside by 7am", "done": false}]}
```

Sizes: M 4×4, L 8×4, XL 12×8, W full-width × 4, or any custom span. A view
never changes by itself with size: where names don't fit, days show initials
or coloured dots, and hovering a day lists its events. Agenda is the viewer's
choice.

### `week`: one compact week of several things

What the built-in **This week** widget (`combined.week`) draws: it reads other
saved widgets by name -- a weather widget, event widgets shown as an icon,
calendar widgets shown as rows -- with each viewer's own permissions and each
widget's own settings and cache.

| Field | Type | |
|---|---|---|
| `rows` | `[{label, events, day_url?}]` | **Required.** A line per source: initials where events have `initial`, else coloured dots. `day_url` + a date links the day's popover section out. |
| `weather` | `{"YYYY-MM-DD": {icon, hi, lo, text, pop}}` | Icon and high/low per day. |
| `units` | `{temp}` | E.g. `"°F"`, in the popover. |
| `marks` | `[{label, icon, events}]` | An icon on days with something (e.g. 🏟 for a venue). |
| `week_start`, `range`, `label`, `warnings` | | As for `calendar`. |

Events are `calendar` events. Hover, focus or tap a day for everything on it.

**Interactive calendars** (built-in providers only, for now -- e.g.
`choreboard.calendar`). With `"actions": true` in the payload, an event with a
`key` is a button that opens a sheet of what the viewer may do:

| Payload field | |
|---|---|
| `actions` | boolean -- chips are interactive |
| `unread` / `inbox_url` | a 🔔 count in the header, linking to the app's inbox |
| `people` | `[{id, name}]` for "who did it" / "give to" pickers |

| Event field | |
|---|---|
| `key` | the app's id for it, sent back with each action |
| `can` | the actions THIS viewer may take (the app decides) |
| `cannot` | `{action: "why not"}` for the common ones, shown in the sheet |
| `pending` | `{id, from, to, side, reason}`: a tentative swap -- drawn dashed |

The page sends `POST api/widgets/{definition id}/action` with
`{"action": ..., "params": {...}}`; nav-api checks the viewer may see the
widget, calls the provider's `act()`, which does it **as the viewer**, and
clears the widget's cache. A refusal from the app comes back as the error
and is shown in the sheet.

### `clock`

| Field | Type | |
|---|---|---|
| `zones` | `[{label, tz}]` | **Required.** `tz` is an IANA zone (`"Europe/London"`) or `null` for the viewer's own time. |
| `style` | `"digital"` \| `"analog"` | |
| `seconds`, `date` | boolean | |
| `hours` | `"auto"` \| `"12"` \| `"24"` | |

The browser does the ticking, so a remote clock only needs to send its zones.

### `weather`

| Field | Type | |
|---|---|---|
| `current` | object | **Required.** `{time, temp, feels, humidity, wind, is_day, text, icon}` |
| `place` | string | |
| `units` | `{temp, wind}` | Labels, e.g. `{"temp": "°C", "wind": "km/h"}`. |
| `hourly` | `[{t, temp, pop, is_day, text, icon}]` | From the current hour. `t` is local ISO without an offset. |
| `daily` | `[{date, hi, lo, pop, sunrise, sunset, text, icon}]` | |

`icon` is one of `clear`, `partly`, `cloud`, `fog`, `drizzle`, `rain`,
`snow`, `storm`. `pop` is precipitation chance, 0–100.

---

## A minimal service

Python, standard library only:

```python
# ink.py -- serves a `stat` for nav at http://<host>:8099/
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("X-Token") != "s3cret":   # matches the Connection's key
            body, code = {"error": "unauthorised"}, 401
        else:
            level = "ok"   # read your real value here
            body, code = {"value": 42, "label": "Ink", "unit": "%", "decimals": 0,
                          "level": level}, 200
        out = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

HTTPServer(("", 8099), H).serve_forever()
```

Then add a Connection `printer`: base URL `http://<host>:8099`, sent as
`header:X-Token`, key `s3cret`. Then add a Remote widget: URL
`http://<host>:8099/`, drawn as `stat`, app `*`, connection `printer`.

## Checklist

- [ ] The reply is a JSON object with the shape's required field.
- [ ] Failures return `{"error": "…"}` rather than HTML.
- [ ] It answers within 10 s and in under 1 MB.
- [ ] No redirects: the URL configured is the final one.
- [ ] The reply doesn't depend on who's looking, or *Ask per viewer* is on.
- [ ] Calendar dates that are days use `date`, not midnight-UTC `at`.
