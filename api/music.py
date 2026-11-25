"""Music libraries, self-service: each person picks the music libraries they see,
and nav makes every music app agree.

A "library" here is a FOLDER: one music library per folder on the shared disk,
created in each app under that folder. Apps name libraries their own way, so
nav matches them by the folder's name -- the last part of the library's path
(Jellyfin, Plex, Navidrome) or the source's name (Music Assistant, whose
filesystem sources don't expose their path; name each after its folder).

What a person sees = every folder, less the ones an admin blocked for them
(the ceiling), less the ones they hid themselves. nav writes that into each app
where they have an account, through the app's own admin API:

  Jellyfin        user policy: EnableAllFolders off, EnabledFolders = their other
                  (non-music) libraries + the music ones they see
  Plex            the server's share with them on plex.tv (library_section_ids);
                  the owner always sees everything
  Navidrome       PUT /api/user/{id}/library; admins always see everything, and a
                  user needs at least one library
  Music Assistant the user's provider_filter: the folder sources they see plus every
                  other music source (radio and the like); [] means everything

Access, not just display: a library switched off can't be opened in that app.
Only music libraries are touched; everything else each account has stays as is.

The pure half (folders, wants, diffs) is standard library only; the readers and
writers import nothing beyond the client they're given.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

APPS = ("jellyfin", "plex", "navidrome", "music-assistant")


def folder_of(path: Any) -> str:
    """A library path's last part ("/media/music-libraries/Kids/" -> "Kids")."""
    return str(path or "").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def nid(x: Any) -> str:
    """Ids compared without dashes or case (Jellyfin writes GUIDs both ways)."""
    return str(x or "").replace("-", "").lower()


@dataclass
class Libs:
    """One app's music libraries and who sees which.

    libs   folder -> the app's id for that library
    users  account key (appaccounts.acct_key) -> {"shown": set of folders, or None
           for "every library, always" (Plex owner, Navidrome admin): `fixed` says why,
           "ref": what the writer needs}
    ctx    whatever else the writer needs (other libraries, other sources, ids)
    """
    libs: dict[str, str] = field(default_factory=dict)
    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    ctx: dict[str, Any] = field(default_factory=dict)


def want_of(folders: list[str], blocked: list[str], hidden: list[str]) -> set[str]:
    return set(folders) - set(blocked) - set(hidden)


def status(libs: Libs | None, error: str | None, acct: str | None, want: set[str]) -> dict[str, Any]:
    """One app's state for one person: none | fixed | ok | drift | error.
    Only the folders this app has count: a folder missing from an app is the
    library script's business, not drift."""
    if error:
        return {"state": "error", "detail": error}
    if not acct or libs is None:
        return {"state": "none", "detail": "no account"}
    if acct not in libs.users:
        return {"state": "none", "detail": f"has an account ({acct}), but the app lists no library access for it"
                                           " (for Plex: no share of this server)"}
    u = libs.users[acct]
    if u.get("fixed"):
        return {"state": "fixed", "detail": u["fixed"]}
    have = set(libs.libs)
    shown, w = u["shown"] & have, want & have
    if shown == w:
        return {"state": "ok", "detail": f"sees {len(w)} of {len(have)} music libraries"}
    extra, missing = sorted(shown - w), sorted(w - shown)
    bits = ([f"also sees {', '.join(extra)}"] if extra else []) + ([f"missing {', '.join(missing)}"] if missing else [])
    return {"state": "drift", "detail": "; ".join(bits), "extra": extra, "missing": missing}


# --- Jellyfin -------------------------------------------------------------------------

async def _jf_read(client: Any, base: str, key: str) -> Libs:
    # LibraryStructureController: GET /Library/VirtualFolders [{Name, Locations, CollectionType, ItemId}];
    # UserController: GET /Users with each Policy (EnableAllFolders, EnabledFolders).
    p = {"ApiKey": key}
    vf = await client.get(base + "/Library/VirtualFolders", params=p)
    vf.raise_for_status()
    out = Libs()
    every: list[str] = []
    for f in vf.json() or []:
        iid = nid(f.get("ItemId"))
        if not iid:
            continue
        every.append(iid)
        if (f.get("CollectionType") or "").lower() == "music" and f.get("Locations"):
            out.libs[folder_of(f["Locations"][0])] = iid
    out.ctx["every"] = every
    us = await client.get(base + "/Users", params=p)
    us.raise_for_status()
    by_id = {v: k for k, v in out.libs.items()}
    for u in us.json() or []:
        pol = u.get("Policy") or {}
        if pol.get("EnableAllFolders"):
            shown = set(out.libs)
        else:
            shown = {by_id[nid(x)] for x in pol.get("EnabledFolders") or [] if nid(x) in by_id}
        out.users[(u.get("Name") or "").strip().lower()] = {"shown": shown, "ref": u.get("Id")}
    return out


