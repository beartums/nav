"""remote.py, and custom connections in creds.py. Standard library only."""
import unittest

import creds
import remote
import widgets


class Checks(unittest.TestCase):
    def test_url(self):
        self.assertEqual(remote.clean_url(" https://x.lan/w?a=1 "), "https://x.lan/w?a=1")
        for bad in ("ftp://x", "https://", "https://u:p@x/", "https://x/#f", "x.lan/w"):
            with self.assertRaises(ValueError):
                remote.clean_url(bad)

    def test_app_and_ttl(self):
        self.assertEqual(remote.clean_app(" Sonarr "), "sonarr")
        self.assertEqual(remote.clean_app("*"), "*")
        with self.assertRaises(ValueError):
            remote.clean_app("a b")
        self.assertEqual((remote.ttl(1), remote.ttl(99999), remote.ttl("x")), (15, 3600, 300))

    def test_body(self):
        self.assertEqual(remote.body(200, b'{"value": 3}', False), {"value": 3})
        with self.assertRaisesRegex(ValueError, "^disk full$"):
            remote.body(200, b'{"error": "disk full"}', False)
        with self.assertRaisesRegex(ValueError, "^nope$"):
            remote.body(500, b'{"error": "nope"}', False)
        with self.assertRaisesRegex(ValueError, "redirects"):
            remote.body(302, b"", False)
        with self.assertRaisesRegex(ValueError, "HTTP 404"):
            remote.body(404, b"<html>", False)
        with self.assertRaisesRegex(ValueError, "object"):
            remote.body(200, b"[1]", False)
        with self.assertRaisesRegex(ValueError, "not JSON"):
            remote.body(200, b"hi", False)
        with self.assertRaisesRegex(ValueError, "kB"):
            remote.body(200, b"{}", True)


class Custom(unittest.TestCase):
    def setUp(self):
        creds.STORED.clear()
        creds.STORED["printer"] = {"custom": True, "url": "https://ink.lan/api", "auth": "header:X-Token",
                                   "label": "Printer"}

    def tearDown(self):
        creds.STORED.clear()

    def test_custom_connection(self):
        self.assertTrue(creds.exists("printer"))
        self.assertIn("printer", creds.slugs())
        self.assertEqual(creds.headers("printer", "k"), {"X-Token": "k"})
        self.assertTrue(creds.key_ok_for("printer", "https://ink.lan/api/status"))
        self.assertTrue(creds.key_ok_for("printer", "https://ink.lan/api?x=1"))
        self.assertFalse(creds.key_ok_for("printer", "https://ink.lan/apiary"), "a path boundary")
        self.assertFalse(creds.key_ok_for("printer", "https://evil.example/api"))
        d = creds.describe("printer")
        self.assertEqual((d["custom"], d["key"], d["label"]), (True, "none", "Printer"))

    def test_names_and_auth(self):
        self.assertEqual(creds.clean_slug(" Ink-1 "), "ink-1")
        for bad in ("sonarr", "-x", "a b", ""):
            with self.assertRaises(creds.CredError):
                creds.clean_slug(bad)
        self.assertEqual(creds.clean_auth("header:X-Key"), "header:X-Key")
        with self.assertRaises(creds.CredError):
            creds.clean_auth("header:bad header")


class Framework(unittest.TestCase):
    def test_a_config_can_say_everyone(self):
        P = type("P", (widgets.Provider,), {"type": "t.r", "app": widgets.EVERYONE, "shape": "list",
                                             "needs": classmethod(lambda c, cfg: {cfg["app"]})})
        self.assertTrue(widgets.allowed(P, {"app": widgets.EVERYONE}, set()))
        self.assertFalse(widgets.allowed(P, {"app": "sonarr"}, set()))

    def test_per_user_by_config_splits_the_cache(self):
        P = type("P", (widgets.Provider,), {"type": "t.r", "app": "x", "shape": "list",
                                             "per_user_for": classmethod(lambda c, cfg: cfg.get("per_user"))})
        a = widgets.Cache.key(P, {"per_user": True}, "a@x")
        b = widgets.Cache.key(P, {"per_user": True}, "b@x")
        self.assertNotEqual(a, b)
        self.assertEqual(widgets.Cache.key(P, {}, "a@x"), widgets.Cache.key(P, {}, "b@x"))


if __name__ == "__main__":
    unittest.main()
