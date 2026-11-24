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

# How a person signs in once past the gateway (the App accounts column headers).
#   header    the app trusts the gateway's identity header: no second login
#   oidc      the app's own "Sign in with <IdP>" button (or an automatic redirect)
#   own       the app's own username and password: a second login
#   plex      a plex.tv account
#   jellyfin  a Jellyfin account (Jellyseerr)
# The defaults below are how each app is usually wired here; a deployment
# sets its own with NAV_APP_SIGNIN="mealie=oidc,navidrome=header".
SIGNIN = ("header", "oidc", "own", "plex", "jellyfin")


@dataclass(frozen=True)
class Adapter:
    key: str                 # our name for it
    label: str
    conn: str                # its Connections slug (creds.py): URL and key
    apps: tuple[str, ...]    # the Authentik application slug(s) that open it
    provision: str           # PROVISION
    fetch: Callable[[Any, str, str], Awaitable[list[dict[str, Any]]]]   # (client, base_url, key)
    note: str = ""           # what the key must be, for the Connections page
    login: str = ""          # no API keys: the key is "<login>:<password>"; "username" or "email"
    signin: str = "own"      # SIGNIN


ADAPTERS: dict[str, Adapter] = {}


def adapter(a: Adapter) -> Adapter:
    if a.key in ADAPTERS or a.provision not in PROVISION or a.signin not in SIGNIN:
        raise ValueError(f"adapter {a.key!r}: duplicate, or provision/signin not in {PROVISION}/{SIGNIN}")
    ADAPTERS[a.key] = a
    return a


def account(login: Any = None, email: Any = None, name: Any = None, admin: bool = False,
            disabled: bool = False, last_seen: Any = None, note: str = "") -> dict[str, Any]:
    """One account in the common shape."""
    def s(v: Any) -> str | None:
        v = str(v).strip() if v not in (None, "") else ""
        return v or None
    # An app that names its users by email (FileBrowser behind a proxy) and has no
    # email field: the login IS the email, so let it match as one.
    if not s(email) and "@" in (s(login) or ""):
        email = login
    return {"login": s(login), "email": (s(email) or "").lower() or None, "name": s(name),
            "role": "admin" if admin else "user", "disabled": bool(disabled), "last_seen": s(last_seen)} \
        | ({"note": note} if note else {})


def acct_key(acc: dict[str, Any]) -> str:
    """One account's identity within its app, for a hand-made match."""
    return (acc.get("login") or acc.get("email") or acc.get("name") or "").strip().lower()


def _keys(person: dict[str, Any]) -> tuple[set[str], set[str], set[str]]:
    email = (person.get("email") or "").strip().lower()
    logins = {x for x in ((person.get("username") or "").strip().lower(),
                          email.split("@")[0] if "@" in email else "") if x}
    full = " ".join((person.get("name") or "").lower().split())
    names = {x for x in (full, full.split(" ")[0] if full else "") if x}
    return ({email} if email else set()), logins, names


