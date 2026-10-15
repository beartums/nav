"""App connections: where each upstream lives and the key it wants, kept in
nav's database so running nav needs no cluster secrets per app.

🔴 KEYS ARE ENCRYPTED AT REST, AND WRITE-ONLY
  Each key is sealed with Fernet (AES-128-CBC + HMAC-SHA256) under a key
  derived from NAV_SECRET_KEY, which lives OUTSIDE the database (an env var).
  A database dump, a backup, or a read-only SQL session therefore holds only
  ciphertext. The API never returns a key -- only that one is set and its
  last four characters, to tell two keys apart.

  Without NAV_SECRET_KEY nothing is stored: a key typed into the UI is refused
  rather than written in the clear. Change NAV_SECRET_KEY and the stored keys
  no longer open; they read as "cannot be decrypted -- enter it again", never
  as a crash.

CUSTOM CONNECTIONS (for remote widgets, docs/widgets.md): an admin adds a
slug, label, base URL and auth style. A remote widget names one, and its key
is sent ONLY to URLs under that connection's base URL -- so a widget pointed
elsewhere cannot carry the key off with it.

PRECEDENCE (built-ins): the database, then NAV_<APP>_URL / NAV_<APP>_KEY env vars (the
pre-UI way, kept for deployments that prefer them), then the defaults below.

Standard library only at import (CI runs these tests without pip): the
`cryptography` import is inside seal()/unseal().
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
from typing import Any
from urllib.parse import urlsplit

# What each connection is for, how it authenticates, and a cheap call that
# proves the URL and key work. Defaults are this estate's in-cluster services;
# another deployment sets its own URLs in the UI.
# Where apps live for people: a built-in app's link defaults to
# https://<slug>.<NAV_APP_DOMAIN> unless NAV_<APP>_PUBLIC or the stored
# connection says otherwise. Unset: links fall back to the upstream URL.
APP_DOMAIN = os.environ.get("NAV_APP_DOMAIN", "").strip().strip(".")

APPS: dict[str, dict[str, Any]] = {
    "sonarr": {"label": "Sonarr", "auth": "x-api-key", "test": "/api/v3/system/status",
               "url": "http://sonarr.media.svc.cluster.local:8989"},
    "radarr": {"label": "Radarr", "auth": "x-api-key", "test": "/api/v3/system/status",
               "url": "http://radarr.media.svc.cluster.local:7878"},
    "lidarr": {"label": "Lidarr", "auth": "x-api-key", "test": "/api/v1/system/status",
               "url": "http://lidarr.media.svc.cluster.local:8686"},
    "seerr": {"label": "Seerr", "auth": "x-api-key", "test": "/api/v1/request/count",
              "url": "http://seerr.media.svc.cluster.local:5055"},
    "mealie": {"label": "Mealie", "auth": "bearer", "test": "/api/users/self",
               "url": "http://mealie.mealie.svc.cluster.local:9000"},
    # A long-lived token from Donetick's Settings -> API tokens, sent in a
    # header literally named `secretkey` (internal/auth/api_middleware.go).
    "donetick": {"label": "Donetick", "auth": "header:secretkey", "test": "/eapi/v1/circle/members",
                 "url": "http://donetick.tools.svc.cluster.local"},
    # A choreboard API token (Choreboard -> /docs -> POST /api/tokens, scope
    # "read"), sent as a bearer token. github.com/beartums/choreboard
    "choreboard": {"label": "Choreboard", "auth": "bearer", "test": "/api/me",
                   "url": "http://choreboard.tools.svc.cluster.local"},
}

# slug -> {url, public_url, secret (sealed), hint, label, auth, custom}; loaded from the database
# at start and after every write (app.py). One replica, so one copy.
STORED: dict[str, dict[str, Any]] = {}

KEY_MAX = 512
AUTH_STYLES = ("bearer", "x-api-key")   # or "header:<Name>"
HEADER = re.compile(r"^header:([A-Za-z0-9-]{1,64})$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
CUSTOM_MAX = 50


class CredError(ValueError):
    """Bad input, or a key that cannot be stored: a 4xx, not a crash."""


def _fernet() -> Any:
    raw = os.environ.get("NAV_SECRET_KEY", "")
    if not raw:
        return None
    from cryptography.fernet import Fernet
    # Any passphrase works: hashed to the 32 bytes Fernet wants.
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest()))


def can_store() -> bool:
    return bool(os.environ.get("NAV_SECRET_KEY"))


def seal(plain: str) -> str:
    f = _fernet()
    if f is None:
        raise CredError("NAV_SECRET_KEY is not set, so keys cannot be stored safely; "
                        "set it on nav-api, or use NAV_<APP>_KEY env vars")
    return f.encrypt(plain.encode()).decode()


def unseal(token: str | None) -> str | None:
    """The key, or None when there is none or it no longer opens."""
    if not token:
        return None
    f = _fernet()
    if f is None:
        return None
    from cryptography.fernet import InvalidToken
    try:
        return f.decrypt(token.encode()).decode()
    except InvalidToken:
        return None


def hint(plain: str) -> str:
    return "…" + plain[-4:] if len(plain) >= 8 else "…"


def clean_url(raw: Any, field: str) -> str | None:
    """'' or None clears it (back to env/default); otherwise http(s) with a host."""
    if raw in (None, ""):
        return None
    if not isinstance(raw, str):
        raise CredError(f"{field} must be text")
    u = raw.strip().rstrip("/")
    parts = urlsplit(u)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise CredError(f"{field} must be an http(s) URL with a host")
    if parts.query or parts.fragment:
        raise CredError(f"{field} must not carry a query or fragment")
    return u


def clean_key(raw: Any) -> str:
    if not isinstance(raw, str):
        raise CredError("key must be text")
    k = raw.strip()
    if not k or len(k) > KEY_MAX or any(c.isspace() for c in k):
        raise CredError(f"key must be 1-{KEY_MAX} characters with no spaces")
    return k


def clean_slug(raw: Any) -> str:
    s = raw.strip().lower() if isinstance(raw, str) else ""
    if not SLUG.match(s):
        raise CredError("a connection name is 1-32 of a-z, 0-9 and -, starting with a letter or digit")
    if s in APPS:
        raise CredError(f"{s!r} is a built-in connection")
    return s


def clean_auth(raw: Any) -> str:
    a = raw.strip() if isinstance(raw, str) else ""
    if a in AUTH_STYLES or HEADER.match(a):
        return a
    raise CredError("auth must be bearer, x-api-key, or header:<Name>")


def exists(slug: str) -> bool:
    return slug in APPS or bool((STORED.get(slug) or {}).get("custom"))


def slugs() -> list[str]:
    return list(APPS) + sorted(s for s, r in STORED.items() if r.get("custom") and s not in APPS)


def key_ok_for(slug: str, url: str) -> bool:
    """Is `url` under the connection's base URL? The base ends at a path
    boundary: https://a.x/api does not cover https://a.x/apiary."""
    base = resolve(slug)[0]
    return url == base or url.startswith(base + "/") or url.startswith(base + "?")


