"""nav's backend: per-user tile presentation, on top of Authentik's access answer.

WHAT THIS IS AND IS NOT
  It is NOT an authorization component. Which applications a user may reach is
  decided by Authentik's policy bindings and enforced by Pomerium. This service
  asks Authentik "what can this person reach" and then decorates the answer with
  the user's own layout, ordering and overrides.

  If this service loses its database, nav still renders the correct tiles. That
  property is deliberate and worth keeping: preferences degrade, access does not.

IDENTITY COMES FROM POMERIUM, NOT FROM A TOKEN HERE
  nav is a gated route, so every request has already been authenticated. Pomerium
  supplies the user in a header (Pomerium's jwt_claims_headers, named by
  NAV_IDENTITY_HEADER). There is no OIDC, no JWKS and no token validation in this
  service -- which is the entire reason nav was moved behind Pomerium rather
  than keeping its browser-side PKCE flow.

  🔴 THAT MAKES THE HEADER LOAD-BEARING. Reaching this service without passing
  through Pomerium would let a caller name any user. It is only ever exposed via
  the Ingress, and REQUIRE_IDENTITY (default on) refuses to start serving
  identity-bearing routes if the header is absent, rather than falling back to
  anonymous.

THE ADMIN TOKEN
  Per-user filtering needs either the user's own token or an admin token plus
  ?for_user=<id>. Dropping browser PKCE means the latter. This service therefore
  holds a credential that can read every application and user in Authentik --
  more power than nav has ever had -- and its blast radius is bounded by
  Pomerium gating the only route to it.

  NEVER pass superuser_full_list=true: it disables the per-user filtering that is
  the entire point (learned the hard way, 2026-09-25).
"""
from __future__ import annotations

import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Any

import httpx
import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from urls import group_can_see, launchable, offered_to, pick_account, valid_slug
import creds
import health
import layouts
from layouts import OVERRIDABLE, merge
import widgets
import providers  # noqa: F401 -- importing registers every provider

AUTHENTIK_URL = os.environ.get(
    "AUTHENTIK_URL", "http://authentik-server.authentik.svc.cluster.local"
).rstrip("/")
AUTHENTIK_TOKEN = os.environ.get("AUTHENTIK_TOKEN", "")
DSN = os.environ["NAV_DSN"]
IDENTITY_HEADER = os.environ.get("NAV_IDENTITY_HEADER", "x-authentik-email")
REQUIRE_IDENTITY = os.environ.get("NAV_REQUIRE_IDENTITY", "true").lower() != "false"
GROUPS_HEADER = os.environ.get("NAV_GROUPS_HEADER", "x-authentik-groups")
# Comma-separated: membership of ANY of them makes an administrator, so a wider
# "runs everything" group can imply nav admin without replacing the narrow one.
ADMIN_GROUPS = {g.strip().lower() for g in os.environ.get("NAV_ADMIN_GROUP", "nav-admins").split(",") if g.strip()}
ADMIN_GROUP = "' or '".join(sorted(ADMIN_GROUPS))   # for messages only
# An explicit list, kept as a BOOTSTRAP AND BREAK-GLASS path rather than the
# primary mechanism. If the groups claim stops arriving -- a Pomerium upgrade, a
# changed scope mapping -- group-based admin fails closed and there would be no
# way back into the UI that configures it. This is the way back.
ADMINS = {a.strip().lower() for a in os.environ.get("NAV_ADMINS", "").split(",") if a.strip()}

# Impersonation: "what would this person actually see?" Gated on its own group
# rather than on admin, because it is a different power -- an admin edits the
# dashboard, an impersonator reads other people's access.
#
# 🔴 IT GRANTS NOTHING. It renders a tile list; every tile is a link, and
# Pomerium gates each target independently on the real caller's identity. An
# impersonator who clicks a tile they cannot reach gets the same 403 as before.
# What it does expose is WHICH APPLICATIONS someone has -- real information
# disclosure, which is why it is a group and why every use is logged.
IMPERSONATE_GROUP = os.environ.get("NAV_IMPERSONATE_GROUP", "staff").strip().lower()

pool: AsyncConnectionPool | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global pool
    pool = AsyncConnectionPool(DSN, min_size=1, max_size=8, open=False, kwargs={"row_factory": dict_row})
    try:
        await pool.open(wait=True, timeout=30)
    except Exception as exc:
        # A malformed DSN surfaces as a 30-second PoolTimeout, which reads like
        # the database is down when it is actually a parse error -- hit
        # 2026-09-28 with a `%` in the password, where a URI DSN needs `%25`.
        #
        # Say so without echoing the DSN: psycopg's own message already put the
        # password fragment in the pod log, which is how it ended up somewhere
        # it should not be.
        hint = ""
        if "%" in DSN and "://" in DSN:
            hint = (" — NAV_DSN is a URI and contains '%'. A literal percent must be '%25'. "
                    "Prefer libpq keyword/value form, which has no escaping rules: "
                    "'host=... port=5432 dbname=nav user=nav password=...'")
        raise RuntimeError(f"could not open the database pool: {type(exc).__name__}{hint}") from None
    # Schema on start rather than a migration job: it is idempotent, it is one
    # file, and a separate Job is a second thing that can fail silently before
    # the app does.
    with open(os.path.join(os.path.dirname(__file__), "schema.sql")) as fh:
        ddl = fh.read()
    async with pool.connection() as conn:
        await conn.execute(ddl)
    await load_connections()
    checks = asyncio.create_task(health.loop())
    yield
    checks.cancel()
    await pool.close()


app = FastAPI(title="nav-api", lifespan=lifespan)


async def whoami(request: Request) -> str:
    who = request.headers.get(IDENTITY_HEADER, "").strip().lower()
    if not who:
        if REQUIRE_IDENTITY:
            # Fail closed. An anonymous fallback here would mean a request that
            # bypassed Pomerium silently got someone's defaults.
            raise HTTPException(401, f"no {IDENTITY_HEADER}; this route is reachable only through Pomerium")
        return "anonymous"
    return who


def parse_groups(raw: str) -> set[str]:
    """Split however Pomerium rendered the claim.

    The `groups` claim is a JSON array in the token, and jwtClaimHeaders
    flattens it into one header. Which separator it uses is not documented
    clearly enough to depend on -- Authentik's own outpost used `|`, and
    comma is the other obvious candidate -- so accept all of them plus a
    literal JSON array. Guessing one and being wrong fails closed and silently,
    which for an admin check means "nobody is an admin and nothing says why".
    """
    raw = (raw or "").strip()
    if not raw:
        return set()
    if raw.startswith("["):
        try:
            return {str(g).strip().lower() for g in json.loads(raw)}
        except ValueError:
            pass
    for sep in ("|", ";", ","):
        if sep in raw:
            return {g.strip().lower() for g in raw.split(sep) if g.strip()}
    return {raw.lower()}


async def is_admin(request: Request, who: str) -> bool:
    if who in ADMINS:                       # break-glass list, see above
        return True
    return bool(ADMIN_GROUPS & parse_groups(request.headers.get(GROUPS_HEADER, "")))


async def may_impersonate(request: Request, who: str) -> bool:
    if who in ADMINS:                       # break-glass, same reasoning as admin
        return True
    return IMPERSONATE_GROUP in parse_groups(request.headers.get(GROUPS_HEADER, ""))


async def require_impersonator(request: Request, who: str = Depends(whoami)) -> str:
    if not await may_impersonate(request, who):
        raise HTTPException(
            403,
            f"impersonation needs membership of '{IMPERSONATE_GROUP}', "
            f"delivered in the {GROUPS_HEADER} header")
    return who