def match(people: list[dict[str, Any]], found: dict[str, list[dict[str, Any]]],
          reach: dict[int, list[str]], adapters: dict[str, Adapter] | None = None,
          links: dict[str, dict[str, int]] | None = None) -> dict[str, Any]:
    """{people: {pk: {key: cell}}, orphans: {key: [account]}} for the apps in `found`.

    `people` are Authentik users ({pk, username, email}); `reach` is each one's
    Authentik application slugs. Email always first: every email match is made
    before any login match, and a name match (full or first name) is tried last,
    only for an account with no email at all (a Plex managed profile). `links`
    ({app: {acct_key: pk}}, matched by hand) come after all of those, for what is
    left. An account is given to one person at most."""
    adapters = adapters or ADAPTERS
    out: dict[int, dict[str, Any]] = {p["pk"]: {} for p in people}
    orphans: dict[str, list[dict[str, Any]]] = {}
    for key, accounts in found.items():
        ad = adapters[key]
        taken: set[int] = set()
        by_person: dict[int, dict[str, Any]] = {}
        # Every email match first, so a weaker match can't steal one.
        hand = (links or {}).get(key) or {}
        linked: set[int] = set()
        for pass_ in ("email", "login", "name", "link"):
            for i, acc in enumerate(accounts):
                if i in taken:
                    continue
                if pass_ == "link":
                    pk = hand.get(acct_key(acc))
                    if pk is not None and pk not in by_person and any(p["pk"] == pk for p in people):
                        by_person[pk] = acc
                        taken.add(i)
                        linked.add(pk)
                    continue
                for p in people:
                    if p["pk"] in by_person:
                        continue
                    emails, logins, names = _keys(p)
                    if pass_ == "email":
                        hit = bool(acc["email"]) and acc["email"] in emails
                    elif pass_ == "login":
                        hit = bool(acc["login"]) and acc["login"].lower() in logins
                    else:
                        nm = " ".join((acc.get("name") or acc["login"] or "").lower().split())
                        hit = not acc["email"] and bool(nm) and nm in names
                    if hit:
                        by_person[p["pk"]] = acc
                        taken.add(i)
                        break
        orphans[key] = [a | {"key": acct_key(a)} for i, a in enumerate(accounts) if i not in taken]
        for p in people:
            can = any(s in (reach.get(p["pk"]) or []) for s in ad.apps)
            acc = by_person.get(p["pk"])
            if acc:
                out[p["pk"]][key] = {"status": "account" if can else "stale", "role": acc["role"],
                                     "disabled": acc["disabled"], "last_seen": acc["last_seen"],
                                     "login": acc["login"]} | ({"note": acc["note"]} if acc.get("note") else {}) \
                    | ({"linked": acct_key(acc)} if p["pk"] in linked else {})
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


adapter(Adapter("choreboard", "Choreboard", "choreboard", ("choreboard",), "first", _choreboard,
                "a choreboard API token (read scope is enough)", signin="header"))


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
            kind = {1: "a Plex account", 2: "a local account (its own email and password)",
                    3: "a Jellyfin account", 4: "an Emby account"}.get(u.get("userType"))
            out.append(account(login=login, email=u.get("email"), name=u.get("displayName"),
                               admin=u.get("id") == 1 or bool(int(u.get("permissions") or 0) & 2),
                               note=kind or ""))
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
    # Plex Home: managed profiles (restricted, no plex.tv login of their own) aren't in
    # the friends list. Full Home members are, or are the owner; skip those already listed.
    seen = {(a["email"] or "", (a["login"] or "").lower()) for a in out}
    r = await client.get(PLEX_TV + "/api/home/users", headers=h)
    if r.status_code == 200:
        for u in ET.fromstring(r.text).iter("User"):
            if u.get("admin") == "1":
                continue
            email, login = (u.get("email") or "").lower(), (u.get("username") or u.get("title") or "")
            if (email, login.lower()) in seen:
                continue
            managed = u.get("restricted") == "1" and not email
            out.append(account(login=login, email=email or None, name=u.get("title"),
                               note="managed Plex Home profile (picked on a device signed in as the owner)"
                               if managed else "Plex Home member"))
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
                "an admin's API token (profile → API Tokens)", signin="header"))
adapter(Adapter("seerr", "Seerr", "seerr", ("seerr",), "first", _seerr, "the API key (Settings → General)", signin="plex"))
adapter(Adapter("jellyseerr", "Jellyseerr", "jellyseerr", ("jellyseerr",), "first", _seerr,
                "the API key (Settings → General)", signin="jellyfin"))
adapter(Adapter("jellyfin", "Jellyfin", "jellyfin", ("jellyfin",), "manual", _jellyfin,
                "an API key (Dashboard → API Keys)", signin="own"))
adapter(Adapter("plex", "Plex", "plex", ("plex",), "manual", _plex,
                "the server owner's Plex token (address: the local Plex server)", signin="plex"))
adapter(Adapter("audiobookshelf", "Audiobookshelf", "audiobookshelf", ("audiobookshelf",), "manual",
                _audiobookshelf, "an API key made by an admin (Settings → API Keys)", signin="oidc"))
