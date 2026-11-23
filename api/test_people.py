"""people.py (adding a person) and access.py's edge allow-list edits."""
import asyncio
import json as _json
import unittest

import access
import people


class Validate(unittest.TestCase):
    def test_good_and_defaults(self):
        p = people.validate({"username": "alex", "name": "  Alex   Doe ", "email": "a@x.test"})
        self.assertEqual((p["name"], p["signin"]), ("Alex Doe", "google"))
        self.assertEqual(p["groups"], people.DEFAULT_GROUPS)
        p = people.validate({"username": "a.b-c_d", "name": "A", "email": "a@x.test", "signin": "password",
                             "groups": ["family", "family", " staff "]})
        self.assertEqual(p["groups"], ["family", "staff"])

    def test_refusals_name_the_field(self):
        for body, field in (({"username": "Alex", "name": "A", "email": "a@x.test"}, "username"),
                            ({"username": "a", "name": "A", "email": "a@x.test"}, "username"),
                            ({"username": "al ex", "name": "A", "email": "a@x.test"}, "username"),
                            ({"username": "alex", "name": "", "email": "a@x.test"}, "name"),
                            ({"username": "alex", "name": "A", "email": "nope"}, "email"),
                            ({"username": "alex", "name": "A", "email": "a@x.test", "signin": "sms"}, "signin"),
                            ({"username": "alex", "name": "A", "email": "a@x.test", "groups": "family"}, "groups")):
            with self.assertRaises(ValueError) as cm:
                people.validate(body)
            self.assertTrue(str(cm.exception).startswith(field), cm.exception)

    def test_outside(self):
        self.assertIsNone(people.outside("a@x.test", ""))
        self.assertFalse(people.outside("A@Home.Test", "home.test"))
        self.assertTrue(people.outside("a@gmail.test", "home.test"))
        self.assertTrue(people.outside("a@nothome.test", "home.test"), "a suffix isn't the domain")

    def test_password(self):
        pw = people.password()
        self.assertEqual(len(pw), 16)
        self.assertFalse(set(pw) & set("O0Il1"))
        self.assertNotEqual(pw, people.password())

    def test_public_link(self):
        link = "http://authentik-server.authentik.svc/if/flow/recover/?flow_token=T"
        self.assertEqual(people.public_link(link, "https://auth.x.test"), "https://auth.x.test/if/flow/recover/?flow_token=T")
        self.assertEqual(people.public_link(link, ""), link)


class _Resp:
    def __init__(self, body, status=200):
        self.status_code, self._body = status, body
        self.text = _json.dumps(body)
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class _Client:
    def __init__(self, answer):
        self.answer, self.seen = answer, []

    async def get(self, url, params=None):
        self.seen.append(("GET", url, params))
        return self.answer("GET", url, params)

    async def post(self, url, json=None):
        self.seen.append(("POST", url, json))
        return self.answer("POST", url, json)


def run(coro):
    return asyncio.run(coro)


class Authentik(unittest.TestCase):
    def test_conflicts_check_each_field_and_skip_empty(self):
        c = _Client(lambda m, u, p: _Resp({"pagination": {"count": 1 if p.get("email") else 0}, "results": []}))
        self.assertEqual(run(people.conflicts(c, "alex", "a@x.test")), ["email"])
        self.assertEqual([s[2] for s in c.seen], [{"username": "alex", "page_size": 1},
                                                 {"email": "a@x.test", "page_size": 1}])
        c = _Client(lambda m, u, p: _Resp({"pagination": {"count": 9}}))
        self.assertEqual(run(people.conflicts(c, "", "")), [], "an empty filter would match everyone")

    def test_create_sends_what_the_runbook_sends(self):
        c = _Client(lambda m, u, b: _Resp({"pk": 12, **b}, 201))
        u = run(people.create(c, {"username": "alex", "name": "Alex", "email": "a@x.test"}))
        self.assertEqual(u["pk"], 12)
        self.assertEqual(c.seen[0][1:], ("/api/v3/core/users/", {
            "username": "alex", "name": "Alex", "email": "a@x.test", "is_active": True, "path": "users",
            "type": "internal"}))
        with self.assertRaises(ValueError):
            run(people.create(_Client(lambda m, u, b: _Resp({}, 201)), {"username": "a", "name": "A", "email": "e"}))

    def test_recovery_link_and_no_flow(self):
        c = _Client(lambda m, u, b: _Resp({"link": "http://in/if/flow/r/?flow_token=T"}))
        self.assertTrue(run(people.recovery_link(c, 12)).endswith("/if/flow/r/?flow_token=T"))
        self.assertEqual(c.seen[0][1], "/api/v3/core/users/12/recovery/")
        c = _Client(lambda m, u, b: _Resp({"non_field_errors": ["No recovery flow set."]}, 400))
        with self.assertRaises(ValueError) as cm:
            run(people.recovery_link(c, 12))
        self.assertIn("No recovery flow set.", str(cm.exception))

    def test_set_password(self):
        c = _Client(lambda m, u, b: _Resp(None, 204))
        run(people.set_password(c, 12, "pw"))
        self.assertEqual(c.seen[0][1:], ("/api/v3/core/users/12/set_password/", {"password": "pw"}))
        with self.assertRaises(ValueError):
            run(people.set_password(_Client(lambda m, u, b: _Resp({}, 400)), 12, "pw"))