async def require_admin(request: Request, who: str = Depends(whoami)) -> str:
    if not await is_admin(request, who):
        raise HTTPException(
            403,
            f"not an administrator of nav: needs membership of '{ADMIN_GROUP}', "
            f"delivered in the {GROUPS_HEADER} header")
    return who


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Deliberately identity-free, so a probe does not need a header."""
    try:
        async with pool.connection() as conn:  # type: ignore[union-attr]
            await conn.execute("SELECT 1")
        return {"ok": True, "db": True}
    except Exception as exc:  # noqa: BLE001 -- the probe must report, not raise
        return JSONResponse({"ok": False, "db": False, "error": str(exc)}, status_code=503)


@app.get("/api/health")
async def app_health(who: str = Depends(whoami), host: list[str] | None = Query(None)) -> dict[str, Any]:
    """Up / down / unknown for the hosts asked about (health.py).

    Only the hosts the page names, which are its own tiles' -- so this tells
    nobody about an app they were not already shown."""
    return {"hosts": health.lookup((host or [])[:200])}


@app.get("/api/version")
async def version(_: str = Depends(whoami)) -> dict[str, Any]:
    """What is actually running.

    UTC is sent, not a formatted local string: the server has no idea what
    timezone the reader is in, and the browser does. Formatting here would be
    guessing.

    Reports the nav-api build only. The page itself is served from a ConfigMap
    and is not versioned — it can change without a rebuild, so a single number
    covering both would sometimes be a lie.
    """
    return {
        "version": os.environ.get("NAV_VERSION", "unknown"),
        "built_at": os.environ.get("NAV_BUILT_AT", "unknown"),
    }


@app.get("/api/me")
async def me(request: Request, who: str = Depends(whoami)) -> dict[str, Any]:
    return {
        "user": who,
        "admin": await is_admin(request, who),
        # Whether to OFFER the control. The server re-checks on every call;
        # this only decides whether the UI draws it.
        "may_impersonate": await may_impersonate(request, who),
        "groups": sorted(parse_groups(request.headers.get(GROUPS_HEADER, ""))),
    }


async def authentik_apps(who: str) -> list[dict[str, Any]]:
    """The access answer, straight from Authentik and unmodified.

    Resolved by email rather than trusting a client-supplied id: the header is
    the only identity this service accepts, so the lookup has to start there.
    """
    if not AUTHENTIK_TOKEN:
        raise HTTPException(503, "AUTHENTIK_TOKEN is not set; cannot resolve applications")
    headers = {"Authorization": f"Bearer {AUTHENTIK_TOKEN}"}
    async with httpx.AsyncClient(base_url=AUTHENTIK_URL, headers=headers, timeout=15) as client:
        users = await client.get("/api/v3/core/users/", params={"email": who})
        users.raise_for_status()
        results = users.json().get("results") or []
        if not results:
            return []
        # The rule lives in urls.py so it can be tested without a database.
        uid, ambiguous = pick_account(results)
        if ambiguous:
            raise HTTPException(409, ambiguous)
        if uid is None:
            return []

        # for_user filters to what THIS user may reach. superuser_full_list
        # would return everything and is the documented way to break this.
        apps = await client.get(
            "/api/v3/core/applications/",
            params={"for_user": uid, "page_size": 100},
        )
        apps.raise_for_status()
        return apps.json().get("results") or []


async def user_groups(email: str) -> set[str]:
    """Group names for one user, lowercased. Used only while impersonating."""
    if not AUTHENTIK_TOKEN:
        return set()
    headers = {"Authorization": f"Bearer {AUTHENTIK_TOKEN}"}
    async with httpx.AsyncClient(base_url=AUTHENTIK_URL, headers=headers, timeout=15) as client:
        r = await client.get("/api/v3/core/users/", params={"email": email})
        r.raise_for_status()
        results = r.json().get("results") or []
    if not results:
        return set()
    return {str(g.get("name", "")).strip().lower()
            for g in (results[0].get("groups_obj") or []) if g.get("name")}


async def apps_for_groups(groups: list[str]) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """What a user whose ONLY group is `group` could reach.

    Returns (applications, undeterminable_slugs, missing_group_names).

    COMPUTED, NOT SAMPLED. See group_can_see() in urls.py for why, and for the
    assumption it rests on. In short: Authentik has no `for_group`, and showing
    a real member's view answers a different question, because real people
    belong to several groups at once.

    `superuser_full_list` is used DELIBERATELY, and this is the one place it is
    correct. Elsewhere it is the documented way to break nav -- it returns every
    application regardless of who asks. Here the full list is the INPUT to an
    evaluation that then decides, per application, what this hypothetical user
    could reach; the caller is already gated on the impersonation group.
    """
    if not AUTHENTIK_TOKEN:
        raise HTTPException(503, "AUTHENTIK_TOKEN is not set; cannot evaluate the group")
    headers = {"Authorization": f"Bearer {AUTHENTIK_TOKEN}"}
    async with httpx.AsyncClient(base_url=AUTHENTIK_URL, headers=headers, timeout=20) as client:
        have = await client.get("/api/v3/core/groups/", params={"page_size": 200})
        have.raise_for_status()
        known = {(x.get("name") or "").strip().lower()
                 for x in (have.json().get("results") or [])}
        missing = [g for g in groups if g.strip().lower() not in known]
        if missing:
            return [], [], missing

        a = await client.get("/api/v3/core/applications/",
                             params={"page_size": 200, "superuser_full_list": "true"})
        a.raise_for_status()
        apps = a.json().get("results") or []

        b = await client.get("/api/v3/policies/bindings/", params={"page_size": 500})
        b.raise_for_status()
        bindings = b.json().get("results") or []

    # Bindings also hang off flows and stages; only those targeting an
    # application say anything about who may reach it.
    app_uuids = {x.get("pk") for x in apps}
    by_target: dict[str, list[dict[str, Any]]] = {}
    for x in bindings:
        if x.get("target") in app_uuids:
            by_target.setdefault(x["target"], []).append(x)

    out, unknown = [], []
    for app in apps:
        verdict = group_can_see(by_target.get(app.get("pk"), []), groups,
                                app.get("policy_engine_mode") or "any")
        if verdict is None:
            # Neither shown nor silently dropped: named, so the screen can say
            # it does not know rather than implying it does.
            unknown.append(app.get("slug") or str(app.get("pk")))
        elif verdict:
            out.append(app)
    return out, sorted(unknown), []


# `frameable` is opt-in per application and defaults false, because Pomerium
# sets `X-Frame-Options: SAMEORIGIN` on every response and nav is a different
# origin from every app it links to. Offering "open in side frame" by default
# would produce a blank panel for every tile -- a failure that looks like the
# app being broken rather than the browser refusing.
#
# Making one frameable takes a Pomerium annotation on THAT app's Ingress, and
# possibly a change in the app itself (Grafana ships X-Frame-Options: deny).
# The overridable fields, the cascade and merge() live in layouts.py, with the
# template/dashboard model they now belong to.


# --- layouts: which one a request sees -----------------------------------------

async def default_template(conn: Any) -> dict[str, Any]:
    row = await (await conn.execute(
        "SELECT * FROM layouts WHERE kind = 'template' AND is_default")).fetchone()
    if row is None:
        # The migration creates one and deleting it is refused, so this is a
        # database someone edited by hand. Say so rather than render nothing.
        raise HTTPException(500, "no default template -- set one: UPDATE layouts SET is_default")
    return row


async def viewable_layout(conn: Any, lid: int | None, who: str) -> dict[str, Any]:
    """The layout to render. Templates are readable by everyone (a user with no
    dashboard sees the default one); a dashboard only by its owner -- anyone
    else gets the same 404 as a layout that does not exist."""
    if lid is None:
        return await default_template(conn)
    row = await (await conn.execute("SELECT * FROM layouts WHERE id = %s", (lid,))).fetchone()
    if row is None or (row["kind"] == "dashboard" and row["owner"] != who):
        raise HTTPException(404, f"no layout {lid}")
    return row


async def tiles_of(conn: Any, lid: int) -> dict[str, dict[str, Any]]:
    rows = await (await conn.execute(
        "SELECT slug, fields FROM layout_tiles WHERE layout_id = %s", (lid,))).fetchall()
    return {r["slug"]: (r["fields"] or {}) for r in rows}


def layout_info(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row.get(k) for k in ("id", "kind", "name", "template_id", "is_default",
                                    "group_order", "group_hidden")} | {"mode": row.get("mode") or "packed",
                                                                        "free_groups": row.get("free_groups") or [],
                                                                        "style": row.get("style") or {}}


@app.get("/api/apps")
async def list_apps(request: Request, who: str = Depends(whoami), layout: int | None = None,
                    include_hidden: bool = False,
                    as_user: str | None = None,
                    as_group: list[str] | None = Query(None)) -> dict[str, Any]:
    """Authentik's answer, with the admin and user layers applied.

    THE CASCADE IS Authentik -> admin_overrides -> profile.settings:
      * Terraform seeds Authentik with the new-instance defaults
      * an admin changes what THIS instance shows, in the database
      * a user changes what THEY see, in their profile

    Merged here rather than in the browser so there is one implementation to be
    wrong in, and so `hidden` actually removes a tile rather than hiding it from
    a page that already received it.

    `include_hidden` is for the admin editor: it keeps hidden tiles in the list
    and attaches each app's pre-merge `base` and its `override`, so the editor
    can show what a field would revert to.
    """
    # Admin-only, and silently ignored otherwise rather than refused: a normal
    # page load that happened to carry the parameter should still render, it
    # just must not reveal tiles an admin chose to hide.
    # `is_admin_` and not `admin`: that name was reused below for the
    # admin_overrides rows, and the reply's "admin" key carried THE ROWS --
    # truthy for every user once any override existed, so everyone got the
    # admin menu (writes were still refused server-side). Fixed 2026-10-11.
    is_admin_ = await is_admin(request, who)
    want_hidden = include_hidden
    # The admin view: hidden tiles, every custom tile, base/override for the
    # editor. A dashboard's OWNER gets hidden tiles back too (to unhide them)
    # but never the custom tiles they are not offered.
    include_hidden = include_hidden and is_admin_

    # --- impersonation ---------------------------------------------------
    # `subject` is whose access is being rendered; `who` stays the real caller
    # and is what every write path and every log line uses. Nothing below may
    # substitute one for the other.
    subject, impersonating = who, None
    if as_user or as_group:
        if not await may_impersonate(request, who):
            raise HTTPException(
                403,
                f"impersonation needs membership of '{IMPERSONATE_GROUP}', "
                f"delivered in the {GROUPS_HEADER} header")
        groups_req = [g.strip() for g in (as_group or []) if g and g.strip()]
        added_slugs: set[str] = set()
        raw = []

        # ONE user, MANY groups. A person is a specific account; groups are a
        # hypothesis about membership, and several of them is still one
        # hypothesis.
        if as_user:
            subject = as_user.strip().lower()
            raw = await authentik_apps(subject)

        unknown: list[str] = []
        if groups_req:
            group_apps, unknown, missing = await apps_for_groups(groups_req)
            if missing:
                raise HTTPException(
                    404, "no such group in Authentik: " + ", ".join(sorted(missing)))
            if as_user:
                # The DELTA is the point of combining them: what would this
                # person gain by being added to these groups? Everything they
                # already reach is not news.
                have = {a.get("slug") for a in raw}
                extra = [a for a in group_apps if a.get("slug") not in have]
                added_slugs = {a.get("slug") for a in extra}
                raw = raw + extra
            else:
                raw = group_apps

        if as_user and groups_req:
            label = (f"{subject} plus " +
                     ", ".join(f"\u201c{g}\u201d" for g in groups_req))
        elif as_user:
            label = subject
        else:
            label = ("anyone whose only group" +
                     ("s are " if len(groups_req) > 1 else " is ") +
                     ", ".join(f"\u201c{g}\u201d" for g in groups_req))

        impersonating = {
            "kind": "user" if as_user and not groups_req
                    else "both" if as_user else "group",
            "subject": label,
            "user": subject if as_user else None,
            "groups": groups_req,
            # Applications whose bindings this cannot read exactly. Named
            # rather than dropped, so the screen admits what it does not know.
            "undetermined": unknown,
            # Slugs the GROUPS add on top of what the user already has.
            "added": sorted(x for x in added_slugs if x),
        }

        # Audited, deliberately unconditional. Reading someone else's access is
        # the kind of thing that should never be inferable only from absence.
        print(f"impersonation: {who} viewed as {label}", flush=True)
        include_hidden = want_hidden = False
        layout = None       # theirs is unknowable here: the default template

    if not impersonating:
        raw = await authentik_apps(subject)
    if impersonating and not raw:
        # Distinguish "reaches nothing" from "no such person" -- otherwise a
        # typo in an email reads as "locked out of everything".
        impersonating["empty"] = True
    async with pool.connection() as conn:  # type: ignore[union-attr]
        clicks = await (await conn.execute(
            # `who`, never `subject`. Click counts are personal usage
            # telemetry, and "which apps does this person open most" is not
            # part of the question impersonation exists to answer. Under
            # impersonation these are zeroed below rather than swapped.
            "SELECT slug, clicks FROM app_clicks WHERE owner = %s", (who,))).fetchall()
        shared = await (await conn.execute(
            "SELECT slug, SUM(clicks) AS clicks FROM app_clicks GROUP BY slug")).fetchall()
        admin_rows = await (await conn.execute("SELECT slug, fields FROM admin_overrides")).fetchall()
        lay = await viewable_layout(conn, layout, who)
        own = await tiles_of(conn, lay["id"])
        # A dashboard's fallback for apps it has no row for: its template, or
        # the default one if that template has since been deleted.
        tpl: dict[str, dict[str, Any]] = {}
        if lay["kind"] == "dashboard":
            tpl = await tiles_of(conn, lay["template_id"] or (await default_template(conn))["id"])

        customs = await (await conn.execute(
            "SELECT * FROM custom_tiles ORDER BY slug")).fetchall()

    mine = {} if impersonating else {r["slug"]: r["clicks"] for r in clicks}
    added = set(impersonating["added"]) if impersonating else set()
    everyone = {r["slug"]: int(r["clicks"]) for r in shared}
    # Presentation only: any layout keys left in admin_overrides are ignored.
    pres = {r["slug"]: layouts.split(r["fields"] or {})[0] for r in admin_rows}
    own_dash = lay["kind"] == "dashboard" and lay["owner"] == who
    show_hidden = want_hidden and (include_hidden or own_dash)

    def layered(slug: str, base: dict[str, Any]) -> dict[str, Any]:
        return merge(base, pres.get(slug, {}),
                     layouts.tile_layer(slug, lay["kind"], own, tpl, lay.get("mode") or "packed"))

    def editor_fields(slug: str, base: dict[str, Any]) -> dict[str, Any]:
        """What the editor needs to show what a field would revert to."""
        if own_dash:
            return {"base": merge(base, pres.get(slug, {})), "override": own.get(slug, {})}
        return {"base": base, "override": {**pres.get(slug, {}), **own.get(slug, {})}}

    out = []
    for a in raw:
        if a.get("meta_hide"):
            continue
        url = a.get("launch_url") or a.get("meta_launch_url")
        if not launchable(url):
            continue
        slug = a.get("slug")
        base = {
            "slug": slug,
            "name": a.get("name"),
            "url": url,
            "description": a.get("meta_description") or "",
            "category": a.get("group") or "",
            "icon": a.get("meta_icon") or "",
            "icon_light": "",
            "hidden": False,
            "above_fold": False,
            "frameable": False,
            "order": None,
        }
        merged = layered(slug, base)
        if merged.get("hidden") and not show_hidden:
            continue
        merged["clicks_mine"] = mine.get(slug, 0)
        merged["clicks_all"] = everyone.get(slug, 0)
        if impersonating and slug in added:
            # "What do these groups ADD for this person" is the question; the
            # tiles they already had are context, not the answer.
            merged["added"] = True
        if show_hidden:
            # The editor has to show what a field would be WITHOUT the
            # override, or "revert to default" is a button whose outcome nobody
            # can see in advance. Only sent when asked for, so the normal page
            # load does not carry two copies of everything.
            merged.update(editor_fields(slug, base))
        out.append(merged)

    # Custom tiles last, and only for slugs Authentik did not already supply.
    # A collision is rejected at write time, but Authentik's set changes
    # without asking nav -- an application created later can take a slug a
    # custom tile already holds. Authentik wins, because that one is backed by
    # real access; the custom row is reported as shadowed rather than silently
    # dropped, so the admin editor can say so.
    seen = {a["slug"] for a in out}
    # The SUBJECT's groups. The header carries the real caller's, which is the
    # right answer normally and the wrong one entirely while impersonating --
    # custom tiles would be filtered by the viewer's membership rather than by
    # the person being viewed, so the screen would confidently show the wrong
    # list. Fetched from Authentik only when impersonating; the header is free
    # and correct the rest of the time.
    if impersonating:
        # The hypothesis under test: the chosen groups, plus the real
        # membership of the chosen user when there is one.
        groups = {g.strip().lower() for g in impersonating["groups"]}
        if impersonating["user"]:
            groups |= await user_groups(impersonating["user"])
    else:
        groups = parse_groups(request.headers.get(GROUPS_HEADER, ""))
    for row in customs:
        slug = row["slug"]
        if slug in seen:
            continue
        # visible_to is presentation, NOT a gate: see the schema comment. The
        # admin editor (include_hidden) sees every tile so it can edit one it
        # is not itself offered.
        if not include_hidden and not offered_to(row["visible_to"], groups, who):
            continue
        base = {
            "slug": slug,
            "name": row["name"],
            "url": row["url"],
            "description": row["description"] or "",
            "category": row["category"] or "",
            "icon": row["icon"] or "",
            "icon_light": row["icon_light"] or "",
            "hidden": False,
            "above_fold": False,
            "frameable": False,
            "order": None,
        }
        merged = layered(slug, base)
        if merged.get("hidden") and not show_hidden:
            continue
        merged["clicks_mine"] = mine.get(slug, 0)
        merged["clicks_all"] = everyone.get(slug, 0)
        # The UI needs to tell the two apart: a custom tile has an editable URL
        # and can be deleted, neither of which is true of an Authentik one.
        merged["custom"] = True
        merged["visible_to"] = row["visible_to"] or []
        if show_hidden:
            merged.update(editor_fields(slug, base))
        out.append(merged)

    # may_impersonate belongs HERE as well as on /api/me, because /api/apps is
    # the only call the page makes on load -- it never fetches /api/me, so a
    # flag that lives only there is a flag the UI can never see. That is
    # exactly how "View as" shipped invisible.
    return {"user": who, "admin": is_admin_, "layout": layout_info(lay), "apps": out,
            "may_impersonate": await may_impersonate(request, who),
            "impersonating": impersonating}


@app.post("/api/apps/{slug}/click")
async def record_click(slug: str, who: str = Depends(whoami)) -> dict[str, Any]:
    """Popularity, which is why a shared store was needed at all."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute(
            """INSERT INTO app_clicks (owner, slug, clicks) VALUES (%s, %s, 1)
               ON CONFLICT (owner, slug)
               DO UPDATE SET clicks = app_clicks.clicks + 1, last_at = now()""",
            (who, slug),
        )
    return {"ok": True}


