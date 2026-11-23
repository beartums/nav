"""Add a person: the Authentik user, and how they will sign in.

The Access panel's "+ Add person". Authentik keeps USERS in its own database
(only group MEMBERSHIP is in Terraform, see access.py), so the user is created
here, now, through Authentik's API; the groups they join are then staged like
any other membership change and reach Authentik through the pull request.

Checked against Authentik 2026.8 (authentik/core/api/users.py):
  POST /api/v3/core/users/                    {username, name, email, is_active, path, type} -> 201 + pk
  GET  /api/v3/core/users/?username= / ?email=  exact filters (UsersFilter)
  POST /api/v3/core/users/{pk}/recovery/        -> {link}; 400 "No recovery flow set." when the
                                                brand has none. The link is built from the host the
                                                request came in on (in-cluster), so it is re-rooted
                                                on NAV_AUTHENTIK_PUBLIC_URL when that is set.
  POST /api/v3/core/users/{pk}/set_password/  {password} -> 204

Sign-in ways:
  google    nothing to set: an email-linked social login matches them by address
  link      a one-time set-your-own-password link (needs a recovery flow on the brand)
  password  a starting password nav generates and shows ONCE; they change it

Pure functions (validate, outside, password) import nothing outside the standard
library, so they test without a network.
"""
from __future__ import annotations

import os
import re
import secrets
import string
from typing import Any
from urllib.parse import urlsplit, urlunsplit

PUBLIC_URL = os.environ.get("NAV_AUTHENTIK_PUBLIC_URL", "").strip().rstrip("/")
HOME_DOMAIN = os.environ.get("NAV_HOME_EMAIL_DOMAIN", "").strip().lstrip("@").lower()
DEFAULT_GROUPS = [g.strip() for g in os.environ.get("NAV_NEW_PERSON_GROUPS", "family").split(",") if g.strip()]

SIGNIN = ("google", "link", "password")
USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
EMAIL = re.compile(r"^[^@\s\"<>,;]+@[^@\s\"<>,;]+\.[^@\s\"<>,;]+$")


def validate(body: dict[str, Any]) -> dict[str, Any]:
    """{username, name, email, signin, groups} from a form, or ValueError naming the field."""
    username = str(body.get("username") or "").strip()
    name = " ".join(str(body.get("name") or "").split())
    email = str(body.get("email") or "").strip()
    signin = str(body.get("signin") or "google")
    if not USERNAME.match(username):
        raise ValueError("username: lowercase letters, digits, '.', '_' or '-', 2 to 63 characters")
    if not name or len(name) > 120:
        raise ValueError("name: required, at most 120 characters")
    if not EMAIL.match(email) or len(email) > 254:
        raise ValueError("email: not an email address")
    if signin not in SIGNIN:
        raise ValueError(f"signin: one of {', '.join(SIGNIN)}")
    groups = body.get("groups")
    if groups is None:
        groups = list(DEFAULT_GROUPS)
    if not isinstance(groups, list) or not all(isinstance(g, str) for g in groups):
        raise ValueError("groups: a list of group names")
    return {"username": username, "name": name, "email": email, "signin": signin,
            "groups": list(dict.fromkeys(g.strip() for g in groups if g.strip()))}


def outside(email: str, home: str = HOME_DOMAIN) -> bool | None:
    """True when the address is outside the household's own domain (so the
    edge's email allow-list must name it); None when no home domain is set."""
    if not home:
        return None
    return not email.lower().endswith("@" + home)


def password(length: int = 16) -> str:
    """A starting password: letters and digits, no look-alikes, at least one of each kind."""
    alphabet = "".join(c for c in string.ascii_letters + string.digits if c not in "O0Il1")
    while True:
        p = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(c.islower() for c in p) and any(c.isupper() for c in p) and any(c.isdigit() for c in p):
            return p


def public_link(link: str, public: str = PUBLIC_URL) -> str:
    """Authentik builds the link from the host nav called it on (in-cluster):
    the same path and query on its public address."""
    if not public:
        return link
    p, q = urlsplit(public), urlsplit(link)
    return urlunsplit((p.scheme, p.netloc, q.path, q.query, q.fragment))


# --- Authentik ----------------------------------------------------------------
# `client` is an httpx.AsyncClient already pointed at Authentik with the token.

async def conflicts(client: Any, username: str, email: str) -> list[str]:
    """What already exists: ["username", "email"], or []. Inactive users count:
    a name in use can't be taken again."""
    out = []
    for field, value in (("username", username), ("email", email)):
        if not value:          # an empty filter is no filter: it would match everyone
            continue
        r = await client.get("/api/v3/core/users/", params={field: value, "page_size": 1})
        r.raise_for_status()
        if (r.json().get("pagination") or {}).get("count") or r.json().get("results"):
            out.append(field)
    return out


async def create(client: Any, p: dict[str, Any]) -> dict[str, Any]:
    """The new user (Authentik's answer, with its pk). Active, internal, under `users`."""
    r = await client.post("/api/v3/core/users/", json={
        "username": p["username"], "name": p["name"], "email": p["email"],
        "is_active": True, "path": "users", "type": "internal"})
    r.raise_for_status()
    user = r.json()
    if not isinstance(user.get("pk"), int):
        raise ValueError("Authentik's answer had no user id")
    return user


async def recovery_link(client: Any, pk: int) -> str:
    r = await client.post(f"/api/v3/core/users/{pk}/recovery/", json={})
    if r.status_code == 400:
        why = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        msg = " ".join(why.get("non_field_errors") or []) or r.text[:200]
        raise ValueError(f"Authentik made no link: {msg}")
    r.raise_for_status()
    return public_link(r.json()["link"])


async def set_password(client: Any, pk: int, pw: str) -> None:
    r = await client.post(f"/api/v3/core/users/{pk}/set_password/", json={"password": pw})
    if r.status_code != 204:
        raise ValueError(f"Authentik refused the password (HTTP {r.status_code})")
