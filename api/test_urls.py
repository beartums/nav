"""Run: python3 -m unittest discover -s api -p 'test_*.py'

stdlib only, and urls.py imports nothing, so this runs in CI without
installing FastAPI or psycopg.
"""
import unittest

from urls import group_can_see, launchable, offered_to, pick_account, valid_slug


class Launchable(unittest.TestCase):
    def test_real_urls_pass(self):
        for u in ("https://sonarr.example.com",
                  "http://192.0.2.5:8080/x",
                  "HTTPS://Books.Example.Com",
                  "/relative/path",
                  "//cdn.example/app"):
            self.assertTrue(launchable(u), u)

    def test_blank_sentinel_is_not_a_tile(self):
        # The regression. Authentik's "no launch page" sentinel is a non-empty
        # string, so `if not url` passed it through and Pomerium rendered as a
        # tile that did nothing when clicked. terraform/authentik/pomerium.tf
        # sets it deliberately.
        self.assertFalse(launchable("blank://blank"))

    def test_empty_and_missing(self):
        for u in (None, "", "   "):
            self.assertFalse(launchable(u), repr(u))

    def test_non_navigable_schemes_stay_out_of_hrefs(self):
        # This value is admin-set, so not much of a vector -- but it goes into
        # an href unescaped, and a scheme check excludes it for free.
        for u in ("javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd",
                  "mailto:someone@example.com", "blank:"):
            self.assertFalse(launchable(u), u)


if __name__ == "__main__":
    unittest.main()


class Slugs(unittest.TestCase):
    def test_accepts_what_authentik_uses(self):
        for sl in ("adguard", "pihole2", "nav-api", "a", "0"):
            self.assertTrue(valid_slug(sl), sl)

    def test_rejects_anything_that_would_not_survive_a_url_or_filename(self):
        # The slug is a primary key, an icon path (icons/<slug>.svg) and a URL
        # segment. Path traversal and case are the ones that matter.
        for sl in (None, "", "-lead", "trail-", "Upper", "has space", "../etc",
                   "a/b", "x" * 64, "emoji✨"):
            self.assertFalse(valid_slug(sl), repr(sl))


class OfferedTo(unittest.TestCase):
    def test_empty_means_everyone(self):
        self.assertTrue(offered_to([], {"family"}))
        self.assertTrue(offered_to(None, set()))

    def test_matches_case_insensitively(self):
        self.assertTrue(offered_to(["Staff"], {"staff"}))
        self.assertTrue(offered_to([" staff "], {"staff"}))

    def test_no_overlap_is_not_offered(self):
        self.assertFalse(offered_to(["staff"], {"family"}))
        self.assertFalse(offered_to(["staff"], set()))


class OfferedToUsers(unittest.TestCase):
    def test_user_entries_match_the_caller(self):
        self.assertTrue(offered_to(["user:evan@x"], set(), "evan@x"))
        self.assertTrue(offered_to(["user:Evan@X"], set(), "evan@x"))
        self.assertFalse(offered_to(["user:evan@x"], set(), "other@x"))

    def test_bare_entries_are_still_groups(self):
        # Rows written before users could be picked hold bare group names.
        # Rewriting them would be a migration for no behaviour change.
        self.assertTrue(offered_to(["family"], {"family"}))
        self.assertTrue(offered_to(["group:family"], {"family"}))

    def test_several_selections_are_or(self):
        self.assertTrue(offered_to(["group:staff", "user:evan@x"], set(), "evan@x"))
        self.assertTrue(offered_to(["group:staff", "user:evan@x"], {"staff"}, "no@x"))
        self.assertFalse(offered_to(["group:staff", "user:evan@x"], {"family"}, "no@x"))

    def test_no_identity_never_matches_a_user_entry(self):
        # whoami() fails closed, but a blank must not match a blank.
        self.assertFalse(offered_to(["user:"], set(), ""))
        self.assertFalse(offered_to(["user:evan@x"], set(), ""))


class PickAccount(unittest.TestCase):
    def test_one_match_is_the_answer(self):
        self.assertEqual(pick_account([{"pk": 5, "username": "owner"}]), (5, None))

    def test_no_match_is_not_an_error(self):
        # A person with no Authentik account gets an empty dashboard, which is
        # correct and not something to raise about.
        self.assertEqual(pick_account([]), (None, None))

    def test_two_accounts_on_one_email_is_refused(self):
        # The real case: akadmin carried owner@example.com, sorted
        # first, and its only app is pomerium (blank:// -> dropped). The
        # dashboard rendered empty with nothing logged.
        pk, err = pick_account([{"pk": 4, "username": "akadmin"},
                                {"pk": 5, "username": "owner"}])
        self.assertIsNone(pk, "must not guess -- guessing is what produced a blank page")
        self.assertIn("akadmin", err, "name the accounts so the fix is obvious")
        self.assertIn("owner", err)
        self.assertIn("2 Authentik accounts", err)

    def test_the_error_names_the_likely_culprit(self):
        _, err = pick_account([{"pk": 4, "username": "akadmin"},
                               {"pk": 5, "username": "x"}])
        self.assertIn("built-in admin", err)


class GroupCanSee(unittest.TestCase):
    """The rule behind "view as <group>": a user in that group and no other."""

    def test_no_bindings_is_open_to_every_authenticated_user(self):
        # Authentik's actual default, and a real state here -- six unbound
        # applications were closed in 2026-09 for exactly this.
        self.assertIs(group_can_see([], "family"), True)

    def test_a_matching_group_binding_grants(self):
        self.assertIs(group_can_see([{"group_obj": {"name": "family"}}], "family"), True)
        self.assertIs(group_can_see([{"group_obj": {"name": "Family"}}], "family"), True)

    def test_another_groups_binding_does_not(self):
        self.assertIs(group_can_see([{"group_obj": {"name": "staff"}}], "family"), False)

    def test_a_user_binding_never_grants(self):
        # A hypothetical group-only user is nobody in particular, so mom's
        # direct audiobookshelf binding must NOT appear under "view as family".
        self.assertIs(group_can_see([{"user": 8}], "family"), False)

    def test_any_mode_is_or(self):
        b = [{"group_obj": {"name": "staff"}}, {"group_obj": {"name": "family"}}]
        self.assertIs(group_can_see(b, "family", "any"), True)

    def test_all_mode_requires_every_binding(self):
        b = [{"group_obj": {"name": "staff"}}, {"group_obj": {"name": "family"}}]
        self.assertIs(group_can_see(b, "family", "all"), False)
        self.assertIs(group_can_see([{"group_obj": {"name": "family"}}], "family", "all"), True)

    def test_disabled_bindings_are_ignored(self):
        # The only binding is off, so nothing constrains the app.
        self.assertIs(group_can_see([{"group_obj": {"name": "staff"}, "enabled": False}],
                                    "family"), True)

    def test_what_it_cannot_read_returns_none(self):
        # 🔴 The expiry date on this whole approach. A policy binding needs
        # Authentik's engine; guessing either way would be wrong in a screen
        # whose only value is being trusted.
        self.assertIsNone(group_can_see([{"policy": "some-uuid"}], "family"))
        self.assertIsNone(group_can_see([{"group_obj": {"name": "family"}, "negate": True}],
                                        "family"))
