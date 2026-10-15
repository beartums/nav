"""Widget providers: the server half of nav's widget interface (roadmap #34).

A widget is a PROVIDER (where the data comes from, in Python, here) drawn by a
RENDERER (how it looks, in the browser) chosen by the provider's SHAPE. Adding a
widget is one Provider subclass; the page only changes when a new shape does.

STANDARD LIBRARY ONLY, DELIBERATELY
  CI runs the unit tests without `pip install` (see .github/workflows/nav-api.yml),
  the same rule urls.py follows. Providers that need httpx live in providers.py,
  which app.py imports and this module never does.

🔴 `app` IS THE PERMISSION MODEL
  Every provider names the Authentik application whose data it shows, and a
  caller who cannot reach that application cannot list, preview or fetch the
  widget. Without it a widget leaks: Sonarr's queue to someone who cannot open
  Sonarr. There is no second ACL -- the tile list IS the access list, here too.
  `app = EVERYONE` is reserved for providers that reveal nothing a nav user
  could not already see, and is checked at registration so it is never a
  default someone forgot to change.

  A provider over SEVERAL apps (the *arr calendar) names them as a tuple and
  says which a given config reads (needs()): the type is offered to anyone who
  can open one of them, and a definition is shown only to someone who can open
  every one it reads.

  THE ONE EXCEPTION is a library widget's AUDIENCE (app.py): Authentik groups
  an admin names on the definition, who see THAT widget's data even without
  the app -- the family seeing what is coming up without a Sonarr login. It is
  per definition, admin-written, and never applies to personal widgets.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Awaitable, Callable

SHAPES = ("stat", "timeseries", "list", "status", "clock", "weather", "calendar")

# The sizes a placed widget may take, per shape, smallest first. The page owns
# what each means in grid cells (static/group-grid.js); the server only refuses
# a size the page could not draw. Default when NULL: the page's per-shape pick.
# W is a wide strip: the full row, half L's height (weather only, for now).
SIZES = {"stat": ("XS", "S", "M", "L"), "timeseries": ("XS", "S", "M", "L", "XL"),
         "list": ("S", "M", "L"), "status": ("XS", "S"),
         "clock": ("XS", "S", "M", "L"), "weather": ("XS", "S", "M", "L", "XL", "W"),
         "calendar": ("M", "L", "XL", "W")}
TILE_SIZES = ("XS", "S", "M", "L")

# Past the largest named size a widget may take any span, "COLSxROWS" (the
# page caps the width at the row). The renderer draws the largest named size
# that fits and lays out into the rest -- see sizeBase() in group-grid.js.
CUSTOM_MAX = (48, 32)
CUSTOM = re.compile(r"^([1-9]\d?)x([1-9]\d?)$")


def size_ok(shape: str, size: str | None) -> bool:
    if size is None or size in SIZES.get(shape, ()):
        return True
    m = CUSTOM.match(str(size))
    return bool(m and shape in SIZES and int(m.group(1)) <= CUSTOM_MAX[0]
                and int(m.group(2)) <= CUSTOM_MAX[1])
EVERYONE = "*"

# A failing upstream is cached too, briefly, so a dashboard of ten tabs does not
# turn one outage into a request storm. Short enough that recovery shows fast.
ERROR_TTL = 15
CACHE_MAX = 256

REGISTRY: dict[str, type["Provider"]] = {}


class ConfigError(ValueError):
    """The config is wrong: a 400, not a provider failure."""


class Provider:
    """Subclass, set the class attributes, implement fetch(), decorate @register.

    config_schema is a dict of field -> spec, where spec has:
      type      "string" | "number" | "integer" | "bool" | "enum"
      label     shown in the add-widget form
      required  default False
      default   used when the field is absent
      choices   list, for "enum"
    """
    type: str = ""
    title: str = ""
    description: str = ""
    app: str | tuple[str, ...] = ""   # Authentik slug(s), or EVERYONE
    shape: str = ""
    ttl: int = 60
    per_user: bool = False    # True when fetch() output depends on WHO asks
    # Things a viewer can do from the widget (POST /api/widgets/{id}/action).
    # Empty: a read-only widget. The provider's act() decides, and its
    # upstream enforces, whether THIS viewer may.
    actions: tuple[str, ...] = ()
    # The viewer may read and act AS someone else in the upstream app (`as`
    # on data and actions, an upstream person id). nav grants nothing here:
    # the provider passes both identities and the UPSTREAM decides whether
    # the real viewer may (choreboard: only its admins), and records both.
    acts_as: bool = False
    # Only admins may create, preview or edit this type (the remote widget:
    # its URL is fetched from inside the cluster, so letting anyone set it is
    # a server-side request forgery). Viewing a placed one is the usual gate.
    admin_only: bool = False
    config_schema: dict[str, dict[str, Any]] = {}
    # Ready-made definitions the designer offers: [{title, config}], each
    # config valid against config_schema (checked at registration).
    presets: list[dict[str, Any]] = []

    @classmethod
    def shape_for(cls, config: dict[str, Any]) -> str:
        """The shape this config draws. Fixed per provider, except the remote
        widget, whose definition chooses one."""
        return cls.shape

    @classmethod
    def ttl_for(cls, config: dict[str, Any]) -> int:
        """Seconds a result is reused. A provider may let its config set it."""
        return cls.ttl

    @classmethod
    def per_user_for(cls, config: dict[str, Any]) -> bool:
        return cls.per_user

    @classmethod
    def needs(cls, config: dict[str, Any]) -> set[str]:
        """The apps this config reads. One app, or all of a tuple, unless a
        provider narrows it by config."""
        return set(cls.app) if isinstance(cls.app, tuple) else {cls.app}

    async def act(self, config: dict[str, Any], who: str, action: str,
                  params: dict[str, Any]) -> dict[str, Any]:
        """Do `action` as `who`. Raise ActionError for a refusal the viewer
        should read."""
        raise ActionError(400, f"{self.type} has no actions")

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        raise NotImplementedError

    async def labels(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        """Names the designer can insert as {{label}} into fields marked
        `template` in config_schema. Providers without labels return {}."""
        return {}


def register(cls: type[Provider]) -> type[Provider]:
    """Refuse a malformed provider at import time, not on first render."""
    if not cls.type or cls.type in REGISTRY:
        raise ValueError(f"provider type {cls.type!r} is empty or already registered")
    if cls.shape not in SHAPES:
        raise ValueError(f"{cls.type}: shape {cls.shape!r} is not one of {SHAPES}")
    if not cls.app:
        raise ValueError(f"{cls.type}: `app` is required -- name the Authentik slug "
                         f"whose data this shows, or EVERYONE if it shows none")
    if isinstance(cls.app, tuple) and (not cls.app or EVERYONE in cls.app):
        raise ValueError(f"{cls.type}: an app tuple names apps, never EVERYONE")
    if cls.ttl < 1:
        raise ValueError(f"{cls.type}: ttl must be at least 1 second")
    for name, spec in cls.config_schema.items():
        if spec.get("type") not in ("string", "number", "integer", "bool", "enum"):
            raise ValueError(f"{cls.type}.{name}: unknown field type {spec.get('type')!r}")
        if spec["type"] == "enum" and not spec.get("choices"):
            raise ValueError(f"{cls.type}.{name}: enum needs choices")
    for p in cls.presets:
        try:
            validate_config(cls, p.get("config"))
        except ConfigError as exc:
            raise ValueError(f"{cls.type}: preset {p.get('title')!r}: {exc}") from None
        if not p.get("title"):
            raise ValueError(f"{cls.type}: a preset needs a title")
    REGISTRY[cls.type] = cls
    return cls


def validate_config(cls: type[Provider], config: dict[str, Any] | None) -> dict[str, Any]:
    """Defaults applied, types checked, unknown keys REFUSED.

    Unknown keys are an error rather than ignored: a typo'd field silently
    falling back to its default looks like the provider ignoring you.
    """
    config = dict(config or {})
    unknown = set(config) - set(cls.config_schema)
    if unknown:
        raise ConfigError(f"unknown field(s) for {cls.type}: {', '.join(sorted(unknown))}")
    out: dict[str, Any] = {}
    for name, spec in cls.config_schema.items():
        if name not in config or config[name] in (None, ""):
            if spec.get("required"):
                raise ConfigError(f"{cls.type}: {name} is required")
            if "default" in spec:
                out[name] = spec["default"]
            continue
        v, t = config[name], spec["type"]
        # bool is an int in Python; refuse it where a number is meant.
        if t == "string" and not isinstance(v, str) \
                or t == "bool" and not isinstance(v, bool) \
                or t == "integer" and (not isinstance(v, int) or isinstance(v, bool)) \
                or t == "number" and (not isinstance(v, (int, float)) or isinstance(v, bool)):
            raise ConfigError(f"{cls.type}: {name} must be {t}")
        if t == "enum" and v not in spec["choices"]:
            raise ConfigError(f"{cls.type}: {name} must be one of {spec['choices']}")
        out[name] = v
    return out


def visible(cls: type[Provider], slugs: set[str]) -> bool:
    """May this caller ADD the type: one of its apps is enough to start."""
    if cls.app == EVERYONE:
        return True
    apps = cls.app if isinstance(cls.app, tuple) else (cls.app,)
    return any(a in slugs for a in apps)


def allowed(cls: type[Provider], config: dict[str, Any], slugs: set[str]) -> bool:
    """May this caller see THIS config's data: every app it reads. A config
    may say EVERYONE itself (the remote widget's `app: "*"`)."""
    need = cls.needs(config)
    if EVERYONE in need:
        return True
    return bool(need) and need <= slugs


def forbidden(cls: type[Provider], config: dict[str, Any]) -> str:
    apps = sorted(cls.needs(config))
    return f"{cls.type} shows data from {', '.join(repr(a) for a in apps)}, which you cannot open"


# A library widget's audience: Authentik group names, or "*" for everyone
# signed in. Lower-cased, as the groups header is (app.parse_groups).
AUDIENCE_MAX = 20


def clean_audience(raw: Any) -> list[str]:
    if raw in (None, "", []):
        return []
    if isinstance(raw, str):
        raw = raw.split(",")
    if not isinstance(raw, list) or not all(isinstance(g, str) for g in raw):
        raise ConfigError("audience must be a list of group names")
    out = sorted({g.strip().lower() for g in raw if g.strip()})
    if len(out) > AUDIENCE_MAX:
        raise ConfigError(f"at most {AUDIENCE_MAX} audience groups")
    return out


def in_audience(audience: list[str] | None, groups: set[str]) -> bool:
    return bool(audience) and ("*" in audience or bool(set(audience) & groups))


def describe(cls: type[Provider]) -> dict[str, Any]:
    """What the add-widget UI needs. Never includes anything fetch() returns."""
    return {"type": cls.type, "title": cls.title, "description": cls.description,
            "app": list(cls.app) if isinstance(cls.app, tuple) else cls.app,
            "shape": cls.shape, "ttl": cls.ttl, "admin_only": cls.admin_only,
            "config_schema": cls.config_schema, "presets": cls.presets}


def check_shape(shape: str, data: Any) -> str | None:
    """The renderer contract. A provider that breaks it gets an error tile,
    not a renderer throwing on the page. Returns the problem, or None."""
    if not isinstance(data, dict):
        return "data must be an object"
    if shape == "stat" and "value" not in data:
        return "stat needs `value`"
    if shape == "timeseries" and not isinstance(data.get("series"), list):
        return "timeseries needs `series`: a list"
    if shape == "list" and not isinstance(data.get("items"), list):
        return "list needs `items`: a list"
    if shape == "status" and data.get("state") not in ("up", "down", "degraded", "unknown"):
        return "status needs `state`: up | down | degraded | unknown"
    if shape == "clock" and not isinstance(data.get("zones"), list):
        return "clock needs `zones`: a list"
    if shape == "weather" and not isinstance(data.get("current"), dict):
        return "weather needs `current`: an object"
    if shape == "calendar" and not isinstance(data.get("events"), list):
        return "calendar needs `events`: a list"
    return None


class ActionError(Exception):
    """A widget action refused or failed, with what to tell the viewer."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


class Cache:
    """TTL cache with in-flight de-duplication.

    Keyed by provider type + canonical config (+ the caller, for per_user
    providers -- otherwise one user's answer is served to the next). Concurrent
    misses on one key share a single upstream call.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic, cap: int = CACHE_MAX):
        self.clock, self.cap = clock, cap
        self.entries: dict[str, tuple[float, dict[str, Any]]] = {}
        self.inflight: dict[str, asyncio.Future] = {}

    @staticmethod
    def key(cls: type[Provider], config: dict[str, Any], who: str) -> str:
        k = cls.type + "\x00" + json.dumps(config, sort_keys=True, separators=(",", ":"))
        return k + "\x00" + who if cls.per_user_for(config) else k

    async def get(self, key: str, make: Callable[[], Awaitable[tuple[dict[str, Any], int]]]
                  ) -> dict[str, Any]:
        now = self.clock()
        hit = self.entries.get(key)
        if hit and hit[0] > now:
            return hit[1]
        if key in self.inflight:
            return await asyncio.shield(self.inflight[key])
        fut = asyncio.get_running_loop().create_future()
        self.inflight[key] = fut
        try:
            payload, ttl = await make()
            self.entries[key] = (self.clock() + ttl, payload)
            if len(self.entries) > self.cap:
                # Oldest expiry first: the entry closest to useless anyway.
                del self.entries[min(self.entries, key=lambda k: self.entries[k][0])]
            fut.set_result(payload)
            return payload
        except BaseException as exc:
            fut.set_exception(exc)
            raise
        finally:
            del self.inflight[key]


    def forget(self, cls: type[Provider], config: dict[str, Any]) -> int:
        """Drop every cached answer for a definition (every viewer's, for a
        per-user provider): after an action, the next fetch is fresh."""
        prefix = cls.type + "\x00" + json.dumps(config, sort_keys=True, separators=(",", ":"))
        gone = [k for k in self.entries if k == prefix or k.startswith(prefix + "\x00")]
        for k in gone:
            del self.entries[k]
        return len(gone)


CACHE = Cache()


async def run(cls: type[Provider], config: dict[str, Any], who: str,
              cache: Cache = CACHE, as_: int | None = None) -> dict[str, Any]:
    """Fetch through the cache. Never raises for a provider failure: a broken
    widget is an error payload for its own tile, never a failed page."""
    ttl = cls.ttl_for(config)

    async def make() -> tuple[dict[str, Any], int]:
        base = {"type": cls.type, "shape": cls.shape_for(config), "fetched_at": time.time()}
        try:
            data = await (cls().fetch(config, who, as_=as_) if as_ else cls().fetch(config, who))
        except Exception as exc:
            msg = f"{type(exc).__name__}: {exc}"[:300]
            return {**base, "error": msg}, min(ttl, ERROR_TTL)
        problem = check_shape(base["shape"], data)
        if problem:
            return {**base, "error": f"{cls.type} broke the {base['shape']} contract: {problem}"}, \
                min(ttl, ERROR_TTL)
        return {**base, "data": data, "ttl": ttl}, ttl

    # Acting as someone is its own cache entry: never served to the plain view.
    key = Cache.key(cls, config, who) + (f"\x00{who}\x00as:{as_}" if as_ else "")
    return await cache.get(key, make)
