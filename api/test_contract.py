"""The keys /api/apps must return, checked against app.py's source.

WHY THIS IS A SOURCE CHECK AND NOT A REAL REQUEST
  app.py imports FastAPI, httpx and psycopg and wants a database; standing one
  up here would be a different kind of test suite. But the failure this guards
  is not subtle behaviour, it is a MISSING KEY -- and that is visible in the
  return statement.

WHY IT EXISTS AT ALL
  "View as" shipped invisible on 2026-09-29. The page reads
  `data.may_impersonate` from the /api/apps reply; the flag had been added to
  /api/me instead, and the page never calls /api/me. The jsdom suite passed
  because its fetch stub is a FIXTURE -- the flag was written into the fake
  payload, so the test proved the stub agreed with the page and said nothing
  about the server. Every browser-side test has that blind spot; this is the
  seam it cannot see.
"""
import pathlib
import re
import unittest

APP = pathlib.Path(__file__).with_name("app.py").read_text()

# Keys the page (ui/) reads off the /api/apps response.
REQUIRED = ["user", "admin", "apps", "may_impersonate", "impersonating"]


class AppsResponse(unittest.TestCase):
    def setUp(self):
        m = re.search(r"\n    return \{\"user\": who, \"admin\": is_admin_,.*?\n\n",
                      APP, re.S)
        self.assertIsNotNone(m, "could not find list_apps' return; update this test")
        self.ret = m.group(0)

    def test_every_key_the_page_reads_is_returned(self):
        for key in REQUIRED:
            self.assertIn(f'"{key}"', self.ret,
                          f"/api/apps must return {key!r} -- the page reads it on load, "
                          f"and it makes no other call to find it")


class UiAgrees(unittest.TestCase):
    """The other half: the page must actually read what we claim it reads."""

    def test_ui_reads_the_flag_from_the_apps_reply(self):
        # The page's scripts live in ui/static/ since 2026-10-10; read them all.
        root = pathlib.Path(__file__).parents[1] / "ui"
        ui = "".join(f.read_text() for f in [root / "index.html", *sorted(root.glob("static/*.js"))])
        self.assertIn("data.may_impersonate", ui)
        # /api/me is not fetched on load; if that ever changes, this test
        # should be revisited rather than silently left as a half-truth.
        self.assertNotIn("fetch('api/me'", ui)


if __name__ == "__main__":
    unittest.main()
