"""App accounts: who has an account in each app, read from the app itself.

READ-ONLY. Each adapter lists one app's user accounts through that app's own
API, with the key from Connections (creds.py), and turns them into one shape:

  {login, email, name, role: "admin" | "user", disabled: bool, last_seen: str | None}

match() then lines them up against the people in Authentik (by email, then by
login against the Authentik username or the email's local part) and says, per
person and app, what is true:

  account     they have one (role, disabled, last seen)
  stale       they have one, but Authentik no longer lets them open the app
  missing     Authentik lets them open the app, but there is no account
              (for an app that makes accounts at first sign-in: "not signed in yet")
  (nothing)   neither

and lists ORPHANS: accounts that match no one.

The pure half (normalising, matching) is standard library only, like the rest
of nav's tested modules; the adapters' fetches import httpx when called.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

# How an app's accounts come to exist, which decides what "missing" means.
#   manual    an admin makes the account (missing = they can't use it yet)
#   first     made at first sign-in, OIDC or a trusted header (missing = not signed in yet)
PROVISION = ("manual", "first")


@dataclass(frozen=True)
class Adapter:
    key: str                 # our name for it
    label: str
    conn: str                # its Connections slug (creds.py): URL and key
    apps: tuple[str, ...]    # the Authentik application slug(s) that open it
    provision: str           # PROVISION
    fetch: Callable[[Any, str, str], Awaitable[list[dict[str, Any]]]]   # (client, base_url, key)
    note: str = ""           # what the key must be, for the Connections page


ADAPTERS: dict[str, Adapter] = {}


def adapter(a: Adapter) -> Adapter:
    if a.key in ADAPTERS or a.provision not in PROVISION:
        raise ValueError(f"adapter {a.key!r}: duplicate, or provision not in {PROVISION}")
    ADAPTERS[a.key] = a
    return a


def account(login: Any = None, email: Any = None, name: Any = None, admin: bool = False,
            disabled: bool = False, last_seen: Any = None) -> dict[str, Any]:
    """One account in the common shape."""
    def s(v: Any) -> str | None:
        v = str(v).strip() if v not in (None, "") else ""
        return v or None
    # An app that names its users by email (FileBrowser behind a proxy) and has no
    # email field: the login IS the email, so let it match as one.
    if not s(email) and "@" in (s(login) or ""):
        email = login
    return {"login": s(login), "email": (s(email) or "").lower() or None, "name": s(name),
            "role": "admin" if admin else "user", "disabled": bool(disabled), "last_seen": s(last_seen)}


def _keys(person: dict[str, Any]) -> tuple[set[str], set[str]]:
    email = (person.get("email") or "").strip().lower()
    logins = {x for x in ((person.get("username") or "").strip().lower(),
                          email.split("@")[0] if "@" in email else "") if x}
    return ({email} if email else set()), logins


def match(people: list[dict[str, Any]], found: dict[str, list[dict[str, Any]]],
          reach: dict[int, list[str]], adapters: dict[str, Adapter] | None = None) -> dict[str, Any]:
    """{people: {pk: {key: cell}}, orphans: {key: [account]}} for the apps in `found`.

    `people` are Authentik users ({pk, username, email}); `reach` is each one's
    Authentik application slugs. An email match wins over a login match, and an
    account is given to one person at most."""
    adapters = adapters or ADAPTERS
    out: dict[int, dict[str, Any]] = {p["pk"]: {} for p in people}
    orphans: dict[str, list[dict[str, Any]]] = {}
    for key, accounts in found.items():
        ad = adapters[key]
        taken: set[int] = set()
        by_person: dict[int, dict[str, Any]] = {}
        # Two passes: every email match first, so a login match can't steal one.
        for pass_ in ("email", "login"):
            for i, acc in enumerate(accounts):
                if i in taken:
                    continue
                for p in people:
                    if p["pk"] in by_person:
                        continue
                    emails, logins = _keys(p)
                    if pass_ == "email":
                        hit = bool(acc["email"]) and acc["email"] in emails
                    else:
                        hit = bool(acc["login"]) and acc["login"].lower() in logins
                    if hit:
                        by_person[p["pk"]] = acc
                        taken.add(i)
                        break
        orphans[key] = [a for i, a in enumerate(accounts) if i not in taken]
        for p in people:
            can = any(s in (reach.get(p["pk"]) or []) for s in ad.apps)
            acc = by_person.get(p["pk"])
            if acc:
                out[p["pk"]][key] = {"status": "account" if can else "stale", "role": acc["role"],
                                     "disabled": acc["disabled"], "last_seen": acc["last_seen"],
                                     "login": acc["login"]}
            elif can:
                out[p["pk"]][key] = {"status": "missing", "provision": ad.provision}
    return {"people": out, "orphans": orphans}


# --- the adapters -------------------------------------------------------------------
# Each: the app's own "list users" call, read-only, with the Connections key.
# Field names are the app's; account() maps them to the common shape.

async def _choreboard(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # GET /api/people: active people (choreboard/service.py people()).
    r = await client.get(base + "/api/people", headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    return [account(login=p.get("name"), email=p.get("email"), name=p.get("name"),
                    admin=p.get("role") == "admin", disabled=not p.get("active", 1)) for p in r.json()]


adapter(Adapter("choreboard", "Choreboard", "choreboard", ("choreboard",), "manual", _choreboard,
                "a choreboard API token (read scope is enough)"))


def _iso_ms(ms: Any) -> str | None:
    """Epoch milliseconds (Audiobookshelf) as ISO-8601 UTC."""
    import datetime
    if not isinstance(ms, (int, float)) or ms <= 0:
        return None
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).isoformat(timespec="seconds")


def _recent(ts: Any, years: int = 5) -> str | None:
    """A timestamp as ISO-8601, or None when it is a "never" sentinel (Grafana:
    creation minus 10 years). Fractions are dropped (Jellyfin sends 7 digits)."""
    import datetime
    import re
    if not ts:
        return None
    try:
        when = datetime.datetime.fromisoformat(re.sub(r"\.\d+", "", str(ts).replace("Z", "+00:00")))
    except ValueError:
        return str(ts)
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    if (datetime.datetime.now(datetime.timezone.utc) - when).days > years * 365:
        return None
    return when.isoformat(timespec="seconds")


async def _mealie(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # mealie/routes/admin/admin_management_users.py: admin token; perPage=-1 is all. camelCase keys.
    r = await client.get(base + "/api/admin/users", params={"page": 1, "perPage": -1},
                         headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    return [account(login=u.get("username"), email=u.get("email"), name=u.get("fullName"),
                    admin=bool(u.get("admin"))) for u in r.json()["items"]]


async def _seerr(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # server/routes/user/index.ts: default take is 10, so page; admin is permissions & 2.
    out, skip = [], 0
    while True:
        r = await client.get(base + "/api/v1/user", params={"take": 100, "skip": skip},
                             headers={"X-Api-Key": key})
        r.raise_for_status()
        j = r.json()
        for u in j.get("results") or []:
            login = u.get("username") or u.get("plexUsername") or u.get("jellyfinUsername")
            out.append(account(login=login, email=u.get("email"), name=u.get("displayName"),
                               admin=u.get("id") == 1 or bool(int(u.get("permissions") or 0) & 2)))
        skip += 100
        if skip >= int((j.get("pageInfo") or {}).get("results") or 0) or not j.get("results"):
            return out


async def _jellyfin(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # UserController.cs: GET /Users, all at once. ?ApiKey= is accepted without legacy auth.
    r = await client.get(base + "/Users", params={"ApiKey": key})
    r.raise_for_status()
    return [account(login=u.get("Name"), admin=(u.get("Policy") or {}).get("IsAdministrator", False),
                    disabled=(u.get("Policy") or {}).get("IsDisabled", False),
                    last_seen=_recent(u.get("LastActivityDate") or u.get("LastLoginDate"))) for u in r.json()]


PLEX_TV = "https://plex.tv"


async def _plex(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # `base` is the LOCAL server: its /identity gives the machine id. The owner
    # and the people it is shared with come from plex.tv (the same token);
    # /api/users is XML whatever Accept says, and is the owner's whole friends
    # list, so keep those sharing THIS server (as Seerr does).
    import xml.etree.ElementTree as ET
    h = {"X-Plex-Token": key, "X-Plex-Client-Identifier": "nav", "X-Plex-Product": "nav", "Accept": "application/json"}
    ident = await client.get(base + "/identity", headers=h)
    ident.raise_for_status()
    try:
        machine = ident.json()["MediaContainer"]["machineIdentifier"]
    except ValueError:
        machine = ET.fromstring(ident.text).get("machineIdentifier")
    me = await client.get(PLEX_TV + "/users/account.json", headers=h)
    me.raise_for_status()
    o = me.json().get("user") or {}
    out = [account(login=o.get("username"), email=o.get("email"), name=o.get("title"), admin=True)]
    r = await client.get(PLEX_TV + "/api/users", headers=h)
    r.raise_for_status()
    for u in ET.fromstring(r.text).iter("User"):
        if machine and not any(s.get("machineIdentifier") == machine for s in u.iter("Server")):
            continue
        out.append(account(login=u.get("username") or u.get("title"), email=u.get("email"), name=u.get("title")))
    return out


async def _audiobookshelf(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # UserController.js: GET /api/users; the key's user must be root/admin. Each user
    # carries a legacy `token`: never kept, never logged.
    r = await client.get(base + "/api/users", headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    return [account(login=u.get("username"), email=u.get("email"), admin=u.get("type") in ("root", "admin"),
                    disabled=not u.get("isActive", True) or bool(u.get("isLocked")),
                    last_seen=_iso_ms(u.get("lastSeen"))) for u in r.json()["users"]]


async def _navidrome(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # No API keys: the "key" is an admin's "username:password", logged in per read.
    # The token goes in X-ND-Authorization, not Authorization (server/auth.go).
    user, _, password = key.partition(":")
    if not password:
        raise ValueError("the Navidrome key is an admin's username:password")
    lg = await client.post(base + "/auth/login", json={"username": user, "password": password})
    lg.raise_for_status()
    r = await client.get(base + "/api/user", headers={"X-ND-Authorization": f"Bearer {lg.json()['token']}"})
    r.raise_for_status()
    return [account(login=u.get("userName"), email=u.get("email"), name=u.get("name"), admin=bool(u.get("isAdmin")),
                    last_seen=u.get("lastAccessAt") or u.get("lastLoginAt")) for u in r.json()]


async def _immich(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # user-admin.controller.ts: GET /api/admin/users; the key needs adminUser.read. Email is the login.
    r = await client.get(base + "/api/admin/users", headers={"x-api-key": key})
    r.raise_for_status()
    return [account(login=u.get("email"), email=u.get("email"), name=u.get("name"), admin=bool(u.get("isAdmin")),
                    disabled=(u.get("status") or "active") != "active" or bool(u.get("deletedAt")))
            for u in r.json()]


async def _filebrowser(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # web/users.go: GET /api/users, everyone when the token's user (and the token) is admin.
    r = await client.get(base + "/api/users", headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    return [account(login=u.get("username"), admin=bool((u.get("permissions") or {}).get("admin")))
            for u in r.json()]


async def _grafana(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # org_users.go: GET /api/org/users, all; the service account needs org role Admin.
    r = await client.get(base + "/api/org/users", headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    return [account(login=u.get("login"), email=u.get("email"), name=u.get("name"), admin=u.get("role") == "Admin",
                    disabled=bool(u.get("isDisabled")), last_seen=_recent(u.get("lastSeenAt")))
            for u in r.json()]


async def _paperless(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # paperless/views.py: DRF token auth ("Token <key>"); page_size up to 100000.
    tok = key if key.lower().startswith("token ") else f"Token {key}"
    r = await client.get(base + "/api/users/", params={"page_size": 100000}, headers={"Authorization": tok})
    r.raise_for_status()
    return [account(login=u.get("username"), email=u.get("email"),
                    name=" ".join(x for x in (u.get("first_name"), u.get("last_name")) if x),
                    admin=bool(u.get("is_superuser")), disabled=not u.get("is_active", True))
            for u in r.json()["results"]]


async def _music_assistant(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # controllers/webserver/auth.py: command auth/users over POST /api; a long-lived
    # token (Bearer) of an admin. Service accounts aren't people: left out.
    r = await client.post(base + "/api", json={"command": "auth/users", "args": {}},
                          headers={"Authorization": f"Bearer {key}"})
    r.raise_for_status()
    return [account(login=u.get("username"), name=u.get("display_name"), admin=u.get("role") == "admin",
                    disabled=not u.get("enabled", True))
            for u in r.json() if u.get("role") != "service"]


async def _memos(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # user_service.proto: GET /api/users (26.x; /api/v1 is gone), admins only, paged.
    out: list[dict[str, Any]] = []
    token = ""
    for _ in range(50):
        params = {"pageSize": 1000, **({"pageToken": token} if token else {})}
        r = await client.get(base + "/api/users", params=params, headers={"Authorization": f"Bearer {key}"})
        r.raise_for_status()
        body = r.json()
        out += [account(login=u.get("username") or (u.get("name") or "").split("/")[-1], email=u.get("email"),
                        name=u.get("displayName"), admin=u.get("role") in ("ADMIN", "HOST"),
                        disabled=u.get("state") == "ARCHIVED") for u in body.get("users") or []]
        token = body.get("nextPageToken") or ""
        if not token:
            break
    return out


async def _aurral(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # routes/users.ts: GET /api/users (admin); the global API key acts as an admin.
    r = await client.get(base + "/api/users", headers={"X-Api-Key": key})
    r.raise_for_status()
    return [account(login=u.get("username"), admin=u.get("role") == "admin",
                    disabled=(u.get("status") or "active") != "active") for u in r.json()]


def _login(key: str, app: str) -> tuple[str, str]:
    user, _, password = key.partition(":")
    if not user or not password:
        raise ValueError(f"the {app} key is an admin's login:password ({app} has no API keys)")
    return user, password


AFFINE_USERS = ("query($skip:Int!){users(filter:{first:100,skip:$skip}){name email disabled features}}")


async def _affine(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # No API tokens: sign in (core/auth/controller.ts) and use the session cookie on
    # the admin-only GraphQL users query (core/user/resolver.ts).
    email, password = _login(key, "AFFiNE")
    lg = await client.post(base + "/api/auth/sign-in", json={"email": email, "password": password})
    lg.raise_for_status()
    cookie = "; ".join(f"{k}={v}" for k, v in lg.cookies.items())
    out: list[dict[str, Any]] = []
    for page in range(50):
        r = await client.post(base + "/graphql", json={"query": AFFINE_USERS, "variables": {"skip": page * 100}},
                              headers={"Cookie": cookie})
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise ValueError("AFFiNE: " + str(body["errors"][0].get("message", "query refused")))
        users = (body.get("data") or {}).get("users") or []
        out += [account(login=u.get("email"), email=u.get("email"), name=u.get("name"),
                        admin="administrator" in (u.get("features") or []), disabled=bool(u.get("disabled")))
                for u in users]
        if len(users) < 100:
            break
    return out


async def _pingvin(client: Any, base: str, key: str) -> list[dict[str, Any]]:
    # No API tokens, and the JWT is read from the access_token cookie only
    # (auth/strategy/jwt.strategy.ts); GET /api/users is admin-only.
    user, password = _login(key, "Pingvin")
    lg = await client.post(base + "/api/auth/signIn",
                           json={("email" if "@" in user else "username"): user, "password": password})
    lg.raise_for_status()
    tok = (lg.json() or {}).get("accessToken")
    if not tok:
        raise ValueError("Pingvin: no access token (is TOTP on for this admin?)")
    r = await client.get(base + "/api/users", headers={"Cookie": f"access_token={tok}"})
    r.raise_for_status()
    return [account(login=u.get("username"), email=u.get("email"), admin=bool(u.get("isAdmin"))) for u in r.json()]


adapter(Adapter("mealie", "Mealie", "mealie", ("mealie",), "first", _mealie,
                "an admin's API token (profile → API Tokens)"))
adapter(Adapter("seerr", "Seerr", "seerr", ("seerr",), "first", _seerr, "the API key (Settings → General)"))
adapter(Adapter("jellyseerr", "Jellyseerr", "jellyseerr", ("jellyseerr",), "first", _seerr,
                "the API key (Settings → General)"))
adapter(Adapter("jellyfin", "Jellyfin", "jellyfin", ("jellyfin",), "manual", _jellyfin,
                "an API key (Dashboard → API Keys)"))
adapter(Adapter("plex", "Plex", "plex", ("plex",), "manual", _plex,
                "the server owner's Plex token (address: the local Plex server)"))
adapter(Adapter("audiobookshelf", "Audiobookshelf", "audiobookshelf", ("audiobookshelf",), "manual",
                _audiobookshelf, "an API key made by an admin (Settings → API Keys)"))
adapter(Adapter("navidrome", "Navidrome", "navidrome", ("music",), "manual", _navidrome,
                "an admin's username:password (Navidrome has no API keys)"))
adapter(Adapter("immich", "Immich", "immich", ("immich",), "manual", _immich,
                "an admin's API key with adminUser.read"))
adapter(Adapter("filebrowser", "FileBrowser", "filebrowser", ("filebrowser",), "first", _filebrowser,
                "an admin's API token with admin checked"))
adapter(Adapter("grafana", "Grafana", "grafana", ("grafana",), "first", _grafana,
                "a service account token with org role Admin"))
adapter(Adapter("paperless", "Paperless", "paperless", ("paperless-ngx",), "first", _paperless,
                "a superuser's API token"))
adapter(Adapter("music-assistant", "Music Assistant", "music-assistant", ("speakers",), "manual", _music_assistant,
                "an admin's long-lived token (profile → long-lived tokens; it lasts a year)"))
adapter(Adapter("memos", "Memos", "memos", ("memos",), "first", _memos,
                "an admin's access token (Settings → Access Tokens)"))
adapter(Adapter("aurral", "Aurral", "aurral", ("aurral",), "first", _aurral,
                "the API key (Settings → General → API access)"))
adapter(Adapter("affine", "AFFiNE", "affine", ("affine",), "first", _affine,
                "an admin's email:password (AFFiNE has no API tokens; the account needs a password)"))
adapter(Adapter("pingvin", "Pingvin Share", "pingvin", ("share",), "manual", _pingvin,
                "an admin's username:password (Pingvin has no API tokens; no TOTP)"))
