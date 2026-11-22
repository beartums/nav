"""appaccounts.py: matching app accounts to people."""
import unittest

import appaccounts as aa


async def _none(*a):
    return []


AD = {"jf": aa.Adapter("jf", "Jellyfin", "jellyfin", ("jellyfin",), "manual", _none),
      "gr": aa.Adapter("gr", "Grafana", "grafana", ("grafana",), "first", _none)}
PEOPLE = [{"pk": 5, "username": "beartums", "email": "Bear@x.test"},
          {"pk": 8, "username": "mum", "email": "mum@x.test"},
          {"pk": 9, "username": "kid", "email": "kid@x.test"}]


class Match(unittest.TestCase):
    def test_statuses_and_orphans(self):
        found = {"jf": [aa.account(login="bear", email="bear@x.test", admin=True),
                        aa.account(login="mum", disabled=True),
                        aa.account(login="ghost")],
                 "gr": []}
        reach = {5: ["jellyfin", "grafana"], 8: [], 9: ["jellyfin"]}
        got = aa.match(PEOPLE, found, reach, AD)
        self.assertEqual(got["people"][5]["jf"]["status"], "account")
        self.assertEqual(got["people"][5]["jf"]["role"], "admin")
        self.assertEqual(got["people"][8]["jf"], {"status": "stale", "role": "user", "disabled": True,
                                                  "last_seen": None, "login": "mum"})
        self.assertEqual(got["people"][9]["jf"], {"status": "missing", "provision": "manual"})
        self.assertEqual(got["people"][5]["gr"], {"status": "missing", "provision": "first"})
        self.assertNotIn("gr", got["people"][8])
        self.assertEqual([a["login"] for a in got["orphans"]["jf"]], ["ghost"])

    def test_email_beats_login(self):
        # "mum" by login would go to pk 8, but the email names pk 9.
        found = {"jf": [aa.account(login="mum", email="kid@x.test")]}
        got = aa.match(PEOPLE, found, {}, AD)
        self.assertEqual(got["people"][9]["jf"]["login"], "mum")
        self.assertNotIn("jf", got["people"][8])

    def test_account_shape(self):
        self.assertEqual(aa.account(login=" a ", email="A@B.C", name="", last_seen=""),
                         {"login": "a", "email": "a@b.c", "name": None, "role": "user",
                          "disabled": False, "last_seen": None})


if __name__ == "__main__":
    unittest.main()


import asyncio  # noqa: E402
import datetime  # noqa: E402
import json as _json  # noqa: E402


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
    """Answers by path; records what was asked."""
    def __init__(self, routes):
        self.routes, self.seen = routes, []

    async def get(self, url, params=None, headers=None):
        self.seen.append((url, params, headers))
        return self.routes["/" + url.split("/", 3)[-1]]

    async def post(self, url, json=None, headers=None):
        self.seen.append((url, json, headers))
        return self.routes["/" + url.split("/", 3)[-1]]


def run(fn, routes, key="k"):
    c = _Client(routes)
    return asyncio.run(fn(c, "http://app", key)), c


NOW = datetime.datetime.now(datetime.timezone.utc)


