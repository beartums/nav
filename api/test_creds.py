"""creds.py: validation, precedence, and that a key never comes back out.

Standard library only; the encryption round trip runs where `cryptography` is
installed (the image, a dev venv) and is skipped in CI's stdlib-only run.
"""
import importlib.util
import os
import unittest
from unittest import mock

import creds

HAVE_CRYPTO = importlib.util.find_spec("cryptography") is not None


class Inputs(unittest.TestCase):
    def test_urls(self):
        self.assertEqual(creds.clean_url(" http://x:8989/ ", "url"), "http://x:8989")
        self.assertIsNone(creds.clean_url("", "url"), "empty goes back to the default")
        for bad in ("ftp://x", "x:8989", "http://", "http://x/?a=1", 5):
            with self.assertRaises(creds.CredError):
                creds.clean_url(bad, "url")

    def test_keys(self):
        self.assertEqual(creds.clean_key(" abc123 "), "abc123")
        for bad in ("", "a b", "x" * 600, None):
            with self.assertRaises(creds.CredError):
                creds.clean_key(bad)
        self.assertEqual(creds.hint("0123456789abcdef"), "…cdef")
        self.assertEqual(creds.hint("short"), "…", "a short key gives nothing away")


class Precedence(unittest.TestCase):
    def setUp(self):
        creds.STORED.clear()

    def tearDown(self):
        creds.STORED.clear()

    def test_database_then_env_then_default(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(creds, "APP_DOMAIN", "example.com"):
            self.assertEqual(creds.resolve("sonarr"),
                             ("http://sonarr.media.svc.cluster.local:8989", "",
                              "https://sonarr.example.com"))
        with mock.patch.dict(os.environ, {"NAV_SONARR_URL": "http://env:1", "NAV_SONARR_KEY": "envkey"},
                             clear=True):
            self.assertEqual(creds.resolve("sonarr")[:2], ("http://env:1", "envkey"))
            creds.STORED["sonarr"] = {"url": "http://db:2"}
            self.assertEqual(creds.resolve("sonarr")[:2], ("http://db:2", "envkey"),
                             "a stored URL with no stored key keeps the env key")
            creds.STORED["sonarr"]["secret"] = "garbage"
            self.assertEqual(creds.resolve("sonarr")[1], "",
                             "a stored key that will not open is NOT silently replaced by env")
            self.assertEqual(creds.describe("sonarr")["key"], "unreadable")

    def test_nothing_is_stored_in_the_clear(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(creds.can_store())
            with self.assertRaisesRegex(creds.CredError, "NAV_SECRET_KEY"):
                creds.seal("abc")

    def test_headers(self):
        self.assertEqual(creds.headers("mealie", "k"), {"Authorization": "Bearer k"})
        self.assertEqual(creds.headers("radarr", "k"), {"X-Api-Key": "k"})


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed (CI's stdlib-only run)")
class Sealed(unittest.TestCase):
    def tearDown(self):
        creds.STORED.clear()

    def test_round_trip_and_describe_never_shows_the_key(self):
        with mock.patch.dict(os.environ, {"NAV_SECRET_KEY": "pass phrase"}, clear=True):
            token = creds.seal("sekrit-key-1234")
            self.assertNotIn("sekrit", token)
            self.assertEqual(creds.unseal(token), "sekrit-key-1234")
            creds.STORED["radarr"] = {"secret": token, "hint": creds.hint("sekrit-key-1234")}
            self.assertEqual(creds.resolve("radarr")[1], "sekrit-key-1234")
            shown = creds.describe("radarr")
            self.assertEqual((shown["key"], shown["hint"]), ("stored", "…1234"))
            self.assertNotIn("sekrit", repr(shown))
        with mock.patch.dict(os.environ, {"NAV_SECRET_KEY": "another"}, clear=True):
            self.assertIsNone(creds.unseal(token), "a changed master key reads as no key")


if __name__ == "__main__":
    unittest.main()


class QueryKeys(unittest.TestCase):
    def test_a_query_key_goes_in_params_not_headers(self):
        self.assertEqual(creds.params("ticketmaster", "k1"), {"apikey": "k1"})
        self.assertEqual(creds.headers("ticketmaster", "k1"), {})
        self.assertEqual(creds.params("sonarr", "k1"), {})
