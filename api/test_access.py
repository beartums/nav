"""access.py: reading and editing Terraform group membership, and the PR body."""
import unittest

import access

TF = {
    "terraform/authentik/access.tf": '''# The access model.
resource "authentik_group" "staff_media" {
  name = "staff-media"
  users = [
    5, # alice
    6, # bob
  ]
}

resource "authentik_group" "admins" {
  name = "nav-admins"
}
''',
    "terraform/authentik/imported.tf": '''resource "authentik_group" "family" {
  name  = "family"
  users = [5, 6, 8]
}
''',
}


class Groups(unittest.TestCase):
    def test_members_and_unmanaged(self):
        g = access.groups(TF)
        self.assertEqual(g["staff-media"]["members"], [5, 6])
        self.assertEqual(g["family"]["members"], [5, 6, 8])
        self.assertIsNone(g["nav-admins"]["members"])           # no users = [...]: not managed here
        self.assertEqual(g["family"]["path"], "terraform/authentik/imported.tf")


class Edit(unittest.TestCase):
    def test_add_and_remove_keep_style_and_comments(self):
        out = access.edit(TF, [
            {"group": "staff-media", "pk": 9, "name": "carol", "action": "add"},
            {"group": "staff-media", "pk": 6, "name": "bob", "action": "remove"},
            {"group": "family", "pk": 9, "name": "carol", "action": "add"},
            {"group": "family", "pk": 8, "name": "mum", "action": "remove"},
        ])
        media = out["terraform/authentik/access.tf"]
        self.assertIn("    5, # alice\n    9, # carol\n  ]", media)
        self.assertNotIn("bob", media)
        self.assertIn("# The access model.", media)
        self.assertIn("users = [5, 6, 9]", out["terraform/authentik/imported.tf"])

    def test_noops_change_nothing(self):
        self.assertEqual(access.edit(TF, [{"group": "family", "pk": 5, "action": "add"},
                                          {"group": "family", "pk": 7, "action": "remove"}]), {})

    def test_refusals(self):
        with self.assertRaises(ValueError):
            access.edit(TF, [{"group": "nav-admins", "pk": 5, "action": "add"}])
        with self.assertRaises(ValueError):
            access.edit(TF, [{"group": "nobody", "pk": 5, "action": "add"}])

    def test_removing_the_last_member(self):
        tf = {"a.tf": 'resource "authentik_group" "x" {\n  name = "x"\n  users = [\n    5, # alice\n  ]\n}\n'}
        out = access.edit(tf, [{"group": "x", "pk": 5, "action": "remove"}])
        self.assertEqual(access.groups(out)["x"]["members"], [])


class Describe(unittest.TestCase):
    def test_body_names_people_groups_and_apps(self):
        body = access.describe([{"pk": 9, "name": "carol", "group": "family", "action": "add"},
                                {"pk": 9, "name": "carol", "group": "staff-media", "action": "remove"}],
                               {9: ["Calibre"]}, {9: ["Sonarr"]})
        self.assertIn("**carol** (9): joins family; leaves staff-media. Apps: gains Calibre; loses Sonarr", body)


if __name__ == "__main__":
    unittest.main()