class Adapters(unittest.TestCase):
    def test_seerr_pages_and_admin_bit(self):
        users = [{"id": 1, "username": "owner", "email": "o@x", "permissions": 0},
                 {"id": 2, "plexUsername": "mum", "email": "m@x", "permissions": 32},
                 {"id": 3, "jellyfinUsername": "kid", "email": "k@x", "permissions": 2 | 32}]
        got, c = run(aa._seerr, {"/api/v1/user": _Resp({"results": users, "pageInfo": {"results": 3}})})
        self.assertEqual([(a["login"], a["role"]) for a in got], [("owner", "admin"), ("mum", "user"), ("kid", "admin")])
        self.assertEqual(c.seen[0][2], {"X-Api-Key": "k"})

    def test_jellyfin(self):
        recent = (NOW - datetime.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.1234567Z")
        got, c = run(aa._jellyfin, {"/Users": _Resp([
            {"Name": "bear", "Policy": {"IsAdministrator": True, "IsDisabled": False}, "LastActivityDate": recent},
            {"Name": "old", "Policy": {"IsDisabled": True}}])})
        self.assertEqual(got[0]["role"], "admin")
        self.assertTrue(got[0]["last_seen"].startswith(recent[:19]))
        self.assertTrue(got[1]["disabled"])
        self.assertEqual(c.seen[0][1], {"ApiKey": "k"})

    def test_plex_owner_and_xml_friends(self):
        xml = '<MediaContainer><User id="1" username="mum" email="m@x" title="Mum"/><User id="2" title="Kid"/></MediaContainer>'
        got, _ = run(aa._plex, {"/users/account.json": _Resp({"user": {"username": "bear", "email": "b@x"}}),
                                "/api/users": _Resp(None, text=xml)})
        self.assertEqual([(a["login"], a["role"]) for a in got], [("bear", "admin"), ("mum", "user"), ("Kid", "user")])

    def test_audiobookshelf_drops_tokens(self):
        got, _ = run(aa._audiobookshelf, {"/api/users": _Resp({"users": [
            {"username": "root", "type": "root", "isActive": True, "token": "SECRET", "lastSeen": 1_700_000_000_000},
            {"username": "kid", "type": "user", "isActive": False}]})})
        self.assertNotIn("SECRET", _json.dumps(got))
        self.assertEqual(got[0]["role"], "admin")
        self.assertTrue(got[0]["last_seen"].startswith("2023-11-14"))
        self.assertTrue(got[1]["disabled"])

    def test_navidrome_logs_in_and_uses_its_header(self):
        got, c = run(aa._navidrome, {"/auth/login": _Resp({"token": "JWT"}),
                                     "/api/user": _Resp([{"userName": "bear", "isAdmin": True, "email": "b@x"}])},
                     key="admin:pw")
        self.assertEqual(c.seen[0][1], {"username": "admin", "password": "pw"})
        self.assertEqual(c.seen[1][2], {"X-ND-Authorization": "Bearer JWT"})
        self.assertEqual(got[0]["role"], "admin")
        with self.assertRaises(ValueError):
            run(aa._navidrome, {}, key="nopassword")

    def test_grafana_never_seen_sentinel(self):
        got, _ = run(aa._grafana, {"/api/org/users": _Resp([
            {"login": "a", "role": "Admin", "lastSeenAt": "2016-01-01T00:00:00Z"},
            {"login": "b", "role": "Viewer", "isDisabled": True,
             "lastSeenAt": (NOW - datetime.timedelta(days=1)).isoformat()}])})
        self.assertEqual((got[0]["role"], got[0]["last_seen"]), ("admin", None))
        self.assertTrue(got[1]["disabled"] and got[1]["last_seen"])

    def test_paperless_token_prefix_and_others(self):
        got, c = run(aa._paperless, {"/api/users/": _Resp({"results": [
            {"username": "a", "is_superuser": True, "first_name": "A", "last_name": "B", "is_active": True}]})})
        self.assertEqual(c.seen[0][2], {"Authorization": "Token k"})
        self.assertEqual((got[0]["name"], got[0]["role"]), ("A B", "admin"))
        got, _ = run(aa._immich, {"/api/admin/users": _Resp([{"email": "e@x", "isAdmin": False, "status": "deleted"}])})
        self.assertTrue(got[0]["disabled"])
        got, _ = run(aa._mealie, {"/api/admin/users": _Resp({"items": [{"username": "a", "admin": True, "fullName": "A"}]})})
        self.assertEqual(got[0]["role"], "admin")
        got, _ = run(aa._filebrowser, {"/api/users": _Resp([{"username": "a", "permissions": {"admin": True}}])})
        self.assertEqual(got[0]["role"], "admin")
