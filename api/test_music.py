"""music.py: matching libraries by folder, what each app should show, and each app's read and write."""
import asyncio
import json as _json
import unittest

import music as m


class _Resp:
    def __init__(self, body, status=200, text=None):
        self.status_code, self._body = status, body
        self.text = text if text is not None else _json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class _Client:
    """Answers by METHOD + path (query strings ignored); records every call."""
    def __init__(self, routes):
        self.routes, self.seen = routes, []

    def _ans(self, method, url, body):
        path = "/" + url.split("/", 3)[-1]
        self.seen.append((method, path, body))
        for k in (f"{method} {path}", path):
            if k in self.routes:
                r = self.routes[k]
                return r(body) if callable(r) else r
        raise KeyError(f"{method} {path}")

    async def get(self, url, params=None, headers=None):
        return self._ans("GET", url, None)

    async def post(self, url, json=None, headers=None, params=None):
        return self._ans("POST", url, json)

    async def put(self, url, json=None, headers=None, params=None):
        return self._ans("PUT", url, json)


def run(coro_fn, routes, *a, key="k"):
    c = _Client(routes)
    return asyncio.run(coro_fn(c, "http://app", key, *a)), c


class Pure(unittest.TestCase):
    def test_folder_of(self):
        self.assertEqual(m.folder_of("/media/music-libraries/Kids/"), "Kids")
        self.assertEqual(m.folder_of("D:\\music\\Celtic"), "Celtic")

    def test_want(self):
        self.assertEqual(m.want_of(["A", "B", "C"], ["B"], ["C"]), {"A"})

    def test_status(self):
        libs = m.Libs(libs={"A": "1", "B": "2"},
                      users={"kid": {"shown": {"A", "B"}}, "own": {"shown": None, "fixed": "owner"}})
        self.assertEqual(m.status(libs, None, "kid", {"A", "B", "Z"})["state"], "ok",
                         "a folder this app doesn't have isn't drift")
        d = m.status(libs, None, "kid", {"A"})
        self.assertEqual((d["state"], d["extra"]), ("drift", ["B"]))
        self.assertEqual(m.status(libs, None, "own", set())["state"], "fixed")
        self.assertEqual(m.status(libs, None, None, set())["state"], "none")
        self.assertEqual(m.status(None, "down", "kid", set())["state"], "error")

    def test_jellyfin_policy_keeps_other_libraries(self):
        every = ["mov", "tv", "m1", "m2"]
        music = {"A": "m1", "B": "m2"}
        self.assertEqual(m.jf_folders({"EnableAllFolders": True}, every, music, {"A"}),
                         {"EnableAllFolders": False, "EnabledFolders": ["mov", "tv", "m1"]})
        self.assertEqual(m.jf_folders({"EnableAllFolders": False, "EnabledFolders": ["mov"]}, every, music, {"B"}),
                         {"EnableAllFolders": False, "EnabledFolders": ["mov", "m2"]}, "TV stays off")
        self.assertEqual(m.jf_folders({"EnableAllFolders": False, "EnabledFolders": ["mov", "tv"]}, every, music, {"A", "B"}),
                         {"EnableAllFolders": True, "EnabledFolders": []}, "everything again = all folders")

    def test_ma_filter(self):
        libs = {"A": "fs1", "B": "fs2"}
        self.assertEqual(m.ma_filter(libs, ["radio"], {"A", "B"}), [], "all = no filter")
        self.assertEqual(m.ma_filter(libs, ["radio"], {"B"}), ["radio", "fs2"])
        with self.assertRaises(ValueError):
            m.ma_filter(libs, [], set())


class Jellyfin(unittest.TestCase):
    VF = [{"Name": "Movies", "CollectionType": "movies", "Locations": ["/media/Movies"], "ItemId": "mov"},
          {"Name": "Music", "CollectionType": "music", "Locations": ["/media/music-libraries/Shared"], "ItemId": "M-1"},
          {"Name": "Music - Kids", "CollectionType": "music", "Locations": ["/media/music-libraries/Kids"], "ItemId": "m2"}]

    def test_read_and_write(self):
        users = [{"Name": "Bear", "Id": "u1", "Policy": {"EnableAllFolders": True}},
                 {"Name": "kid", "Id": "u2", "Policy": {"EnableAllFolders": False, "EnabledFolders": ["m-1", "mov"]}}]
        libs, _ = run(m._jf_read, {"/Library/VirtualFolders": _Resp(self.VF), "/Users": _Resp(users)})
        self.assertEqual(libs.libs, {"Shared": "m1", "Kids": "m2"})
        self.assertEqual(libs.users["bear"]["shown"], {"Shared", "Kids"})
        self.assertEqual(libs.users["kid"]["shown"], {"Shared"}, "dashes and case don't matter")
        pol = {"EnableAllFolders": False, "EnabledFolders": ["m1", "mov"], "IsAdministrator": False}
        _, c = run(m._jf_write, {"/Users/u2": _Resp({"Policy": pol}), "POST /Users/u2/Policy": _Resp(None, text="")},
                   libs, "kid", {"Kids"})
        sent = c.seen[-1][2]
        self.assertEqual(sent["EnabledFolders"], ["mov", "m2"])
        self.assertFalse(sent["IsAdministrator"], "the rest of the policy goes back as read")