adapter(Adapter("navidrome", "Navidrome", "navidrome", ("music",), "manual", _navidrome,
                "an admin's username:password (Navidrome has no API keys)", login="username", signin="own"))
adapter(Adapter("immich", "Immich", "immich", ("immich",), "manual", _immich,
                "an admin's API key with adminUser.read (and adminUser.create to make accounts)", signin="oidc"))
adapter(Adapter("filebrowser", "FileBrowser", "filebrowser", ("filebrowser",), "first", _filebrowser,
                "an admin's API token with admin checked", signin="header"))
adapter(Adapter("grafana", "Grafana", "grafana", ("grafana",), "first", _grafana,
                "a service account token with org role Admin", signin="oidc"))
adapter(Adapter("paperless", "Paperless", "paperless", ("paperless-ngx",), "first", _paperless,
                "a superuser's API token", signin="oidc"))
adapter(Adapter("music-assistant", "Music Assistant", "music-assistant", ("speakers",), "manual", _music_assistant,
                "an admin's long-lived token (profile → long-lived tokens; it lasts a year)", signin="own"))
adapter(Adapter("memos", "Memos", "memos", ("memos",), "first", _memos,
                "an admin's access token (Settings → Access Tokens)", signin="oidc"))
adapter(Adapter("aurral", "Aurral", "aurral", ("aurral",), "first", _aurral,
                "the API key (Settings → General → API access)", signin="oidc"))
adapter(Adapter("affine", "AFFiNE", "affine", ("affine",), "first", _affine,
                "an admin's email:password (AFFiNE has no API tokens; the account needs a password)", login="email", signin="oidc"))
adapter(Adapter("pingvin", "Pingvin Share", "pingvin", ("share",), "manual", _pingvin,
                "an admin's username:password (Pingvin has no API tokens; no TOTP)", login="username", signin="own"))


def signin_of(key: str, env: str = "") -> str:
    """An adapter's sign-in method, NAV_APP_SIGNIN ("key=method,...") first."""
    for part in env.split(","):
        k, _, v = part.strip().partition("=")
        if k.strip() == key and v.strip() in SIGNIN:
            return v.strip()
    return ADAPTERS[key].signin


# --- creating accounts (Access -> App accounts -> Create accounts...) -----------------
# One admin-API call per app, with the same Connections key that reads its accounts.
# An app can offer more than one way (a MODE): Plex invites or makes a managed
# profile; Seerr makes a local account or brings them in from Plex.
#   needs   "password"  the one password the admin types for this person, every app
#           "none"      nothing to type
#   login   what the account is named by: "username", "email" or "name"

@dataclass(frozen=True)
class Mode:
    id: str
    label: str
    needs: str
    login: str
    make: Callable[[Any, str, str, dict[str, Any], str], Awaitable[None]]   # (client, base, key, person, password)
    hint: str = ""


CREATORS: dict[str, list[Mode]] = {}
MIN_PASSWORD = 8


def creator(key: str, *modes: Mode) -> None:
    for m in modes:
        if key not in ADAPTERS or m.needs not in ("password", "none") or m.login not in ("username", "email", "name"):
            raise ValueError(f"creator {key!r}/{m.id}: unknown app, or needs/login not allowed")
    CREATORS[key] = list(modes)


def mode_of(key: str, mode: str) -> Mode | None:
    return next((m for m in CREATORS.get(key, []) if m.id == mode), None)


def creatable(key: str) -> list[dict[str, Any]] | None:
    ms = CREATORS.get(key)
    return [{"id": m.id, "label": m.label, "needs": m.needs, "login": m.login, "hint": m.hint} for m in ms] if ms else None


# The calls, from each app's source at the deployed release (2026-11-23). Every one
# makes an ordinary (non-admin) account; the person's name goes along where the app
# keeps one.