# --- layouts: templates and dashboards (roadmap #34) ---------------------------
#
# One set of routes for both kinds, authorised by kind: a TEMPLATE needs an
# admin, a DASHBOARD its owner (anyone else gets a 404, as if it did not exist).
# The page's edit UI is the same grid pointed at a different layout id.

async def writable_layout(conn: Any, request: Request, who: str, lid: int) -> dict[str, Any]:
    row = await (await conn.execute("SELECT * FROM layouts WHERE id = %s", (lid,))).fetchone()
    if row is None or (row["kind"] == "dashboard" and row["owner"] != who):
        raise HTTPException(404, f"no layout {lid}")
    if row["kind"] == "template" and not await is_admin(request, who):
        raise HTTPException(403, f"templates are edited by administrators of nav ('{ADMIN_GROUP}')")
    return row


async def touch(conn: Any, lid: int, who: str) -> None:
    await conn.execute("UPDATE layouts SET updated_at = now(), updated_by = %s WHERE id = %s",
                       (who, lid))


def bad(exc: ValueError) -> HTTPException:
    return HTTPException(422, str(exc))


async def copy_layout(conn: Any, src: dict[str, Any], dst: int, who: str) -> None:
    """Tiles, placements and groups from `src` into `dst` (assumed empty)."""
    await conn.execute(
        "UPDATE layouts SET group_order = %s, group_hidden = %s WHERE id = %s",
        (json.dumps(src["group_order"]), json.dumps(src["group_hidden"]), dst))
    await conn.execute(
        "INSERT INTO layout_tiles (layout_id, slug, fields) "
        "SELECT %s, slug, fields FROM layout_tiles WHERE layout_id = %s", (dst, src["id"]))
    await conn.execute(
        "INSERT INTO widget_placements (layout_id, def_id, category, ord, size, hidden, above_fold, x, y, created_by) "
        "SELECT %s, def_id, category, ord, size, hidden, above_fold, x, y, %s FROM widget_placements "
        "WHERE layout_id = %s",
        (dst, who, src["id"]))


@app.get("/api/layouts")
async def list_layouts(who: str = Depends(whoami)) -> dict[str, Any]:
    """Every template (anyone may view or copy one) and the caller's dashboards."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        tpls = await (await conn.execute(
            "SELECT id, name, is_default, updated_at FROM layouts WHERE kind = 'template' "
            "ORDER BY is_default DESC, lower(name)")).fetchall()
        dash = await (await conn.execute(
            "SELECT id, name, template_id, mode, updated_at FROM layouts "
            "WHERE kind = 'dashboard' AND owner = %s ORDER BY created_at, id", (who,))).fetchall()
    return {"templates": tpls, "dashboards": dash}


@app.post("/api/layouts")
async def create_layout(body: dict[str, Any], request: Request,
                        who: str = Depends(whoami)) -> dict[str, Any]:
    """{kind, name, from_id?, mode?}. A dashboard is a full copy of `from_id` --
    a template, or one of the caller's dashboards -- defaulting to the default
    template. A template is empty, or a copy of another template. mode `free`
    (dashboards only) is EMPTY: nothing is copied, so no from_id."""
    kind = body.get("kind")
    if kind not in layouts.KINDS:
        raise HTTPException(422, f"kind must be one of {list(layouts.KINDS)}")
    mode = body.get("mode") or "packed"
    if mode not in layouts.MODES:
        raise HTTPException(422, f"mode must be one of {list(layouts.MODES)}")
    if mode == "free" and kind != "dashboard":
        raise HTTPException(422, "only a dashboard can be free -- templates stay packed")
    if mode == "free" and body.get("from_id") is not None:
        raise HTTPException(422, "a free dashboard starts empty; it copies nothing")
    try:
        name = layouts.clean_name(body.get("name"))
    except ValueError as exc:
        raise bad(exc) from None
    if kind == "template" and not await is_admin(request, who):
        raise HTTPException(403, f"templates are made by administrators of nav ('{ADMIN_GROUP}')")
    src_id = body.get("from_id")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            src = None
            if src_id is not None:
                src = await viewable_layout(conn, int(src_id), who)
                if kind == "template" and src["kind"] != "template":
                    raise HTTPException(422, "a template is copied from another template")
            elif kind == "dashboard" and mode == "packed":
                src = await default_template(conn)
            # The template a dashboard reverts to: the one copied, or the one
            # the copied dashboard came from.
            tpl_id = None
            if kind == "dashboard" and src is not None:
                tpl_id = src["id"] if src["kind"] == "template" else src["template_id"]
            try:
                row = await (await conn.execute(
                    "INSERT INTO layouts (kind, owner, name, template_id, mode, updated_by) "
                    "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                    (kind, who if kind == "dashboard" else None, name, tpl_id, mode, who))).fetchone()
            except psycopg.errors.UniqueViolation:
                raise HTTPException(409, f"there is already a {kind} called {name!r}") from None
            if src is not None:
                await copy_layout(conn, src, row["id"], who)
    return {"ok": True, "id": row["id"]}


@app.put("/api/layouts/{lid}")
async def update_layout(lid: int, body: dict[str, Any], request: Request,
                        who: str = Depends(whoami)) -> dict[str, Any]:
    """{name?, is_default?: true}. Default is moved, never cleared: there is
    always exactly one, because a device with no dashboard has to show one."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            row = await writable_layout(conn, request, who, lid)
            if "name" in body:
                try:
                    name = layouts.clean_name(body["name"])
                except ValueError as exc:
                    raise bad(exc) from None
                try:
                    await conn.execute("UPDATE layouts SET name = %s WHERE id = %s", (name, lid))
                except psycopg.errors.UniqueViolation:
                    raise HTTPException(409, f"there is already a {row['kind']} called {name!r}") from None
            if body.get("is_default") is True:
                if row["kind"] != "template":
                    raise HTTPException(422, "only a template can be the default")
                await conn.execute("UPDATE layouts SET is_default = false WHERE is_default")
                await conn.execute("UPDATE layouts SET is_default = true WHERE id = %s", (lid,))
            await touch(conn, lid, who)
    return {"ok": True, "id": lid}


@app.delete("/api/layouts/{lid}")
async def delete_layout(lid: int, request: Request, who: str = Depends(whoami)) -> dict[str, Any]:
    """Devices showing it fall back to the default template; dashboards copied
    from a deleted template revert to the default from then on."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        row = await writable_layout(conn, request, who, lid)
        if row["is_default"]:
            raise HTTPException(409, "make another template the default first")
        await conn.execute("DELETE FROM layouts WHERE id = %s", (lid,))
    return {"ok": True}


@app.post("/api/layouts/{lid}/revert")
async def revert_layout(lid: int, request: Request, who: str = Depends(whoami)) -> dict[str, Any]:
    """Re-copy a dashboard from its template, keeping its name and id (so every
    device showing it keeps showing it)."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            row = await writable_layout(conn, request, who, lid)
            if row["kind"] != "dashboard":
                raise HTTPException(422, "only a dashboard reverts to its template")
            if row.get("mode") == "free":
                raise HTTPException(422, "a free dashboard has no template to revert to")
            src = None
            if row["template_id"] is not None:
                src = await (await conn.execute(
                    "SELECT * FROM layouts WHERE id = %s", (row["template_id"],))).fetchone()
            src = src or await default_template(conn)
            await conn.execute("DELETE FROM layout_tiles WHERE layout_id = %s", (lid,))
            await conn.execute("DELETE FROM widget_placements WHERE layout_id = %s", (lid,))
            await copy_layout(conn, src, lid, who)
            await conn.execute("UPDATE layouts SET template_id = %s WHERE id = %s", (src["id"], lid))
            await touch(conn, lid, who)
    return {"ok": True, "id": lid, "template_id": src["id"]}


