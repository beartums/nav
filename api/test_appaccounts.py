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

    def test_plex_home_managed_profiles(self):
        home = ('<MediaContainer><User id="1" admin="1" restricted="0" username="bear" email="b@x" title="bear"/>'
                '<User id="4" admin="0" restricted="1" title="Tucker"/>'
                '<User id="5" admin="0" restricted="0" username="mum" email="m@x" title="Mum"/></MediaContainer>')
        friends = '<MediaContainer><User id="5" username="mum" email="m@x" title="Mum"><Server machineIdentifier="M1"/></User></MediaContainer>'
        got, _ = run(aa._plex, {"/identity": _Resp({"MediaContainer": {"machineIdentifier": "M1"}}),
                                "/users/account.json": _Resp({"user": {"username": "bear", "email": "b@x"}}),
                                "/api/users": _Resp(None, text=friends), "/api/home/users": _Resp(None, text=home)})
        self.assertEqual([a["login"] for a in got], ["bear", "mum", "Tucker"], "owner and listed friends once")
        self.assertIsNone(got[2]["email"])
        self.assertIn("managed", got[2]["note"])


    def test_email_beats_login(self):
        # "mum" by login would go to pk 8, but the email names pk 9.
        found = {"jf": [aa.account(login="mum", email="kid@x.test")]}
        got = aa.match(PEOPLE, found, {}, AD)
        self.assertEqual(got["people"][9]["jf"]["login"], "mum")
        self.assertNotIn("jf", got["people"][8])

    def test_name_only_for_an_account_with_no_email(self):
        people = PEOPLE + [{"pk": 11, "username": "tg", "email": "tg@x.test", "name": "Tucker Smith"}]
        found = {"jf": [aa.account(login="Tucker", name="Tucker"),                       # managed: no email
                        aa.account(login="Tucker2", email="other@x.test", name="Tucker Smith")]}
        got = aa.match(people, found, {}, AD)
        self.assertEqual(got["people"][11]["jf"]["login"], "Tucker", "first name, no email: matched")
        self.assertEqual([a["login"] for a in got["orphans"]["jf"]], ["Tucker2"],
                         "an account WITH an email never matches by name")

    def test_email_shaped_login_matches_as_email(self):
        # FileBrowser behind a proxy: the username is the email, no email field.
        found = {"jf": [aa.account(login="Kid@x.test")]}
        got = aa.match(PEOPLE, found, {}, AD)
        self.assertEqual(got["people"][9]["jf"]["login"], "Kid@x.test")
        self.assertEqual(got["orphans"]["jf"], [])

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
    def __init__(self, body, status=200, text=None, cookies=None):
        self.status_code, self._body, self.cookies = status, body, cookies or {}
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

    def test_plex_owner_and_friends_sharing_this_server(self):
        xml = ('<MediaContainer><User id="1" username="mum" email="m@x" title="Mum"><Server machineIdentifier="M1"/></User>'
               '<User id="2" title="Kid"><Server machineIdentifier="M1"/></User>'
               '<User id="3" username="elsewhere"><Server machineIdentifier="OTHER"/></User></MediaContainer>')
        got, c = run(aa._plex, {"/identity": _Resp({"MediaContainer": {"machineIdentifier": "M1"}}),
                                "/users/account.json": _Resp({"user": {"username": "bear", "email": "b@x"}}),
                                "/api/users": _Resp(None, text=xml),
                                "/api/home/users": _Resp(None, status=401, text="")})
        self.assertEqual([(a["login"], a["role"]) for a in got], [("bear", "admin"), ("mum", "user"), ("Kid", "user")])
        self.assertTrue(c.seen[0][0].startswith("http://app/identity"), "the local server first")
        self.assertTrue(c.seen[1][0].startswith("https://plex.tv/"), "then plex.tv")

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

    def test_music_assistant_drops_service_accounts(self):
        got, c = run(aa._music_assistant, {"/api": _Resp([
            {"username": "bear", "display_name": "Bear", "role": "admin", "enabled": True},
            {"username": "kid", "role": "user", "enabled": False},
            {"username": "ha", "role": "service", "enabled": True}])})
        self.assertEqual(c.seen[0][1], {"command": "auth/users", "args": {}})
        self.assertEqual(c.seen[0][2], {"Authorization": "Bearer k"})
        self.assertEqual([(a["login"], a["role"], a["disabled"]) for a in got],
                         [("bear", "admin", False), ("kid", "user", True)])

    def test_memos_pages_and_archived(self):
        class Paged(_Client):
            async def get(self, url, params=None, headers=None):
                self.seen.append((url, params, headers))
                if not params.get("pageToken"):
                    return _Resp({"users": [{"name": "users/bear", "username": "bear", "role": "ADMIN",
                                             "email": "B@x"}], "nextPageToken": "p2"})
                return _Resp({"users": [{"name": "users/old", "role": "USER", "state": "ARCHIVED"}]})
        c = Paged({})
        got = asyncio.run(aa._memos(c, "http://app", "k"))
        self.assertEqual(c.seen[0][0], "http://app/api/users")
        self.assertEqual(c.seen[1][1]["pageToken"], "p2")
        self.assertEqual([(a["login"], a["role"], a["disabled"]) for a in got],
                         [("bear", "admin", False), ("old", "user", True)])

    def test_aurral(self):
        got, c = run(aa._aurral, {"/api/users": _Resp([{"username": "bear", "role": "admin", "status": "active"},
                                                       {"username": "kid", "role": "user", "status": "suspended"}])})
        self.assertEqual(c.seen[0][2], {"X-Api-Key": "k"})
        self.assertEqual([(a["role"], a["disabled"]) for a in got], [("admin", False), ("user", True)])

    def test_affine_signs_in_and_reads_with_the_session(self):
        got, c = run(aa._affine, {
            "/api/auth/sign-in": _Resp({}, cookies={"affine_session": "S", "affine_user_id": "U"}),
            "/graphql": _Resp({"data": {"users": [{"email": "b@x", "name": "Bear", "features": ["administrator"]},
                                                  {"email": "k@x", "disabled": True, "features": []}]}})},
            key="b@x:pa:ss")
        self.assertEqual(c.seen[0][1], {"email": "b@x", "password": "pa:ss"})
        self.assertEqual(c.seen[1][2], {"Cookie": "affine_session=S; affine_user_id=U"})
        self.assertEqual([(a["login"], a["role"], a["disabled"]) for a in got],
                         [("b@x", "admin", False), ("k@x", "user", True)])
        with self.assertRaises(ValueError):
            run(aa._affine, {"/api/auth/sign-in": _Resp({}), "/graphql": _Resp({"errors": [{"message": "no"}]})},
                key="b@x:pw")
        with self.assertRaises(ValueError):
            run(aa._affine, {}, key="nopassword")

    def test_pingvin_signs_in_and_sends_the_cookie(self):
        got, c = run(aa._pingvin, {"/api/auth/signIn": _Resp({"accessToken": "JWT"}),
                                   "/api/users": _Resp([{"username": "bear", "email": "b@x", "isAdmin": True}])},
                     key="bear:pw")
        self.assertEqual(c.seen[0][1], {"username": "bear", "password": "pw"})
        self.assertEqual(c.seen[1][2], {"Cookie": "access_token=JWT"})
        self.assertEqual(got[0]["role"], "admin")
        _, c = run(aa._pingvin, {"/api/auth/signIn": _Resp({"accessToken": "J"}), "/api/users": _Resp([])},
                   key="b@x:pw")
        self.assertEqual(c.seen[0][1], {"email": "b@x", "password": "pw"})


class SigninTest(unittest.TestCase):
    def test_every_adapter_has_a_known_signin(self):
        for a in aa.ADAPTERS.values():
            self.assertIn(a.signin, aa.SIGNIN, a.key)

    def test_env_overrides_one_app(self):
        self.assertEqual(aa.signin_of("mealie", "navidrome=header, mealie=oidc"), "oidc")
        self.assertEqual(aa.signin_of("mealie", "mealie=bogus"), aa.ADAPTERS["mealie"].signin)
        self.assertEqual(aa.signin_of("jellyfin", ""), "own")