def jf_folders(policy: dict[str, Any], every: list[str], music: dict[str, str], want: set[str]) -> dict[str, Any]:
    """The policy change that shows exactly `want` of the music libraries and keeps
    every other library as it is."""
    music_ids = set(music.values())
    now = set(every) if policy.get("EnableAllFolders") else {nid(x) for x in policy.get("EnabledFolders") or []}
    keep = [i for i in every if i in now and i not in music_ids]
    new = keep + [music[f] for f in sorted(want) if f in music]
    if set(new) >= set(every):
        return {"EnableAllFolders": True, "EnabledFolders": []}
    return {"EnableAllFolders": False, "EnabledFolders": new}


async def _jf_write(client: Any, base: str, key: str, libs: Libs, acct: str, want: set[str]) -> None:
    # UserController.UpdateUserPolicy takes the WHOLE policy: read it, change two fields.
    uid = libs.users[acct]["ref"]
    r = await client.get(f"{base}/Users/{uid}", params={"ApiKey": key})
    r.raise_for_status()
    policy = dict(r.json().get("Policy") or {})
    if not policy:
        raise ValueError("Jellyfin returned no policy for this user")
    change = jf_folders(policy, libs.ctx["every"], libs.libs, want)
    r = await client.post(f"{base}/Users/{uid}/Policy", params={"ApiKey": key}, json=policy | change)
    r.raise_for_status()


# --- Plex -----------------------------------------------------------------------------

PLEX_TV = "https://plex.tv"


def _plex_h(key: str) -> dict[str, str]:
    return {"X-Plex-Token": key, "X-Plex-Client-Identifier": "nav", "X-Plex-Product": "nav", "Accept": "application/json"}


async def _plex_read(client: Any, base: str, key: str) -> Libs:
    # Local server: /identity (machine id) and /library/sections (type "artist" = music,
    # Location paths). plex.tv: /api/servers/{machine}/shared_servers, one SharedServer per
    # person it's shared with, each Section with its plex.tv id, local key and shared="1|0"
    # (python-plexapi MyPlexAccount.updateFriend uses the same ids). XML whatever Accept says.
    import xml.etree.ElementTree as ET
    h = _plex_h(key)
    ident = await client.get(base + "/identity", headers=h)
    ident.raise_for_status()
    try:
        machine = ident.json()["MediaContainer"]["machineIdentifier"]
    except ValueError:
        machine = ET.fromstring(ident.text).get("machineIdentifier")
    secs = await client.get(base + "/library/sections", headers=h)
    secs.raise_for_status()
    out = Libs(ctx={"machine": machine})
    music_keys: dict[str, str] = {}              # local key -> folder
    for d in (secs.json().get("MediaContainer") or {}).get("Directory") or []:
        locs = d.get("Location") or []
        if d.get("type") == "artist" and locs:
            music_keys[str(d.get("key"))] = folder_of(locs[0].get("path"))
    me = await client.get(PLEX_TV + "/users/account.json", headers=h)
    me.raise_for_status()
    owner = (me.json().get("user") or {}).get("username") or ""
    # A share names its person by plex.tv user id; App accounts names them by
    # login (username, else title -- a Home profile has no username) and email, from
    # the friends list and Plex Home. Key each share by all of those, so a person's
    # account key (appaccounts.acct_key) finds it whichever way they were matched.
    names: dict[str, set[str]] = {}
    for path in ("/api/users", "/api/home/users"):
        fr = await client.get(PLEX_TV + path, headers=h)
        if fr.status_code != 200:
            continue
        for u in ET.fromstring(fr.text).iter("User"):
            names.setdefault(str(u.get("id")), set()).update(
                x.lower() for x in (u.get("username") or u.get("title"), u.get("email"), u.get("title")) if x)
    r = await client.get(f"{PLEX_TV}/api/servers/{machine}/shared_servers", headers=h)
    r.raise_for_status()
    for s in ET.fromstring(r.text).iter("SharedServer"):
        # The list may leave out the sections; the share itself lists them all.
        secs_of = list(s.iter("Section"))
        if not secs_of:
            one = await client.get(f"{PLEX_TV}/api/servers/{machine}/shared_servers/{s.get('id')}", headers=h)
            one.raise_for_status()
            secs_of = list(ET.fromstring(one.text).iter("Section"))
        shown, ids, other = set(), {}, []
        for sec in secs_of:
            f = music_keys.get(str(sec.get("key")))
            if f:
                ids[f] = sec.get("id")
                if sec.get("shared") == "1":
                    shown.add(f)
            elif sec.get("shared") == "1":
                other.append(sec.get("id"))
        out.libs.update(ids)
        u = {"shown": shown, "ref": {"id": s.get("id"), "other": other}}
        for k in ({(s.get(a) or "").lower() for a in ("username", "email", "name")} - {""}) | names.get(str(s.get("userID")), set()):
            out.users[k] = u
    # Music libraries no one is sharing yet: still libraries (their plex.tv ids come
    # with the first share that lists them; a write needs them).
    for k, f in music_keys.items():
        out.libs.setdefault(f, "")
    if owner:
        out.users[owner.lower()] = {"shown": None, "fixed": "the Plex server owner sees every library"}
    return out