# The shape the provider writes when a policy is imported: every include
# attribute spelled out, one `email = { email = ... }` per entry.
ENTRY = """    {
      any_valid_service_token = null
      email = {
        email = "%s"
      }
      email_domain = null
      everyone     = null
    },
"""
CF = ('resource "cloudflare_zero_trust_access_policy" "other" {\n  include = [\n' + ENTRY % "x@elsewhere.test" +
      '  ]\n}\n\nresource "cloudflare_zero_trust_access_policy" "policy_" {\n  decision = "allow"\n  include = [\n' +
      ENTRY % "first@mail.test" + '  ]\n  name = "*@*.*"\n}\n')


class EdgeAllowList(unittest.TestCase):
    def test_read(self):
        self.assertEqual(access.cf_emails(CF, "policy_"), ["first@mail.test"])
        self.assertIsNone(access.cf_emails(CF, "missing"))

    def test_add_copies_an_entry_and_touches_only_that_policy(self):
        out = access.cf_add(CF, "new@mail.test", "policy_")
        self.assertEqual(access.cf_emails(out, "policy_"), ["first@mail.test", "new@mail.test"])
        self.assertEqual(access.cf_emails(out, "other"), ["x@elsewhere.test"])
        self.assertIn(ENTRY % "new@mail.test", out, "the copy keeps every other attribute")
        self.assertEqual(access.cf_add(out, "NEW@mail.test", "policy_"), out, "already there: unchanged")

    def test_refusals(self):
        with self.assertRaises(ValueError):
            access.cf_add(CF, "a@b.test", "missing")
        bare = 'resource "cloudflare_zero_trust_access_policy" "policy_" {\n  include = []\n}\n'
        with self.assertRaises(ValueError):
            access.cf_add(bare, "a@b.test", "policy_")

    def test_edit_all_puts_both_in_one_change(self):
        tf = {"tf/a.tf": 'resource "authentik_group" "family" {\n  name = "family"\n  users = [\n    5, # bear\n  ]\n}\n',
              "cf/imported.tf": CF}
        old = access.CF_FILE, access.CF_POLICY
        access.CF_FILE, access.CF_POLICY = "cf/imported.tf", "policy_"
        try:
            changed = access.edit_all(tf, [{"group": "family", "pk": 12, "name": "alex", "action": "add"}],
                                      [{"email": "alex@mail.test", "name": "alex", "pk": 12}])
            self.assertEqual(sorted(changed), ["cf/imported.tf", "tf/a.tf"])
            self.assertIn("12, # alex", changed["tf/a.tf"])
            self.assertIn("alex@mail.test", changed["cf/imported.tf"])
            body = access.describe([{"group": "family", "pk": 12, "name": "alex", "action": "add"}], {}, {},
                                   [{"email": "alex@mail.test", "name": "alex", "pk": 12}])
            self.assertIn("outside access for `alex@mail.test`", body)
            self.assertIn("and `cf`", body)
            access.CF_FILE = "cf/elsewhere.tf"
            with self.assertRaises(ValueError):
                access.edit_all(tf, [], [{"email": "a@b.test", "name": "a", "pk": 1}])
        finally:
            access.CF_FILE, access.CF_POLICY = old


if __name__ == "__main__":
    unittest.main()