PLEX_LIST = ('<MediaContainer><SharedServer id="77" username="mum" email="mum@x" userID="5">'
             '<Section id="901" key="1" title="Movies" type="movie" shared="1"/>'
             '<Section id="902" key="3" title="Music" type="artist" shared="1"/>'
             '<Section id="903" key="4" title="Music - Kids" type="artist" shared="0"/>'
             '</SharedServer></MediaContainer>')
PLEX_SECTIONS = {"MediaContainer": {"Directory": [
    {"key": "1", "type": "movie", "Location": [{"path": "/media/Movies"}]},
    {"key": "3", "type": "artist", "Location": [{"path": "/media/music-libraries/Shared"}]},
    {"key": "4", "type": "artist", "Location": [{"path": "/media/music-libraries/Kids"}]}]}}


class Plex(unittest.TestCase):
    def routes(self, listing=PLEX_LIST):
        return {"/identity": _Resp({"MediaContainer": {"machineIdentifier": "M1"}}),
                "/library/sections": _Resp(PLEX_SECTIONS),
                "/users/account.json": _Resp({"user": {"username": "Bear"}}),
                "/api/servers/M1/shared_servers": _Resp(None, text=listing),
                "/api/servers/M1/shared_servers/77": _Resp(None, text=PLEX_LIST)}

    def test_read(self):
        libs, _ = run(m._plex_read, self.routes())
        self.assertEqual(libs.libs, {"Shared": "902", "Kids": "903"})
        self.assertEqual(libs.users["mum"]["shown"], {"Shared"})
        self.assertIs(libs.users["mum@x"], libs.users["mum"], "found by email too")
        self.assertEqual(libs.users["bear"]["fixed"], "the Plex server owner sees every library")

    def test_sections_from_the_share_when_the_list_has_none(self):
        bare = '<MediaContainer><SharedServer id="77" username="mum" email="mum@x"/></MediaContainer>'
        libs, c = run(m._plex_read, self.routes(bare))
        self.assertEqual(libs.users["mum"]["shown"], {"Shared"})
        self.assertIn(("GET", "/api/servers/M1/shared_servers/77", None), c.seen)

    def test_write_keeps_non_music(self):
        libs, _ = run(m._plex_read, self.routes())
        _, c = run(m._plex_write, {"PUT /api/servers/M1/shared_servers/77": _Resp({})}, libs, "mum", {"Kids"})
        self.assertEqual(c.seen[-1][2], {"server_id": "M1", "shared_server": {"library_section_ids": ["901", "903"]}})


class Navidrome(unittest.TestCase):
    def test_read_and_write(self):
        routes = {"/auth/login": _Resp({"token": "t"}),
                  "/api/library": _Resp([{"id": 1, "path": "/media/music-libraries/Shared"},
                                         {"id": 2, "path": "/media/music-libraries/Kids"}]),
                  "/api/user": _Resp([{"id": "a", "userName": "bear", "isAdmin": True},
                                      {"id": "b", "userName": "kid", "isAdmin": False}]),
                  "/api/user/b/library": _Resp([{"id": 2}])}
        libs, c = run(m._nd_read, routes, key="admin:pw")
        self.assertEqual(libs.users["bear"]["fixed"], "Navidrome admins see every library")
        self.assertEqual(libs.users["kid"]["shown"], {"Kids"})
        self.assertNotIn(("GET", "/api/user/a/library", None), c.seen, "admins aren't asked")
        _, c = run(m._nd_write, routes, libs, "kid", {"Shared", "Kids"}, key="admin:pw")
        self.assertEqual(c.seen[-1], ("PUT", "/api/user/b/library", {"libraryIds": [2, 1]}))
        with self.assertRaises(ValueError):
            run(m._nd_write, routes, libs, "kid", set(), key="admin:pw")


class MusicAssistant(unittest.TestCase):
    def test_read_and_write(self):
        def api(body):
            return _Resp({
                "config/providers": [{"domain": "filesystem_local", "name": "Shared", "instance_id": "fs1"},
                                     {"domain": "filesystem_local", "name": "Kids", "instance_id": "fs2"},
                                     {"domain": "radiobrowser", "name": "Radio", "instance_id": "rb"}],
                "auth/users": [{"username": "kid", "user_id": "u2", "provider_filter": ["fs2", "rb"]},
                               {"username": "bear", "user_id": "u1", "provider_filter": []},
                               {"username": "svc", "role": "service"}],
                "auth/user/update": {}}[body["command"]])
        libs, _ = run(m._ma_read, {"/api": api})
        self.assertEqual(libs.users["kid"]["shown"], {"Kids"})
        self.assertEqual(libs.users["bear"]["shown"], {"Shared", "Kids"}, "no filter = everything")
        self.assertNotIn("svc", libs.users)
        _, c = run(m._ma_write, {"/api": api}, libs, "kid", {"Shared"})
        self.assertEqual(c.seen[-1][2], {"command": "auth/user/update",
                                         "args": {"user_id": "u2", "provider_filter": ["rb", "fs1"]}})


if __name__ == "__main__":
    unittest.main()