async def _plex_write(client: Any, base: str, key: str, libs: Libs, acct: str, want: set[str]) -> None:
    ref = libs.users[acct]["ref"]
    missing = [f for f in want if f in libs.libs and not libs.libs[f]]
    if missing:
        raise ValueError(f"plex.tv lists no id for {', '.join(sorted(missing))} yet")
    ids = list(ref["other"]) + [libs.libs[f] for f in sorted(want) if libs.libs.get(f)]
    if not ids:
        raise ValueError("Plex would share nothing at all: stop sharing with them in Plex instead")
    machine = libs.ctx["machine"]
    r = await client.put(f"{PLEX_TV}/api/servers/{machine}/shared_servers/{ref['id']}",
                         headers=_plex_h(key) | {"Content-Type": "application/json"},
                         json={"server_id": machine, "shared_server": {"library_section_ids": ids}})
    r.raise_for_status()


# --- Navidrome ------------------------------------------------------------------------

async def _nd_read(client: Any, base: str, key: str) -> Libs:
    # nativeapi (0.58+): GET /api/library [{id, name, path}], GET /api/user,
    # GET /api/user/{id}/library. Admins get every library and can't be limited.
    # The login is appaccounts' kept token: Navidrome rate-limits /auth/login.
    from appaccounts import nd_call
    r = await nd_call(client, "get", base, key, "/api/library")
    out = Libs()
    by_id: dict[str, str] = {}
    for lib in r.json() or []:
        f = folder_of(lib.get("path"))
        out.libs[f] = str(lib.get("id"))
        by_id[str(lib.get("id"))] = f
    r = await nd_call(client, "get", base, key, "/api/user")
    for u in r.json() or []:
        k = (u.get("userName") or "").lower()
        if u.get("isAdmin"):
            out.users[k] = {"shown": None, "fixed": "Navidrome admins see every library"}
            continue
        lr = await nd_call(client, "get", base, key, f"/api/user/{u.get('id')}/library")
        out.users[k] = {"shown": {by_id[str(x.get("id"))] for x in lr.json() or [] if str(x.get("id")) in by_id},
                        "ref": u.get("id")}
    return out


async def _nd_write(client: Any, base: str, key: str, libs: Libs, acct: str, want: set[str]) -> None:
    ids = [int(libs.libs[f]) for f in sorted(want) if f in libs.libs]
    if not ids:
        raise ValueError("Navidrome needs at least one library for a user")
    from appaccounts import nd_call
    await nd_call(client, "put", base, key, f"/api/user/{libs.users[acct]['ref']}/library", {"libraryIds": ids})


# --- Music Assistant ------------------------------------------------------------------

async def _ma(client: Any, base: str, key: str, command: str, **args: Any) -> Any:
    r = await client.post(base + "/api", headers={"Authorization": f"Bearer {key}"},
                          json={"command": command, "args": args})
    r.raise_for_status()
    body = r.json()
    if isinstance(body, dict) and body.get("error_code"):
        raise ValueError(f"Music Assistant: {body.get('details') or body.get('error_code')}")
    return body


async def _ma_read(client: Any, base: str, key: str) -> Libs:
    # config/providers (provider_type=music): every music source; the filesystem ones are
    # the folder libraries (named after the folder). auth/users: each user's
    # provider_filter, [] = everything (controllers/music/media/base.py
    # _ensure_provider_filter; non-music providers are always kept).
    provs = await _ma(client, base, key, "config/providers", provider_type="music")
    out = Libs()
    others = []
    for p in provs or []:
        if p.get("domain") == "filesystem_local" and p.get("name"):
            out.libs[p["name"]] = p["instance_id"]
        else:
            others.append(p["instance_id"])
    out.ctx["others"] = others
    by_id = {v: k for k, v in out.libs.items()}
    for u in await _ma(client, base, key, "auth/users") or []:
        if u.get("role") == "service":
            continue
        flt = u.get("provider_filter") or []
        shown = set(out.libs) if not flt else {by_id[x] for x in flt if x in by_id}
        out.users[(u.get("username") or "").lower()] = {"shown": shown, "ref": u.get("user_id")}
    return out


def ma_filter(libs: dict[str, str], others: list[str], want: set[str]) -> list[str]:
    """The provider_filter that shows exactly `want`: [] when that is every library."""
    if set(libs) <= want:
        return []
    out = list(others) + [libs[f] for f in sorted(want) if f in libs]
    if not out:
        raise ValueError("Music Assistant can't hide every source (an empty filter means all of them)")
    return out


async def _ma_write(client: Any, base: str, key: str, libs: Libs, acct: str, want: set[str]) -> None:
    await _ma(client, base, key, "auth/user/update", user_id=libs.users[acct]["ref"],
              provider_filter=ma_filter(libs.libs, libs.ctx["others"], want))


Reader = Callable[[Any, str, str], Awaitable[Libs]]
Writer = Callable[[Any, str, str, Libs, str, set], Awaitable[None]]
READ: dict[str, Reader] = {"jellyfin": _jf_read, "plex": _plex_read, "navidrome": _nd_read, "music-assistant": _ma_read}
WRITE: dict[str, Writer] = {"jellyfin": _jf_write, "plex": _plex_write, "navidrome": _nd_write, "music-assistant": _ma_write}