def resolve(slug: str) -> tuple[str, str, str]:
    """(url, key, public_url) for a provider to call. Key '' when none."""
    row = STORED.get(slug) or {}
    if slug not in APPS:
        if not row.get("custom"):
            raise KeyError(slug)
        key = unseal(row.get("secret")) or ""
        url = (row.get("url") or "").rstrip("/")
        return url, key, (row.get("public_url") or url).rstrip("/")
    app = APPS[slug]
    up = slug.upper()
    url = row.get("url") or os.environ.get(f"NAV_{up}_URL") or app["url"]
    public = (row.get("public_url") or os.environ.get(f"NAV_{up}_PUBLIC")
              or (f"https://{slug}.{APP_DOMAIN}" if APP_DOMAIN else url))
    key = unseal(row.get("secret")) if row.get("secret") else None
    if key is None and not row.get("secret"):
        key = os.environ.get(f"NAV_{up}_KEY") or None
    return url.rstrip("/"), key or "", public.rstrip("/")


def auth_of(slug: str) -> str:
    return APPS[slug]["auth"] if slug in APPS else (STORED.get(slug) or {}).get("auth") or "bearer"


def headers(slug: str, key: str) -> dict[str, str]:
    auth = auth_of(slug)
    if auth == "bearer":
        return {"Authorization": f"Bearer {key}"}
    if auth == "x-api-key":
        return {"X-Api-Key": key}
    return {HEADER.match(auth).group(1): key}


def describe(slug: str) -> dict[str, Any]:
    """What the admin UI shows. NEVER the key."""
    row, up = STORED.get(slug) or {}, slug.upper()
    if slug not in APPS:
        state = ("stored" if unseal(row["secret"]) is not None else "unreadable") \
            if row.get("secret") else "none"
        url, _, public = resolve(slug)
        return {"slug": slug, "label": row.get("label") or slug, "custom": True,
                "auth": row.get("auth") or "bearer", "url": url, "public_url": public,
                "url_set": True, "public_set": bool(row.get("public_url")), "default_url": "",
                "key": state, "hint": row.get("hint") if state == "stored" else None}
    app = APPS[slug]
    if row.get("secret"):
        key_state = "stored" if unseal(row["secret"]) is not None else "unreadable"
    elif os.environ.get(f"NAV_{up}_KEY"):
        key_state = "env"
    else:
        key_state = "none"
    url, _, public = resolve(slug)
    return {"slug": slug, "label": app["label"], "custom": False, "auth": app["auth"],
            "url": url, "public_url": public,
            "url_set": bool(row.get("url")), "public_set": bool(row.get("public_url")),
            "default_url": app["url"], "key": key_state,
            "hint": row.get("hint") if key_state == "stored" else None}