async def _make_jellyfin(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # UserController.CreateUserByName: POST /Users/New {Name, Password}; ?ApiKey= is an
    # administrator. New users see every library (EnableAllFolders) and are left off
    # the login screen's user list (IsHidden): they type their name.
    r = await client.post(base + "/Users/New", params={"ApiKey": key}, json={"Name": p["username"], "Password": pw})
    r.raise_for_status()


async def _make_navidrome(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # nativeapi: POST /api/user (admin); gets the libraries marked for new users.
    user, _, password = key.partition(":")
    lg = await client.post(base + "/auth/login", json={"username": user, "password": password})
    lg.raise_for_status()
    r = await client.post(base + "/api/user", headers={"X-ND-Authorization": f"Bearer {lg.json()['token']}"},
                          json={"userName": p["username"], "name": p["name"], "email": p["email"],
                                "password": pw, "isAdmin": False})
    r.raise_for_status()


async def _make_audiobookshelf(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # UserController.create: isActive defaults to FALSE (an inactive user can't sign
    # in), so it's sent. Authentik sign-in links by username: the Authentik one.
    r = await client.post(base + "/api/users", headers={"Authorization": f"Bearer {key}"},
                          json={"username": p["username"], "password": pw, "email": p["email"],
                                "type": "user", "isActive": True})
    r.raise_for_status()


async def _make_immich(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # user-admin.controller: POST /api/admin/users, key permission adminUser.create.
    # shouldChangePassword defaults to true; they sign in with Authentik anyway.
    r = await client.post(base + "/api/admin/users", headers={"x-api-key": key},
                          json={"email": p["email"], "name": p["name"], "password": pw,
                                "shouldChangePassword": False})
    r.raise_for_status()


async def _make_pingvin(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # user.controller: POST /api/users (admin). Usernames are 3-32 of [A-Za-z0-9_.].
    user, password = _login(key, "Pingvin")
    lg = await client.post(base + "/api/auth/signIn",
                           json={("email" if "@" in user else "username"): user, "password": password})
    lg.raise_for_status()
    tok = (lg.json() or {}).get("accessToken")
    if not tok:
        raise ValueError("Pingvin: no access token (is TOTP on for this admin?)")
    name = "".join(ch if ch.isalnum() or ch in "_." else "_" for ch in p["username"])
    r = await client.post(base + "/api/users", headers={"Cookie": f"access_token={tok}"},
                          json={"username": name, "email": p["email"], "password": pw, "isAdmin": False})
    r.raise_for_status()


async def _make_seerr(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # routes/user: POST /api/v1/user, a LOCAL account with Seerr's default permissions.
    # It signs in only while Seerr's local sign-in is on (Settings -> Users).
    r = await client.post(base + "/api/v1/user", headers={"X-Api-Key": key},
                          json={"email": p["email"], "username": p["username"], "password": pw})
    r.raise_for_status()


async def _make_music_assistant(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # webserver/auth.py: command auth/user/create (users.manage; an admin's token has it).
    r = await client.post(base + "/api", headers={"Authorization": f"Bearer {key}"},
                          json={"command": "auth/user/create",
                                "args": {"username": p["username"], "password": pw, "role": "user",
                                         "display_name": p["name"]}})
    r.raise_for_status()
    body = r.json()
    if isinstance(body, dict) and body.get("error_code"):
        raise ValueError(f"Music Assistant: {body.get('details') or body.get('error_code')}")


async def _plex_share(client: Any, base: str, key: str, shared: dict[str, str]) -> None:
    # python-plexapi inviteFriend / createHomeUser: POST plex.tv/api/servers/{machine}/shared_servers
    # with plex.tv's section ids (GET plex.tv/api/servers/{machine}, Section@id): every library.
    import xml.etree.ElementTree as ET
    h = _plex_headers(key)
    ident = await client.get(base + "/identity", headers=h)
    ident.raise_for_status()
    try:
        machine = ident.json()["MediaContainer"]["machineIdentifier"]
    except ValueError:
        machine = ET.fromstring(ident.text).get("machineIdentifier")
    srv = await client.get(f"{PLEX_TV}/api/servers/{machine}", headers=h)
    srv.raise_for_status()
    ids = [x.get("id") for x in ET.fromstring(srv.text).iter("Section") if x.get("id")]
    if not ids:
        raise ValueError("plex.tv lists no libraries for this server")
    r = await client.post(f"{PLEX_TV}/api/servers/{machine}/shared_servers", headers=h | {"Content-Type": "application/json"},
                          json={"server_id": machine, "shared_server": {"library_section_ids": ids} | shared,
                                "sharing_settings": {"allowSync": "0", "allowCameraUpload": "0", "allowChannels": "0",
                                                     "filterMovies": "", "filterTelevision": "", "filterMusic": ""}})
    r.raise_for_status()


def _plex_headers(key: str) -> dict[str, str]:
    return {"X-Plex-Token": key, "X-Plex-Client-Identifier": "nav", "X-Plex-Product": "nav", "Accept": "application/json"}


async def _make_plex(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # An invitation to their email; they accept with a plex.tv account.
    await _plex_share(client, base, key, {"invited_email": p["email"]})


async def _make_plex_managed(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # python-plexapi createHomeUser: POST plex.tv/api/home/users?title=<name> makes a managed
    # profile in the owner's Plex Home (XML, the new user's id), then the same share by id.
    import xml.etree.ElementTree as ET
    r = await client.post(f"{PLEX_TV}/api/home/users", params={"title": p["name"]}, headers=_plex_headers(key))
    r.raise_for_status()
    root = ET.fromstring(r.text)
    uid = root.get("id") or next((u.get("id") for u in root.iter("User") if u.get("id")), None)
    if not uid:
        raise ValueError("plex.tv made the profile but returned no id; share the libraries with it in Plex")
    await _plex_share(client, base, key, {"invited_id": uid})


async def _make_seerr_from_plex(client: Any, base: str, key: str, p: dict[str, Any], pw: str) -> None:
    # routes/settings: GET /api/v1/settings/plex/users lists the owner's Plex friends (with
    # email); routes/user import-from-plex {plexIds} makes them Plex users -- and turns a
    # LOCAL account with the same email into their Plex one.
    h = {"X-Api-Key": key}
    r = await client.get(base + "/api/v1/settings/plex/users", headers=h)
    r.raise_for_status()
    hit = next((u for u in r.json() if (u.get("email") or "").lower() == p["email"]), None)
    if not hit:
        raise ValueError("no Plex friend with that email: invite them to Plex and wait until they accept")
    r = await client.post(base + "/api/v1/user/import-from-plex", headers=h, json={"plexIds": [str(hit["id"])]})
    r.raise_for_status()


def _one(label: str, needs: str, login: str, make: Any, hint: str) -> Mode:
    return Mode("create", label, needs, login, make, hint)


creator("jellyfin", _one("Create", "password", "username", _make_jellyfin,
                         "every library; they type their username at sign-in"))
creator("navidrome", _one("Create", "password", "username", _make_navidrome,
                          "the libraries marked for new users"))
creator("audiobookshelf", _one("Create", "password", "username", _make_audiobookshelf,
                               "every library; Authentik sign-in links on this username"))
creator("immich", _one("Create", "password", "email", _make_immich,
                       "Authentik sign-in links on this email; the key needs adminUser.create"))
creator("pingvin", _one("Create", "password", "username", _make_pingvin,
                        "username letters, digits, _ and . only (others become _)"))
creator("music-assistant", _one("Create", "password", "username", _make_music_assistant, "an ordinary user"))
creator("seerr",
        Mode("local", "Local account", "password", "email", _make_seerr,
             "a Seerr account with its own password; needs Seerr's local sign-in on"),
        Mode("plex", "Plex sign-in", "none", "email", _make_seerr_from_plex,
             "brings their Plex account in (they sign in with Plex); they must already share your Plex server"))
creator("plex",
        Mode("invite", "Invite", "none", "email", _make_plex,
             "shares every library with their email; they accept with a plex.tv account"),
        Mode("managed", "Managed profile", "none", "name", _make_plex_managed,
             "a profile in your Plex Home with every library: picked on a device signed in as you, no login of its own"))
