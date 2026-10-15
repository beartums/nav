"""The remote widget: a definition names a URL, nav-api GETs it, and the JSON
it returns is drawn by one of nav's shapes. The contract is docs/widgets.md.

STANDARD LIBRARY ONLY (CI runs these tests without pip); the HTTP is in
providers.py. These are the checks on both ends of that request.

🔴 ADMIN-ONLY TO SET UP (widgets.Provider.admin_only): nav-api fetches the URL
from inside the cluster, so whoever chooses it can make nav-api request any
internal address -- server-side request forgery. Viewing a placed remote
widget follows the usual gate (the definition's `app`, or its audience).
Redirects are not followed, for the same reason and so a key cannot be
bounced to another host.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit

MAX_BYTES = 1_000_000
TTL_MIN, TTL_MAX = 15, 3600
APP = re.compile(r"^(\*|[a-z0-9][a-z0-9_-]{0,63})$")


def clean_url(raw: str) -> str:
    u = (raw or "").strip()
    parts = urlsplit(u)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("the URL must be http(s) with a host")
    if parts.username or parts.password:
        raise ValueError("put credentials in a Connection, not in the URL")
    if parts.fragment:
        raise ValueError("the URL must not carry a #fragment")
    return u


def clean_app(raw: str) -> str:
    a = (raw or "").strip().lower()
    if not APP.match(a):
        raise ValueError("`app` is an Authentik application slug, or * for everyone signed in")
    return a


def ttl(raw: Any) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = 300
    return max(TTL_MIN, min(TTL_MAX, n))


def body(status: int, raw: bytes, truncated: bool) -> dict[str, Any]:
    """The widget's data from the reply, or the reason there is none. A JSON
    object with a string `error` is a deliberate error tile, at any status."""
    if truncated:
        raise ValueError(f"the reply is over {MAX_BYTES // 1000} kB")
    try:
        got = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, ValueError):
        got = None
    if isinstance(got, dict) and isinstance(got.get("error"), str):
        raise ValueError(got["error"][:300])
    if 300 <= status < 400:
        raise ValueError(f"HTTP {status}: redirects are not followed -- use the final URL")
    if status >= 400:
        raise ValueError(f"HTTP {status}")
    if got is None:
        raise ValueError("the reply is not JSON")
    if not isinstance(got, dict):
        raise ValueError("the reply must be a JSON object")
    return got