def layout_tile_fields(kind: str, raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise HTTPException(422, "tile fields must be an object")
    try:
        fields = layouts.tile_fields(kind, raw)
    except ValueError as exc:
        raise bad(exc) from None
    size = fields.get("size")
    # Named, or (a tile on a free dashboard) any span "COLSxROWS".
    if size is not None and size not in widgets.TILE_SIZES and not widgets.custom_ok(size):
        raise HTTPException(422, f"tile size must be one of {list(widgets.TILE_SIZES)} or COLSxROWS, "
                                 f"not {size!r}")
    return fields


async def put_tiles(conn: Any, lid: int, items: dict[str, dict[str, Any]]) -> None:
    """Replace each named tile's row. Already validated."""
    for slug, fields in items.items():
        await conn.execute(
            """INSERT INTO layout_tiles (layout_id, slug, fields) VALUES (%s, %s, %s)
               ON CONFLICT (layout_id, slug) DO UPDATE SET fields = EXCLUDED.fields""",
            (lid, slug, json.dumps(fields)))


@app.put("/api/layouts/{lid}/tiles")
async def set_layout_tiles(lid: int, body: dict[str, Any], request: Request,
                           who: str = Depends(whoami)) -> dict[str, Any]:
    """{tiles: {slug: fields}}: each tile's row REPLACED, in one transaction.
    A template takes layout fields only; a dashboard any overridable field."""
    items = body.get("tiles")
    if not isinstance(items, dict):
        raise HTTPException(400, "tiles must be an object keyed by slug")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            row = await writable_layout(conn, request, who, lid)
            clean = {str(s): layout_tile_fields(row["kind"], f) for s, f in items.items()}
            await put_tiles(conn, lid, clean)
            await touch(conn, lid, who)
    return {"ok": True, "count": len(items)}


@app.delete("/api/layouts/{lid}/tiles/{slug}")
async def clear_layout_tile(lid: int, slug: str, request: Request,
                            who: str = Depends(whoami)) -> dict[str, Any]:
    """Forget one tile: in a template, back to the tile's defaults; in a
    dashboard, back to the template's row for it."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await writable_layout(conn, request, who, lid)
        await conn.execute("DELETE FROM layout_tiles WHERE layout_id = %s AND slug = %s", (lid, slug))
        await touch(conn, lid, who)
    return {"ok": True}


async def put_order(conn: Any, lid: int, cat: str, items: Any) -> None:
    """One group's sequence, tiles and widgets together. Tiles are MERGED
    (order + category only), not replaced: the page's copy of a tile's other
    fields may be stale, and this must not be the write that reverts a rename."""
    if not cat or not isinstance(items, list):
        raise HTTPException(400, "layout needs a category and a list of items")
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            raise HTTPException(400, f"item {i} is not an object")
        if "app" in it:
            await conn.execute(
                """INSERT INTO layout_tiles (layout_id, slug, fields) VALUES (%s, %s, %s)
                   ON CONFLICT (layout_id, slug)
                   DO UPDATE SET fields = layout_tiles.fields || EXCLUDED.fields""",
                (lid, str(it["app"]), json.dumps({"order": i, "category": cat})))
        elif "widget" in it:
            cur = await conn.execute(
                "UPDATE widget_placements SET ord = %s, category = %s "
                "WHERE id = %s AND layout_id = %s", (i, cat, int(it["widget"]), lid))
            if cur.rowcount == 0:
                raise HTTPException(404, f"placement {it['widget']} is not in layout {lid}")
        else:
            raise HTTPException(400, f"item {i} needs `app` or `widget`")


@app.put("/api/layouts/{lid}/order")
async def set_layout_order(lid: int, body: dict[str, Any], request: Request,
                           who: str = Depends(whoami)) -> dict[str, Any]:
    """{category, items: [{"app": slug} | {"widget": placement_id}, ...]}, in
    ONE transaction: a reorder half-applied leaves duplicate positions."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            await writable_layout(conn, request, who, lid)
            await put_order(conn, lid, str(body.get("category") or "").strip(), body.get("items"))
            await touch(conn, lid, who)
    return {"ok": True}


@app.put("/api/layouts/{lid}/groups")
async def set_layout_groups(lid: int, body: dict[str, Any], request: Request,
                            who: str = Depends(whoami)) -> dict[str, Any]:
    """{order?: [group...], hidden?: [group...]}."""
    sets, args = [], []
    try:
        for key, col in (("order", "group_order"), ("hidden", "group_hidden")):
            if key in body:
                sets.append(f"{col} = %s")
                args.append(json.dumps(layouts.clean_groups(body[key], key)))
    except ValueError as exc:
        raise bad(exc) from None
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await writable_layout(conn, request, who, lid)
        if sets:
            await conn.execute(f"UPDATE layouts SET {', '.join(sets)} WHERE id = %s", (*args, lid))
        await touch(conn, lid, who)
    return {"ok": True}


@app.put("/api/layouts/{lid}/style")
async def set_layout_style(lid: int, body: dict[str, Any], request: Request,
                           who: str = Depends(whoami)) -> dict[str, Any]:
    """{bg: {c?, img?} | null}: the page's background, on any layout."""
    try:
        bg = layouts.clean_bg(body.get("bg"))
    except ValueError as exc:
        raise bad(exc) from None
    style = {"bg": bg} if bg else {}
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await writable_layout(conn, request, who, lid)
        await conn.execute("UPDATE layouts SET style = %s WHERE id = %s", (json.dumps(style), lid))
        await touch(conn, lid, who)
    return {"ok": True, "style": style}


@app.put("/api/layouts/{lid}/free-groups")
async def set_free_groups(lid: int, body: dict[str, Any], request: Request,
                          who: str = Depends(whoami)) -> dict[str, Any]:
    """{groups: [{id, name, kind, x, y, w, h}]}: a free layout's groups, the
    whole list REPLACED. Members of a removed dynamic group are the page's to
    move; this stores rectangles, nothing else."""
    try:
        groups = layouts.clean_free_groups(body.get("groups"))
    except ValueError as exc:
        raise bad(exc) from None
    async with pool.connection() as conn:  # type: ignore[union-attr]
        row = await writable_layout(conn, request, who, lid)
        if row.get("mode") != "free":
            raise HTTPException(422, "groups on the page grid are for free layouts")
        await conn.execute("UPDATE layouts SET free_groups = %s WHERE id = %s", (json.dumps(groups), lid))
        await touch(conn, lid, who)
    return {"ok": True, "count": len(groups)}


async def add_placement(conn: Any, lay: dict[str, Any], def_id: int, body: dict[str, Any],
                        who: str) -> int:
    d = await (await conn.execute(
        "SELECT id, type, owner FROM widget_defs WHERE id = %s", (def_id,))).fetchone()
    # Someone else's personal widget is a 404, like a dashboard: not even its
    # existence is shared.
    if d is None or (d["owner"] is not None and d["owner"] != who):
        raise HTTPException(404, f"no widget {def_id}")
    if lay["kind"] == "template" and d["owner"] is not None:
        raise HTTPException(422, "a template holds library widgets only -- a personal "
                                 "one would show only to its owner")
    category = str(body.get("category") or "").strip()
    if not category:
        raise HTTPException(422, "a placement needs a group")
    try:
        x = layouts.clean_cell(body.get("x"), "x", layouts.FREE_COLS)
        y = layouts.clean_cell(body.get("y"), "y", layouts.FREE_ROWS_MAX)
    except ValueError as exc:
        raise bad(exc) from None
    ord_ = body.get("ord")
    if isinstance(ord_, int) and not isinstance(ord_, bool):
        # The page knows the group's shared tile+widget sequence; the
        # server only knows the widget half of it.
        r = await (await conn.execute(
            "INSERT INTO widget_placements (layout_id, def_id, category, ord, x, y, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (lay["id"], def_id, category, ord_, x, y, who))).fetchone()
    else:
        # Appended: after the widgets already in the group.
        r = await (await conn.execute(
            "INSERT INTO widget_placements (layout_id, def_id, category, ord, x, y, created_by) "
            "SELECT %s, %s, %s, COALESCE(MAX(ord) + 1, 0), %s, %s, %s FROM widget_placements "
            "WHERE layout_id = %s AND category = %s RETURNING id",
            (lay["id"], def_id, category, x, y, who, lay["id"], category))).fetchone()
    return r["id"]


async def edit_placement(conn: Any, lid: int | None, pid: int, body: dict[str, Any]) -> None:
    """Resize (`size`), move to another group (`category`), hide (`hidden`) or
    keep showing when its group is collapsed (`above_fold`). `lid` None: any
    layout (the pre-templates admin route)."""
    row = await (await conn.execute(
        "SELECT p.id, p.layout_id, d.type, d.config FROM widget_placements p "
        "JOIN widget_defs d ON d.id = p.def_id WHERE p.id = %s", (pid,))).fetchone()
    if row is None or (lid is not None and row["layout_id"] != lid):
        raise HTTPException(404, f"no placement {pid}")
    sets, args = [], []
    if "size" in body:
        size = body["size"]
        cls = widgets.REGISTRY.get(row["type"])
        shape = def_shape(cls, row["config"]) if cls else None
        if cls is None or not widgets.size_ok(shape, size):
            allowed = widgets.SIZES.get(shape, ()) if cls else ()
            raise HTTPException(422, f"size must be one of {list(allowed)}, COLSxROWS up to "
                                     f"{widgets.CUSTOM_MAX[0]}x{widgets.CUSTOM_MAX[1]}, "
                                     f"or null for the default")
        sets.append("size = %s"); args.append(size)
    if "category" in body:
        cat = str(body["category"] or "").strip()
        if not cat:
            raise HTTPException(422, "a placement needs a group")
        sets.append("category = %s"); args.append(cat)
    for k, hi in (("x", layouts.FREE_COLS), ("y", layouts.FREE_ROWS_MAX)):
        if k in body:
            try:
                v = layouts.clean_cell(body[k], k, hi)
            except ValueError as exc:
                raise bad(exc) from None
            sets.append(f"{k} = %s"); args.append(v)
    for flag in ("hidden", "above_fold"):
        if flag in body:
            if not isinstance(body[flag], bool):
                raise HTTPException(422, f"{flag} must be true or false")
            sets.append(f"{flag} = %s"); args.append(body[flag])
    if sets:
        await conn.execute(f"UPDATE widget_placements SET {', '.join(sets)} WHERE id = %s",
                           (*args, pid))


@app.post("/api/layouts/{lid}/placements")
async def place_in_layout(lid: int, body: dict[str, Any], request: Request,
                          who: str = Depends(whoami)) -> dict[str, Any]:
    """{def_id, category, ord?}."""
    def_id = body.get("def_id")
    if not isinstance(def_id, int) or isinstance(def_id, bool):
        raise HTTPException(422, "def_id must be a widget id")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            lay = await writable_layout(conn, request, who, lid)
            pid = await add_placement(conn, lay, def_id, body, who)
            await touch(conn, lid, who)
    return {"ok": True, "id": pid}


@app.put("/api/layouts/{lid}/placements/{pid}")
async def update_layout_placement(lid: int, pid: int, body: dict[str, Any], request: Request,
                                  who: str = Depends(whoami)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            await writable_layout(conn, request, who, lid)
            await edit_placement(conn, lid, pid, body)
            await touch(conn, lid, who)
    return {"ok": True, "id": pid}


@app.delete("/api/layouts/{lid}/placements/{pid}")
async def delete_layout_placement(lid: int, pid: int, request: Request,
                                  who: str = Depends(whoami)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await writable_layout(conn, request, who, lid)
        await conn.execute("DELETE FROM widget_placements WHERE id = %s AND layout_id = %s",
                           (pid, lid))
        await touch(conn, lid, who)
    return {"ok": True}


@app.get("/api/device/{device_id}")
async def get_device(device_id: str, who: str = Depends(whoami)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        row = await (await conn.execute(
            "SELECT device_id, layout_id, label FROM device_selection WHERE owner = %s AND device_id = %s",
            (who, device_id))).fetchone()
    return row or {"device_id": device_id, "layout_id": None, "label": None}


@app.put("/api/device/{device_id}")
async def set_device(device_id: str, body: dict[str, Any], who: str = Depends(whoami)) -> dict[str, Any]:
    """Which layout this device shows -- a template or one of the caller's
    dashboards; null for the default template. The selection is per device,
    the layouts themselves are not."""
    lid = body.get("layout_id")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        if lid is not None:
            await viewable_layout(conn, int(lid), who)
        row = await (await conn.execute(
            """INSERT INTO device_selection (owner, device_id, layout_id, label)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (owner, device_id)
               DO UPDATE SET layout_id = EXCLUDED.layout_id,
                             label      = COALESCE(EXCLUDED.label, device_selection.label),
                             seen_at    = now()
               RETURNING device_id, layout_id, label""",
            (who, device_id, lid, body.get("label")))).fetchone()
    return row


@app.get("/api/admin/overrides")
async def get_overrides(_: str = Depends(whoami)) -> dict[str, Any]:
    """Readable by anyone, because the UI needs to show what it is overriding.
    Presentation (site-wide) only since templates: layout is per layout."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        rows = await (await conn.execute(
            "SELECT slug, fields, updated_by, updated_at FROM admin_overrides")).fetchall()
    return {r["slug"]: r for r in rows}


# Site-wide PRESENTATION: what a tile is called and looks like, in every
# template. Layout fields are refused (they belong to a layout: /api/layouts),
# so an edit of one half can never clear the other -- which is what sending
# presentation alone to /api/admin/overrides would do (it replaces both).

def presentation_fields(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise HTTPException(422, "tile fields must be an object")
    unknown = set(raw) - set(OVERRIDABLE)
    if unknown:
        raise HTTPException(422, f"unknown tile field(s): {', '.join(sorted(unknown))}")
    lay = set(raw) & set(layouts.LAYOUT_KEYS)
    if lay:
        raise HTTPException(422, f"{', '.join(sorted(lay))} belong(s) to a layout: "
                                 f"PUT /api/layouts/{{id}}/tiles")
    if "colour" in raw:
        try:
            raw = {**raw, "colour": layouts.clean_colour(raw["colour"])}
        except ValueError as exc:
            raise bad(exc) from None
    return raw


@app.put("/api/admin/presentation")
async def set_presentation(body: dict[str, Any], who: str = Depends(require_admin)) -> dict[str, Any]:
    """{tiles: {slug: fields}}: each tile's presentation REPLACED, one transaction."""
    items = body.get("tiles")
    if not isinstance(items, dict):
        raise HTTPException(400, "tiles must be an object keyed by slug")
    clean = {str(s): presentation_fields(f) for s, f in items.items()}
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            for slug, fields in clean.items():
                await conn.execute(
                    """INSERT INTO admin_overrides (slug, fields, updated_by) VALUES (%s, %s, %s)
                       ON CONFLICT (slug) DO UPDATE SET fields = EXCLUDED.fields,
                                                        updated_by = EXCLUDED.updated_by,
                                                        updated_at = now()""",
                    (slug, json.dumps(fields), who))
    return {"ok": True, "count": len(clean)}


@app.delete("/api/admin/presentation/{slug}")
async def clear_presentation(slug: str, _: str = Depends(require_admin)) -> dict[str, Any]:
    """Back to Authentik's name, icon and description -- whatever Terraform seeded."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute("DELETE FROM admin_overrides WHERE slug = %s", (slug,))
    return {"ok": True, "slug": slug}


# ⚠️ PRE-TEMPLATE ROUTES, KEPT FOR THE ROLLOUT. The page ships about a minute
# before this service does, so for a while an OLD page talks to THIS api; and
# until step 6 the admin page still uses them. An override object mixes both
# halves, so it is SPLIT: presentation to admin_overrides (site-wide), layout to
# the DEFAULT template -- the layout these routes always edited. Retire them
# once the page writes through /api/layouts.

async def save_override(conn: Any, slug: str, fields: dict[str, Any], who: str,
                        tpl: int) -> None:
    pres, lay = layouts.split(fields)
    await conn.execute(
        """INSERT INTO admin_overrides (slug, fields, updated_by) VALUES (%s, %s, %s)
           ON CONFLICT (slug) DO UPDATE SET fields = EXCLUDED.fields,
                                            updated_by = EXCLUDED.updated_by,
                                            updated_at = now()""",
        (slug, json.dumps(pres), who))
    if lay:
        await put_tiles(conn, tpl, {slug: lay})
    else:
        await conn.execute("DELETE FROM layout_tiles WHERE layout_id = %s AND slug = %s",
                           (tpl, slug))


def clean_fields(raw: dict[str, Any] | None) -> dict[str, Any]:
    """Known fields only, and a `size` the page can draw.

    🔴 An unknown size is REFUSED, not dropped. It used to be dropped "so the
    rest of the edit survives" -- and on 2026-10-11 that hid a version skew:
    the page shipped XS minutes before this service learned it, every XS tile
    saved as no size at all with a 200, and the tiles grew back on the next
    reload with nothing ever saying why. A 422 makes the page say so."""
    fields = {k: v for k, v in (raw or {}).items() if k in OVERRIDABLE}
    if "size" in fields and fields["size"] not in widgets.TILE_SIZES:
        raise HTTPException(422, f"tile size must be one of {list(widgets.TILE_SIZES)}, "
                                 f"not {fields['size']!r}")
    if "colour" in fields:
        try:
            fields["colour"] = layouts.clean_colour(fields["colour"])
        except ValueError as exc:
            raise bad(exc) from None
    return fields


@app.put("/api/admin/overrides/{slug}")
async def set_override(slug: str, body: dict[str, Any], who: str = Depends(require_admin)) -> dict[str, Any]:
    """Change what THIS instance shows for one application.

    Does not touch Authentik. Terraform owns the new-instance defaults there and
    would overwrite anything written back on the next apply — which is exactly
    the conflict this layer exists to avoid.
    """
    fields = clean_fields(body.get("fields"))
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            await save_override(conn, slug, fields, who, (await default_template(conn))["id"])
    return {"ok": True, "slug": slug, "fields": fields}


@app.put("/api/admin/overrides")
async def set_overrides(body: dict[str, Any], who: str = Depends(require_admin)) -> dict[str, Any]:
    """Several applications at once, in one transaction.

    Dragging a tile to a new position renumbers every tile in that category, so
    a per-app endpoint would mean a burst of requests that can half-apply — and
    a half-applied reorder leaves duplicate positions, which is worse than not
    reordering at all.
    """
    items = body.get("overrides") or {}
    if not isinstance(items, dict):
        raise HTTPException(400, "overrides must be an object keyed by slug")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            tpl = (await default_template(conn))["id"]
            for slug, raw in items.items():
                await save_override(conn, slug, clean_fields(raw), who, tpl)
    return {"ok": True, "count": len(items)}


@app.delete("/api/admin/overrides/{slug}")
async def clear_override(slug: str, _: str = Depends(require_admin)) -> dict[str, Any]:
    """Revert to Authentik's value — i.e. to whatever Terraform seeded. The
    default template's row too: this route edited both before templates."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            await conn.execute("DELETE FROM admin_overrides WHERE slug = %s", (slug,))
            await conn.execute("DELETE FROM layout_tiles WHERE layout_id = %s AND slug = %s",
                               ((await default_template(conn))["id"], slug))
    return {"ok": True, "slug": slug}


@app.get("/api/admin/custom-tiles")
async def list_custom(_: str = Depends(require_admin)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        rows = await (await conn.execute(
            "SELECT * FROM custom_tiles ORDER BY slug")).fetchall()
    return {"tiles": [dict(r) for r in rows]}


@app.put("/api/admin/custom-tiles/{slug}")
async def set_custom(slug: str, body: dict[str, Any], request: Request,
                     who: str = Depends(require_admin)) -> dict[str, Any]:
    """Create or update a custom tile. See the schema comment: a BOOKMARK.

    Validated here rather than trusted from the editor because these two
    fields are the ones that end up in an href and a filesystem-ish lookup.
    """
    if not valid_slug(slug):
        raise HTTPException(422, "slug must be lowercase letters, digits and "
                                 "hyphens, starting with a letter or digit")
    url = str(body.get("url") or "").strip()
    if not launchable(url):
        raise HTTPException(422, "url must be http(s) or a root-relative path")
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "a tile needs a name")

    visible_to = body.get("visible_to") or []
    if not isinstance(visible_to, list):
        raise HTTPException(422, "visible_to must be a list of group names")
    # Normalised to `group:<name>` / `user:<email>` on the way in, so the
    # reader never has to guess. A bare value stays a group, which is what the
    # column meant before users could be picked.
    cleaned = []
    for raw in visible_to:
        e = str(raw).strip().lower()
        if not e:
            continue
        if not e.startswith(("group:", "user:")):
            e = "group:" + e
        if e in ("group:", "user:"):
            continue
        cleaned.append(e)
    visible_to = sorted(set(cleaned))

    # Refuse a slug Authentik already uses. The check is against the CALLING
    # admin's view, which is the only application list this service can get
    # per-user -- an application the admin cannot see could still collide
    # later, which is why list_apps lets Authentik win at render time too.
    existing = {a.get("slug") for a in await authentik_apps(who)}
    async with pool.connection() as conn:  # type: ignore[union-attr]
        already = await (await conn.execute(
            "SELECT 1 FROM custom_tiles WHERE slug = %s", (slug,))).fetchone()
        if slug in existing and not already:
            raise HTTPException(409, f"'{slug}' is already an Authentik application; "
                                     f"pick another slug")
        await conn.execute(
            """INSERT INTO custom_tiles
                   (slug, url, name, description, category, icon, icon_light,
                    visible_to, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (slug) DO UPDATE SET
                   url = EXCLUDED.url, name = EXCLUDED.name,
                   description = EXCLUDED.description, category = EXCLUDED.category,
                   icon = EXCLUDED.icon, icon_light = EXCLUDED.icon_light,
                   visible_to = EXCLUDED.visible_to, updated_at = now()""",
            (slug, url, name,
             str(body.get("description") or "").strip(),
             str(body.get("category") or "").strip(),
             str(body.get("icon") or "").strip(),
             str(body.get("icon_light") or "").strip(),
             json.dumps(visible_to), who),
        )
    return {"ok": True, "slug": slug}


@app.delete("/api/admin/custom-tiles/{slug}")
async def delete_custom(slug: str, _: str = Depends(require_admin)) -> dict[str, Any]:
    """Delete the tile AND its override.

    Leaving admin_overrides behind means a later tile that happens to reuse
    the slug silently inherits a deleted tile's name and icon.
    """
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute("DELETE FROM custom_tiles WHERE slug = %s", (slug,))
        await conn.execute("DELETE FROM admin_overrides WHERE slug = %s", (slug,))
    return {"ok": True}


@app.get("/api/admin/principals")
async def principals(request: Request, who: str = Depends(whoami)) -> dict[str, Any]:
    """Groups and users, for the audience picker on a custom tile.

    🔴 Read the schema comment on custom_tiles first. Choosing an audience here
    decides who is OFFERED a bookmark. It grants nothing and protects nothing.
    Anything that genuinely needs gating belongs in tools/pomerium/tiers.yaml,
    where the tile follows the access decision instead of being set beside it.

    Admin-only, because it lists every account in Authentik -- that is a
    directory, and a normal page load has no reason to hold one.
    """
    # Admins need it for a tile's audience; impersonators need it to choose a
    # subject. Same directory either way, so one gate covering both beats a
    # second endpoint returning the same rows.
    if not (await is_admin(request, who) or await may_impersonate(request, who)):
        raise HTTPException(
            403,
            f"listing groups and users needs '{ADMIN_GROUP}' or '{IMPERSONATE_GROUP}'")
    if not AUTHENTIK_TOKEN:
        raise HTTPException(503, "AUTHENTIK_TOKEN is not set; cannot list principals")
    headers = {"Authorization": f"Bearer {AUTHENTIK_TOKEN}"}
    async with httpx.AsyncClient(base_url=AUTHENTIK_URL, headers=headers, timeout=15) as client:
        g = await client.get("/api/v3/core/groups/",
                             params={"page_size": 200, "ordering": "name"})
        g.raise_for_status()
        u = await client.get("/api/v3/core/users/",
                             params={"page_size": 200, "ordering": "username",
                                     "is_active": "true"})
        u.raise_for_status()

    groups = [r["name"] for r in (g.json().get("results") or []) if r.get("name")]
    users = [
        {"email": (r.get("email") or "").lower(),
         "name": r.get("name") or r.get("username") or ""}
        # No email means nothing to match against: whoami() identifies people
        # by the email Pomerium puts in the header, so such an account could
        # never satisfy a user: entry and listing it would only mislead.
        for r in (u.json().get("results") or []) if r.get("email")
    ]
    # A CURATED list, when one has been saved. Authentik holds every account
    # and every group, most of which are noise in a "view as" picker --
    # service accounts, admin roles nothing is bound to. The site setting says
    # which are worth offering; absent, everything is offered, which is the
    # behaviour this started with and a sane default for a fresh install.
    #
    # `all_*` is always the full list, because the screen that EDITS the
    # curation needs to show what is available, not just what is already on.
    async with pool.connection() as conn:  # type: ignore[union-attr]
        row = await (await conn.execute(
            "SELECT value FROM site_settings WHERE key = %s", ("viewas_list",))).fetchone()
    picked = (row["value"] if row else None) or {}
    pg, pu = picked.get("groups"), picked.get("users")
    return {
        "groups": [g for g in groups if g in pg] if isinstance(pg, list) else groups,
        "users": [u for u in users if u["email"] in pu] if isinstance(pu, list) else users,
        "all_groups": groups,
        "all_users": users,
        "curated": isinstance(pg, list) or isinstance(pu, list),
    }


@app.get("/api/site")
async def get_site(_: str = Depends(whoami)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        rows = await (await conn.execute("SELECT key, value FROM site_settings")).fetchall()
        tpl = await default_template(conn)
    out = {r["key"]: r["value"] for r in rows}
    # ⚠️ Pre-template keys, moved to the default template; served from there
    # until the page reads them off /api/apps' `layout`.
    out["group_order"], out["group_hidden"] = tpl["group_order"], tpl["group_hidden"]
    return out


LAYOUT_SITE_KEYS = {"group_order": "group_order", "group_hidden": "group_hidden"}


@app.put("/api/site/{key}")
async def set_site(key: str, body: dict[str, Any], who: str = Depends(require_admin)) -> dict[str, Any]:
    if key in LAYOUT_SITE_KEYS:
        # ⚠️ Pre-template route: these belong to the default template now.
        try:
            groups = layouts.clean_groups(body.get("value"), key)
        except ValueError as exc:
            raise bad(exc) from None
        async with pool.connection() as conn:  # type: ignore[union-attr]
            tpl = (await default_template(conn))["id"]
            await conn.execute(f"UPDATE layouts SET {LAYOUT_SITE_KEYS[key]} = %s WHERE id = %s",
                               (json.dumps(groups), tpl))
            await touch(conn, tpl, who)
        return {"ok": True, "key": key}
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute(
            """INSERT INTO site_settings (key, value, updated_by) VALUES (%s, %s, %s)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                                               updated_by = EXCLUDED.updated_by,
                                               updated_at = now()""",
            (key, json.dumps(body.get("value")), who))
    return {"ok": True, "key": key}


# --- widgets (roadmap #34) ----------------------------------------------------
#
# Interface and permission model: widgets.py. Providers: providers.py.
#
# 🔴 ALWAYS THE REAL CALLER, NEVER AN IMPERSONATED SUBJECT. Impersonation shows
# whose TILES someone has; it must never become a way to read data from an app
# the caller cannot open. These routes take no as_user / as_group at all.

# Each user's reachable slugs, briefly cached: every widget refresh would
# otherwise be two Authentik calls. The cost is that a revoked application's
# widgets keep loading for up to this long -- the tile goes at once, the data
# within a minute. Failures are not cached (Cache.get re-raises).
ACCESS_TTL = 60
ACCESS = widgets.Cache()


async def reachable_slugs(who: str) -> set[str]:
    async def make() -> tuple[dict[str, Any], int]:
        apps = await authentik_apps(who)
        return {"slugs": sorted(a.get("slug") for a in apps if a.get("slug"))}, ACCESS_TTL
    got = await ACCESS.get("access\x00" + who, make)
    return set(got["slugs"])


async def viewer_groups(who: str) -> set[str]:
    """The viewer's Authentik groups, cached like their apps: for a widget
    read on their behalf (the combined week), which has no request headers."""
    async def make() -> tuple[dict[str, Any], int]:
        return {"groups": sorted(await user_groups(who))}, ACCESS_TTL
    got = await ACCESS.get("groups\x00" + who, make)
    return set(got["groups"])


async def resolve_source(ref: str, who: str) -> tuple[Any, dict[str, Any], int] | None:
    """widgets.SOURCES: another saved widget, as `who` may see it -- their own
    copy of that title first (a customized one), then the library's. None
    when there's no such widget or they may not see it."""
    ref = (ref or "").strip()
    if not ref:
        return None
    by_id = ref[1:].isdigit() and ref.startswith("#")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        rows = await (await conn.execute(
            "SELECT id, type, title, config, owner, audience FROM widget_defs"
            " WHERE (owner IS NULL OR owner = %s) AND " + ("id = %s" if by_id else "lower(title) = lower(%s)")
            + " ORDER BY (owner IS NULL), id", (who, int(ref[1:]) if by_id else ref))).fetchall()
    for r in rows:
        cls = widgets.REGISTRY.get(r["type"])
        if cls is None or cls.shape == "week":                 # no week inside a week
            continue
        if not may_see(cls, r, await reachable_slugs(who), await viewer_groups(who)):
            continue
        try:
            return cls, widgets.validate_config(cls, r["config"]), r["id"]
        except widgets.ConfigError:
            continue
    return None


widgets.SOURCES = resolve_source


@app.get("/api/widgets/types")
async def widget_types(request: Request, who: str = Depends(whoami)) -> dict[str, Any]:
    """The widget types this caller may add -- filtered, not merely flagged, so
    the list itself does not advertise apps someone cannot reach."""
    slugs = await reachable_slugs(who)
    admin = await is_admin(request, who)
    return {"types": [widgets.describe(cls) for cls in widgets.REGISTRY.values()
                      if widgets.visible(cls, slugs) and (admin or not cls.admin_only)]}


async def admin_only_gate(cls: Any, request: Request, who: str) -> None:
    if cls.admin_only and not await is_admin(request, who):
        raise HTTPException(403, f"only a nav administrator may set up a {cls.title or cls.type} widget")


@app.post("/api/widgets/preview")
async def widget_preview(body: dict[str, Any], request: Request,
                         who: str = Depends(whoami)) -> dict[str, Any]:
    """Data for an UNSAVED definition: {type, config}.

    The designer previews with this before saving, and until widgets are stored
    (step 3) it is the only data path. A provider failure is a 200 with `error`
    -- that is the tile's problem to show, not a failed request.
    """
    cls = widgets.REGISTRY.get(str(body.get("type", "")))
    if cls is None:
        raise HTTPException(404, f"no widget type {body.get('type')!r}")
    await admin_only_gate(cls, request, who)
    slugs = await reachable_slugs(who)
    if not widgets.visible(cls, slugs):
        raise HTTPException(403, widgets.forbidden(cls, {}))
    try:
        config = widgets.validate_config(cls, body.get("config"))
    except widgets.ConfigError as exc:
        raise HTTPException(400, str(exc)) from None
    if not widgets.allowed(cls, config, slugs):
        raise HTTPException(403, widgets.forbidden(cls, config))
    return await widgets.run(cls, config, who)


@app.post("/api/widgets/labels")
async def widget_labels(body: dict[str, Any], request: Request,
                        who: str = Depends(whoami)) -> dict[str, Any]:
    """Labels an UNSAVED definition's query returns, for the designer to offer
    as {{label}}. Same gate as preview. Uncached: it runs when someone asks."""
    cls = widgets.REGISTRY.get(str(body.get("type", "")))
    if cls is None:
        raise HTTPException(404, f"no widget type {body.get('type')!r}")
    await admin_only_gate(cls, request, who)
    slugs = await reachable_slugs(who)
    if not widgets.visible(cls, slugs):
        raise HTTPException(403, widgets.forbidden(cls, {}))
    try:
        config = widgets.validate_config(cls, body.get("config"))
    except widgets.ConfigError as exc:
        raise HTTPException(400, str(exc)) from None
    if not widgets.allowed(cls, config, slugs):
        raise HTTPException(403, widgets.forbidden(cls, config))
    try:
        return {"labels": await cls().labels(config, who)}
    except Exception as exc:  # noqa: BLE001 -- the designer shows it, like a preview error
        return {"labels": {}, "error": f"{type(exc).__name__}: {exc}"[:300]}


# --- saved widgets and their placements ----------------------------------------
#
# Reads are for everyone and filtered per viewer; writes are admin-only. A
# definition whose type is no longer registered (a provider removed in code)
# is kept and shown to admins as `missing`, so it can be deleted rather than
# vanishing with its placements still in the table.

def def_shape(cls: Any, config: dict[str, Any] | None) -> str:
    try:
        return cls.shape_for(config or {})
    except Exception:  # noqa: BLE001 -- a broken config still has the class's shape
        return cls.shape


def widget_row(r: dict[str, Any], admin: bool = False) -> dict[str, Any]:
    """The config goes to every viewer of the widget: it is the starting point
    for editing a placed widget in place, and says nothing preview would not
    -- a type the caller cannot see is never listed at all. The audience is
    an admin's business: group names are not every viewer's."""
    cls = widgets.REGISTRY.get(r["type"])
    out = {"id": r["id"], "type": r["type"], "title": r["title"], "config": r["config"],
           "shape": def_shape(cls, r["config"]) if cls else None, "missing": cls is None}
    if admin and r.get("owner") is None:
        out["audience"] = r.get("audience") or []
    return out


def may_see(cls: Any, r: dict[str, Any], slugs: set[str], groups: set[str]) -> bool:
    """A definition's data: the apps its config reads, or -- for a library
    widget only -- membership of the audience an admin gave it."""
    try:
        config = widgets.validate_config(cls, r["config"])
    except widgets.ConfigError:
        config = r["config"] or {}
    if widgets.allowed(cls, config, slugs):
        return True
    return r.get("owner") is None and widgets.in_audience(r.get("audience"), groups)


@app.get("/api/widgets")
async def list_widgets(request: Request, who: str = Depends(whoami),
                       layout: int | None = None) -> dict[str, Any]:
    """The library plus the caller's own definitions, and the placements of
    ONE layout (default: the default template), same as /api/apps."""
    admin = await is_admin(request, who)
    slugs = await reachable_slugs(who)
    groups = parse_groups(request.headers.get(GROUPS_HEADER, ""))
    async with pool.connection() as conn:  # type: ignore[union-attr]
        lay = await viewable_layout(conn, layout, who)
        defs = await (await conn.execute(
            "SELECT id, type, title, config, owner, audience FROM widget_defs "
            "WHERE owner IS NULL OR owner = %s ORDER BY title, id", (who,))).fetchall()
        places = await (await conn.execute(
            "SELECT id, def_id, category, ord, size, hidden, above_fold, x, y FROM widget_placements "
            "WHERE layout_id = %s ORDER BY category, ord, id", (lay["id"],))).fetchall()
    keep = []
    for r in defs:
        cls = widgets.REGISTRY.get(r["type"])
        if cls is None and not admin:
            continue
        if cls is not None and not may_see(cls, r, slugs, groups):
            # Not even listed: the definition's title alone can say what an
            # app holds ("Mom's audiobook queue").
            continue
        keep.append(widget_row(r, admin) | {"mine": r["owner"] is not None})
    ids = {d["id"] for d in keep}
    return {"defs": keep, "layout_id": lay["id"],
            "placements": [dict(p) for p in places if p["def_id"] in ids]}


async def stored_def(def_id: int, who: str | None = None) -> dict[str, Any]:
    """A definition the caller may use: the library's, or their own. Someone
    else's personal widget is a 404 -- not even its title is shared."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        r = await (await conn.execute(
            "SELECT id, type, title, config, owner, audience FROM widget_defs WHERE id = %s",
            (def_id,))).fetchone()
    if r is None or (r["owner"] is not None and r["owner"] != who):
        raise HTTPException(404, f"no widget {def_id}")
    return r


def acting_as(cls: Any, raw: Any) -> int | None:
    """`as` on a widget's data or action: an upstream person id, for a
    provider whose upstream checks the viewer may act as them (acts_as)."""
    if raw in (None, ""):
        return None
    if not cls.acts_as:
        raise HTTPException(400, f"{cls.type} can't act as someone else")
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise HTTPException(400, "as must be a person id") from None


@app.get("/api/widgets/{def_id}/data")
async def widget_data(def_id: int, request: Request, as_: str | None = Query(None, alias="as"),
                      who: str = Depends(whoami)) -> dict[str, Any]:
    r = await stored_def(def_id, who)
    cls = widgets.REGISTRY.get(r["type"])
    if cls is None:
        return {"type": r["type"], "shape": None,
                "error": f"widget type {r['type']!r} no longer exists"}
    groups = parse_groups(request.headers.get(GROUPS_HEADER, ""))
    if not may_see(cls, r, await reachable_slugs(who), groups):
        raise HTTPException(403, widgets.forbidden(cls, r["config"] or {}))
    try:
        config = widgets.validate_config(cls, r["config"])
    except widgets.ConfigError as exc:
        # A provider's schema changed under a saved definition. The tile says
        # so; a 400 would read as the PAGE asking for something wrong.
        return {"type": cls.type, "shape": def_shape(cls, r["config"]),
                "error": f"saved config is no longer valid: {exc}"}
    return await widgets.run(cls, config, who, as_=acting_as(cls, as_))


@app.post("/api/widgets/{def_id}/action")
async def widget_action(def_id: int, body: dict[str, Any], request: Request,
                        who: str = Depends(whoami)) -> dict[str, Any]:
    """Do something from a widget (a chore marked done, a swap approved), as
    the viewer. Same gate as reading it: if you can't see the widget, you
    can't act through it. The provider's upstream decides what the viewer is
    allowed to do; its refusal comes back as the error."""
    r = await stored_def(def_id, who)
    cls = widgets.REGISTRY.get(r["type"])
    if cls is None or not cls.actions:
        raise HTTPException(400, "this widget has no actions")
    groups = parse_groups(request.headers.get(GROUPS_HEADER, ""))
    if not may_see(cls, r, await reachable_slugs(who), groups):
        raise HTTPException(403, widgets.forbidden(cls, r["config"] or {}))
    action = str(body.get("action") or "")
    if action not in cls.actions:
        raise HTTPException(400, f"unknown action {action!r}")
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise HTTPException(400, "params must be an object")
    as_ = acting_as(cls, body.get("as"))
    if as_:
        print(f"impersonation: {who} acted as {r['type']} person {as_}: {action}", flush=True)
    try:
        config = widgets.validate_config(cls, r["config"])
        result = await (cls().act(config, who, action, params, as_=as_) if as_
                        else cls().act(config, who, action, params))
    except widgets.ConfigError as exc:
        raise HTTPException(400, f"saved config is no longer valid: {exc}") from None
    except widgets.ActionError as exc:
        raise HTTPException(exc.status, exc.message) from None
    widgets.CACHE.forget(cls, config)
    return {"ok": True, "result": result}


async def checked_def(body: dict[str, Any], who: str,
                      request: Request) -> tuple[str, str, dict[str, Any]]:
    """Validate a definition the way preview does: the admin must be able to
    see the type, and the config must pass its schema."""
    cls = widgets.REGISTRY.get(str(body.get("type", "")))
    if cls is None:
        raise HTTPException(404, f"no widget type {body.get('type')!r}")
    await admin_only_gate(cls, request, who)
    slugs = await reachable_slugs(who)
    if not widgets.visible(cls, slugs):
        raise HTTPException(403, widgets.forbidden(cls, {}))
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(422, "a widget needs a name")
    try:
        config = widgets.validate_config(cls, body.get("config"))
    except widgets.ConfigError as exc:
        raise HTTPException(400, str(exc)) from None
    if not widgets.allowed(cls, config, slugs):
        raise HTTPException(403, widgets.forbidden(cls, config))
    return cls.type, title, config


def checked_audience(body: dict[str, Any]) -> list[str]:
    """Who sees this library widget's data without its app (widgets.py). An
    admin's call, made per widget and visible in the designer."""
    try:
        return widgets.clean_audience(body.get("audience"))
    except widgets.ConfigError as exc:
        raise HTTPException(400, str(exc)) from None


# --- app connections: upstream URLs and keys (creds.py) -------------------------
#
# Admin-only. A key goes in and never comes out: GET says whether one is set
# and its last four characters. Changing a connection empties the widget cache,
# so the next refresh uses it rather than serving the old answer for a ttl.

async def load_connections() -> None:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        rows = await (await conn.execute(
            "SELECT slug, url, public_url, secret, hint, label, auth, custom "
            "FROM app_connections")).fetchall()
    creds.STORED.clear()
    creds.STORED.update({r["slug"]: dict(r) for r in rows
                         if r["slug"] in creds.APPS or r["custom"]})


def known_app(slug: str) -> str:
    if not creds.exists(slug):
        raise HTTPException(404, f"no connection {slug!r}")
    return slug


@app.get("/api/admin/connections")
async def list_connections(_: str = Depends(require_admin)) -> dict[str, Any]:
    return {"can_store": creds.can_store(),
            "connections": [creds.describe(s) for s in creds.slugs()]}


@app.post("/api/admin/connections")
async def add_connection(body: dict[str, Any], who: str = Depends(require_admin)) -> dict[str, Any]:
    """A custom connection for remote widgets: {slug, label?, url, auth?, key?}."""
    try:
        slug = creds.clean_slug(body.get("slug"))
        url = creds.clean_url(body.get("url"), "url")
        if not url:
            raise creds.CredError("a custom connection needs a base URL")
        auth = creds.clean_auth(body.get("auth") or "bearer")
        label = str(body.get("label") or "").strip()[:60] or slug
        secret = hint = None
        if body.get("key"):
            k = creds.clean_key(body["key"])
            secret, hint = creds.seal(k), creds.hint(k)
    except creds.CredError as exc:
        raise HTTPException(422, str(exc)) from None
    if creds.exists(slug):
        raise HTTPException(409, f"connection {slug!r} already exists")
    if sum(1 for r in creds.STORED.values() if r.get("custom")) >= creds.CUSTOM_MAX:
        raise HTTPException(422, f"at most {creds.CUSTOM_MAX} custom connections")
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute(
            "INSERT INTO app_connections (slug, url, secret, hint, label, auth, custom, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, true, %s)", (slug, url, secret, hint, label, auth, who))
    await load_connections()
    print(f"connection: {who} added {slug}", flush=True)
    return {"ok": True, "connection": creds.describe(slug)}


@app.delete("/api/admin/connections/{slug}")
async def delete_connection(slug: str, who: str = Depends(require_admin)) -> dict[str, Any]:
    """A custom connection goes; a built-in goes back to env vars and defaults."""
    known_app(slug)
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute("DELETE FROM app_connections WHERE slug = %s", (slug,))
    await load_connections()
    widgets.CACHE.entries.clear()
    print(f"connection: {who} removed {slug}", flush=True)
    return {"ok": True}


@app.put("/api/admin/connections/{slug}")
async def save_connection(slug: str, body: dict[str, Any],
                          who: str = Depends(require_admin)) -> dict[str, Any]:
    """{url?, public_url?, key?}: a field left out is unchanged; url or
    public_url "" goes back to the default; key "" removes the stored key."""
    known_app(slug)
    row = dict(creds.STORED.get(slug) or {})
    custom = slug not in creds.APPS
    try:
        for f in ("url", "public_url"):
            if f in body:
                row[f] = creds.clean_url(body[f], f)
        if custom and not row.get("url"):
            raise creds.CredError("a custom connection needs a base URL")
        if custom and "auth" in body:
            row["auth"] = creds.clean_auth(body["auth"])
        if custom and "label" in body:
            row["label"] = str(body["label"] or "").strip()[:60] or slug
        if "key" in body:
            if body["key"] in (None, ""):
                row["secret"], row["hint"] = None, None
            else:
                k = creds.clean_key(body["key"])
                row["secret"], row["hint"] = creds.seal(k), creds.hint(k)
    except creds.CredError as exc:
        raise HTTPException(422, str(exc)) from None
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute(
            "INSERT INTO app_connections (slug, url, public_url, secret, hint, label, auth, custom, "
            "updated_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (slug) DO UPDATE SET "
            "url = EXCLUDED.url, public_url = EXCLUDED.public_url, secret = EXCLUDED.secret, "
            "hint = EXCLUDED.hint, label = EXCLUDED.label, auth = EXCLUDED.auth, "
            "updated_by = EXCLUDED.updated_by, updated_at = now()",
            (slug, row.get("url"), row.get("public_url"), row.get("secret"), row.get("hint"),
             row.get("label"), row.get("auth"), custom, who))
    await load_connections()
    widgets.CACHE.entries.clear()
    print(f"connection: {who} changed {slug} ({', '.join(sorted(body))})", flush=True)
    return {"ok": True, "connection": creds.describe(slug)}


@app.post("/api/admin/connections/{slug}/test")
async def test_connection(slug: str, _: str = Depends(require_admin)) -> dict[str, Any]:
    """One cheap authenticated call with what is saved. The answer is a
    result, not a status code: a refused key is a 200 saying so."""
    known_app(slug)
    url, key, _pub = creds.resolve(slug)
    if not key:
        return {"ok": False, "detail": "no key set"}
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            test = creds.APPS[slug]["test"] if slug in creds.APPS else ""
            r = await client.get(url + test, headers=creds.headers(slug, key), params=creds.params(slug, key))
    except httpx.HTTPError as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: cannot reach {url}"}
    if r.status_code in (401, 403):
        return {"ok": False, "detail": f"HTTP {r.status_code}: the key was refused"}
    if r.status_code >= 400:
        return {"ok": False, "detail": f"HTTP {r.status_code} from {url}"}
    return {"ok": True, "detail": f"connected to {url}"}


@app.post("/api/admin/widgets")
async def create_widget(body: dict[str, Any], request: Request,
                        who: str = Depends(require_admin)) -> dict[str, Any]:
    wtype, title, config = await checked_def(body, who, request)
    audience = checked_audience(body)
    async with pool.connection() as conn:  # type: ignore[union-attr]
        r = await (await conn.execute(
            "INSERT INTO widget_defs (type, title, config, audience, updated_by) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (wtype, title, json.dumps(config), audience, who))).fetchone()
    return {"ok": True, "id": r["id"]}


@app.put("/api/admin/widgets/{def_id}")
async def update_widget(def_id: int, body: dict[str, Any], request: Request,
                        who: str = Depends(require_admin)) -> dict[str, Any]:
    await stored_def(def_id)       # the library's: a personal one is a 404 here
    wtype, title, config = await checked_def(body, who, request)
    audience = checked_audience(body)
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute(
            "UPDATE widget_defs SET type = %s, title = %s, config = %s, audience = %s, "
            "updated_by = %s, updated_at = now() WHERE id = %s",
            (wtype, title, json.dumps(config), audience, who, def_id))
    return {"ok": True, "id": def_id}


@app.delete("/api/admin/widgets/{def_id}")
async def delete_widget(def_id: int, _: str = Depends(require_admin)) -> dict[str, Any]:
    """A library widget, and so every placement of it -- in every template
    AND every dashboard that copied it."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute("DELETE FROM widget_defs WHERE id = %s AND owner IS NULL", (def_id,))
    return {"ok": True}


# --- personal widgets: the caller's own definitions ------------------------------
#
# The same validation as the library's (checked_def): a type the caller cannot
# see is refused, so a personal widget never shows more than preview already
# would. Placeable only on the owner's dashboards (add_placement refuses a
# template), and invisible to everyone else (stored_def).

PERSONAL_MAX = 50


async def own_def(conn: Any, def_id: int, who: str) -> None:
    r = await (await conn.execute(
        "SELECT owner FROM widget_defs WHERE id = %s", (def_id,))).fetchone()
    if r is None or r["owner"] != who:
        raise HTTPException(404, f"no widget {def_id} of yours")


async def personal_room(conn: Any, who: str) -> None:
    n = await (await conn.execute(
        "SELECT count(*) AS n FROM widget_defs WHERE owner = %s", (who,))).fetchone()
    if n["n"] >= PERSONAL_MAX:
        raise HTTPException(422, f"at most {PERSONAL_MAX} widgets of your own")


async def insert_personal(conn: Any, who: str, wtype: str, title: str,
                          config: dict[str, Any]) -> int:
    await personal_room(conn, who)
    r = await (await conn.execute(
        "INSERT INTO widget_defs (type, title, config, owner, updated_by) "
        "VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (wtype, title, json.dumps(config), who, who))).fetchone()
    return r["id"]


@app.post("/api/widgets")
async def create_personal(body: dict[str, Any], request: Request,
                          who: str = Depends(whoami)) -> dict[str, Any]:
    wtype, title, config = await checked_def(body, who, request)
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            did = await insert_personal(conn, who, wtype, title, config)
    return {"ok": True, "id": did}


@app.put("/api/layouts/{lid}/placements/{pid}/widget")
async def edit_placed_widget(lid: int, pid: int, body: dict[str, Any], request: Request,
                             who: str = Depends(whoami)) -> dict[str, Any]:
    """Edit ONE placed widget on your dashboard, `{title, config}` (the type is
    the placed widget's). Your own widget placed nowhere else is edited in
    place; a library widget, or yours placed elsewhere too, becomes a new
    widget of yours for this placement only -- group, order and size kept, and
    every other placement keeps what it showed."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            lay = await writable_layout(conn, request, who, lid)
            if lay["kind"] != "dashboard":
                raise HTTPException(422, "a template's widgets are edited in the library")
            row = await (await conn.execute(
                "SELECT p.def_id, d.type, d.owner FROM widget_placements p "
                "JOIN widget_defs d ON d.id = p.def_id WHERE p.id = %s AND p.layout_id = %s",
                (pid, lid))).fetchone()
            if row is None or (row["owner"] is not None and row["owner"] != who):
                raise HTTPException(404, f"no placement {pid} in layout {lid}")
            wtype, title, config = await checked_def({**body, "type": row["type"]}, who, request)
            others = await (await conn.execute(
                "SELECT count(*) AS n FROM widget_placements WHERE def_id = %s AND id <> %s",
                (row["def_id"], pid))).fetchone()
            if row["owner"] == who and others["n"] == 0:
                did = row["def_id"]
                await conn.execute(
                    "UPDATE widget_defs SET title = %s, config = %s, updated_by = %s, "
                    "updated_at = now() WHERE id = %s", (title, json.dumps(config), who, did))
            else:
                did = await insert_personal(conn, who, wtype, title, config)
                await conn.execute("UPDATE widget_placements SET def_id = %s WHERE id = %s",
                                   (did, pid))
            await touch(conn, lid, who)
    return {"ok": True, "id": pid, "def_id": did, "copied": did != row["def_id"]}


@app.put("/api/widgets/{def_id}")
async def update_personal(def_id: int, body: dict[str, Any], request: Request,
                          who: str = Depends(whoami)) -> dict[str, Any]:
    wtype, title, config = await checked_def(body, who, request)
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await own_def(conn, def_id, who)
        await conn.execute(
            "UPDATE widget_defs SET type = %s, title = %s, config = %s, updated_by = %s, "
            "updated_at = now() WHERE id = %s AND owner = %s",
            (wtype, title, json.dumps(config), who, def_id, who))
    return {"ok": True, "id": def_id}


@app.delete("/api/widgets/{def_id}")
async def delete_personal(def_id: int, who: str = Depends(whoami)) -> dict[str, Any]:
    """And its placements, in every one of the owner's dashboards."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await own_def(conn, def_id, who)
        await conn.execute("DELETE FROM widget_defs WHERE id = %s AND owner = %s", (def_id, who))
    return {"ok": True}


# ⚠️ Pre-template placement routes (see save_override): the default template.

@app.post("/api/admin/widgets/{def_id}/placements")
async def place_widget(def_id: int, body: dict[str, Any],
                       who: str = Depends(require_admin)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            pid = await add_placement(conn, await default_template(conn), def_id, body, who)
    return {"ok": True, "id": pid}


@app.put("/api/admin/widget-placements/{pid}")
async def update_placement(pid: int, body: dict[str, Any],
                           _: str = Depends(require_admin)) -> dict[str, Any]:
    """Resize (`size`) or move to another group (`category`)."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await edit_placement(conn, None, pid, body)
    return {"ok": True, "id": pid}


@app.put("/api/admin/layout")
async def set_layout(body: dict[str, Any], who: str = Depends(require_admin)) -> dict[str, Any]:
    """One group's order in the default template; see /api/layouts/{id}/order."""
    async with pool.connection() as conn:  # type: ignore[union-attr]
        async with conn.transaction():
            tpl = (await default_template(conn))["id"]
            await put_order(conn, tpl, str(body.get("category") or "").strip(), body.get("items"))
            await touch(conn, tpl, who)
    return {"ok": True, "count": len(body.get("items") or [])}


@app.delete("/api/admin/widget-placements/{pid}")
async def unplace_widget(pid: int, _: str = Depends(require_admin)) -> dict[str, Any]:
    async with pool.connection() as conn:  # type: ignore[union-attr]
        await conn.execute("DELETE FROM widget_placements WHERE id = %s", (pid,))
    return {"ok": True}



# --- the page ------------------------------------------------------------------
#
# One image serves the API and the page, so the two can never be from
# different versions (they were, as two deployments: a new script inside an old
# page broke the dashboard on 2026-10-10). Declared LAST: the catch-all below
# must not shadow an /api route.
#
#   /static/index.html  the page (ui/index.html); every other path that is not
#                       /api, /static or /icons gets it too
#   /static/<file>      its CSS and scripts (ui/static/); a missing file is a
#                       404, never the page -- a <script> handed HTML fails as a
#                       baffling syntax error
#   /icons/<file>       app icons, from NAV_ICONS_DIR (the deployment mounts its
#                       own; none is bundled)
#
# Everything is no-cache: revalidated on every load (cheap, by ETag), so after
# a rollout a browser never mixes a cached old script with a new page.
from pathlib import Path

from fastapi.responses import FileResponse

_HERE = Path(__file__).resolve().parent
UI_DIR = Path(os.environ.get("NAV_UI_DIR") or next(
    (p for p in (_HERE / "ui", _HERE.parent / "ui") if p.is_dir()), _HERE / "ui"))
ICONS_DIR = Path(os.environ.get("NAV_ICONS_DIR", "/app/icons"))
NO_CACHE = {"Cache-Control": "no-cache"}


def _file_in(base: Path, rel: str) -> Path:
    """`rel` inside `base`, or 404 -- never a path that climbs out of it."""
    p = (base / rel).resolve()
    if not p.is_relative_to(base.resolve()) or not p.is_file():
        raise HTTPException(404, "not found")
    return p


def _page() -> FileResponse:
    return FileResponse(_file_in(UI_DIR, "index.html"), headers=NO_CACHE)


@app.get("/static/{rel:path}", include_in_schema=False)
async def static_file(rel: str) -> FileResponse:
    if rel == "index.html":
        return _page()
    return FileResponse(_file_in(UI_DIR / "static", rel), headers=NO_CACHE)


@app.get("/icons/{rel:path}", include_in_schema=False)
async def icon_file(rel: str) -> FileResponse:
    return FileResponse(_file_in(ICONS_DIR, rel), headers={"Cache-Control": "public, max-age=3600"})


@app.get("/{rest:path}", include_in_schema=False)
async def page(rest: str) -> FileResponse:
    if rest == "api" or rest.startswith("api/"):
        raise HTTPException(404, f"no API route /{rest}")
    return _page()
