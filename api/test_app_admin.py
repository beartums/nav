"""_set_admin: the guards around an app's admin flag (app.py)."""
import asyncio
import os
import unittest

if os.environ.get("NAV_TEST_DSN"):
    os.environ.setdefault("NAV_DSN", os.environ["NAV_TEST_DSN"])
    os.environ.setdefault("NAV_ADMINS", "admin@x")
os.environ.setdefault("NAV_DSN", "postgresql://unused/none")
try:
    import app as nav  # noqa: E402
except ImportError as e:  # CI's unit job is stdlib-only (no fastapi/httpx)
    raise unittest.SkipTest(f"app needs requirements.txt: {e}")
import appaccounts as aa  # noqa: E402


class SetAdmin(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.accounts = [aa.account(login="boss", admin=True, id=1), aa.account(login="liz", email="liz@x.test", id=2)]
        ad = aa.ADAPTERS["jellyfin"]
        self.fetch, self.setter = ad.fetch, aa.ROLES["jellyfin"]

        async def fetch(client, url, key):
            return self.accounts

        async def setter(client, url, key, acc, admin):
            self.calls.append((acc["id"], admin))
        object.__setattr__(ad, "fetch", fetch)
        aa.ROLES["jellyfin"] = setter

    def tearDown(self):
        object.__setattr__(aa.ADAPTERS["jellyfin"], "fetch", self.fetch)
        aa.ROLES["jellyfin"] = self.setter

    def go(self, find, admin):
        return asyncio.run(nav._set_admin(None, "jellyfin", "u", "k", find, admin))

    def test_grant_then_nothing_to_do(self):
        self.assertEqual(self.go(lambda a: a["login"] == "liz", True), "made admin")
        self.assertEqual(self.calls, [("2", True)])
        self.assertEqual(self.go(lambda a: a["login"] == "boss", True), "already admin")
        self.assertEqual(len(self.calls), 1)

    def test_never_the_only_admin(self):
        with self.assertRaises(ValueError):
            self.go(lambda a: a["login"] == "boss", False)
        self.assertEqual(self.calls, [])

    def test_finds_the_new_account_by_email_or_username(self):
        p = {"username": "Liz", "email": "liz@x.test", "name": "Liz G"}
        self.assertTrue(nav._is_person(aa.account(login="other", email="liz@x.test"), p))
        self.assertTrue(nav._is_person(aa.account(login="liz"), p))
        self.assertFalse(nav._is_person(aa.account(login="lizzy"), p))

    def test_how(self):
        os.environ["NAV_APP_ADMIN_GROUP"] = "immich=family-admins,audiobookshelf=family-admins"
        try:
            self.assertEqual(nav._admin_how("immich")["also"][0], "Audiobookshelf")
            self.assertEqual(nav._admin_how("jellyfin"), {"how": "app"})
            self.assertIsNone(nav._admin_how("plex"))
        finally:
            del os.environ["NAV_APP_ADMIN_GROUP"]
