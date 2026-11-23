# nav

A per-user home page for a self-hosted lab: one tile for every app **you**
may open, and widgets that show what those apps know (what's downloading,
what's on the calendar, whose turn it is to walk the dog).

The tile list is not curated by hand. It's a renderer over Authentik's
applications API, which already returns only the applications the calling
user may access: grant access in Authentik and the tile appears on the next
load. nav sits behind [Pomerium](https://www.pomerium.com/), which signs
people in and tells nav who is asking.

- **Tiles** from Authentik, per user; admins can rename, re-icon, regroup and
  hide them, and add custom tiles for things Authentik doesn't front.
- **Layouts**: admin templates, and personal dashboards copied from them.
- **Widgets**: a provider fetches from an app and returns one of a few
  shapes (stat, list, calendar, …) that the page knows how to draw. Built in:
  Sonarr/Radarr/Overseerr, qBittorrent/SABnzbd, Prometheus queries, Mealie,
  weather and clocks, Choreboard (interactive), and a `remote` widget for any
  HTTP service that speaks a shape. The contract is [docs/widgets.md](docs/widgets.md).
- **Health**: a red dot on a tile whose app isn't answering.
- **Impersonation** ("view as") for staff, to see someone else's tiles.
- **Access** (Manage → Access…): people × groups, with the apps each person
  reaches. For labs that keep Authentik group membership in Terraform, a click
  stages a change and **Open PR** turns the staged changes into one pull request
  on the GitOps repo; nothing changes until it is merged and applied.
  **+ Add person** creates the Authentik user straight away (users live in
  Authentik, not Terraform), sets how they sign in (Google by email, a
  set-password link, or a starting password shown once), and stages their
  groups -- plus, for an address outside the household domain, the edge's
  email allow-list -- for the same pull request.

## Layout

```
api/     FastAPI + Postgres (psycopg); providers, layouts, health probes
ui/      the page: index.html + static/ (plain scripts, no build step)
tests/   the page in jsdom, clicked through (node --test)
docs/    the widget shapes
```

One image serves both the API (`/api/...`) and the page, so they always
match.

## Run the tests

```sh
python3 -m unittest discover -s api -p 'test_*.py'     # standard library only
cd tests && npm ci && npm test                          # the page
```

## Configuration

nav reads its identity from headers Pomerium adds; **never expose it except
through Pomerium** — anyone who can reach it directly can name any user.

| Variable | |
|---|---|
| `NAV_DSN` | Postgres connection string (required) |
| `AUTHENTIK_URL`, `AUTHENTIK_TOKEN` | Authentik, and an admin API token to list each user's applications |
| `NAV_IDENTITY_HEADER` | header carrying the user's email (default `x-authentik-email`) |
| `NAV_GROUPS_HEADER` | header carrying their groups (default `x-authentik-groups`) |
| `NAV_REQUIRE_IDENTITY` | refuse requests without the identity header (default `true`) |
| `NAV_ADMIN_GROUP` | group(s) whose members administer nav, comma-separated -- any one is enough (default `nav-admins`) |
| `NAV_ADMINS` | comma-separated emails that are admins regardless (break-glass) |
| `NAV_IMPERSONATE_GROUP` | group allowed to "view as" (default `staff`) |
| `NAV_ACCESS_GROUP` | group(s) allowed to use Access (default: the admin groups) |
| `NAV_GITOPS_REPO`, `NAV_GITOPS_TOKEN` | `owner/name` of the repo holding the Authentik Terraform, and a token that may push branches and open PRs there (both unset: Access is off) |
| `NAV_GITOPS_BASE`, `NAV_GITOPS_TF_DIR` | the branch to read and target (default `main`), and the `.tf` directory (default `terraform/authentik`) |
| `NAV_GITOPS_CF_FILE`, `NAV_GITOPS_CF_POLICY` | the `.tf` file and resource name of the edge's email allow-list (a Cloudflare Access policy with `email = { email = "…" }` include entries). Add person stages a new outside address there in the same PR. Unset: the panel says to add it by hand |
| `NAV_HOME_EMAIL_DOMAIN` | the household's own email domain. Add person treats any other address as outside (unset: no outside-access step) |
| `NAV_NEW_PERSON_GROUPS` | groups Add person pre-selects (default `family`; only Terraform-managed ones are offered) |
| `NAV_AUTHENTIK_PUBLIC_URL` | Authentik's public address. A set-password link is built from the in-cluster host nav calls, so it is re-rooted here |
| `NAV_APP_DOMAIN` | apps' public links default to `https://<slug>.<this>` |
| `NAV_<APP>_URL`, `_KEY`, `_PUBLIC` | per-app upstream URL, API key and public link (or set them in the UI) |
| `NAV_SECRET_KEY` | encrypts API keys stored from the UI |
| `NAV_TZ` | the household's time zone, for calendars and clocks |
| `NAV_ICONS_DIR` | app icons served at `/icons/` (default `/app/icons`) |

## Releases

Push a `vX.Y.Z` tag; CI builds `ghcr.io/beartums/nav:vX.Y.Z` (amd64 + arm64).
Every push to `main` also builds `sha-<commit>`.
