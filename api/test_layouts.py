"""layouts.py: the template/dashboard rules, without a database."""
import unittest

from layouts import (LAYOUT_KEYS, PRESENTATION_KEYS, clean_groups, clean_name, merge, split,
                     tile_fields, tile_layer)


class Fields(unittest.TestCase):
    def test_split_is_a_partition(self):
        f = {"name": "Plex", "icon": "x", "category": "Media", "order": 0, "size": "XS"}
        pres, lay = split(f)
        self.assertEqual(pres, {"name": "Plex", "icon": "x"})
        self.assertEqual(lay, {"category": "Media", "order": 0, "size": "XS"})
        self.assertFalse(set(LAYOUT_KEYS) & set(PRESENTATION_KEYS))

    def test_template_refuses_presentation(self):
        self.assertEqual(tile_fields("template", {"size": "S", "order": 0}), {"size": "S", "order": 0})
        with self.assertRaisesRegex(ValueError, "site-wide"):
            tile_fields("template", {"name": "Films"})

    def test_dashboard_may_rename(self):
        self.assertEqual(tile_fields("dashboard", {"name": "Films", "size": "S"})["name"], "Films")

    def test_unknown_field_refused(self):
        with self.assertRaisesRegex(ValueError, "unknown"):
            tile_fields("dashboard", {"colur": "red"})


class Layers(unittest.TestCase):
    OWN = {"plex": {"category": "Mine", "order": 0}}
    TPL = {"plex": {"category": "Media", "hidden": True}, "seer": {"category": "Media", "order": 3}}

    def test_own_row_wins_whole(self):
        # NOT blended: the template's hidden must not reach a dashboard row.
        self.assertEqual(tile_layer("plex", "dashboard", self.OWN, self.TPL),
                         {"category": "Mine", "order": 0})

    def test_dashboard_falls_back_to_template_for_new_apps(self):
        self.assertEqual(tile_layer("seer", "dashboard", self.OWN, self.TPL)["category"], "Media")

    def test_template_has_no_fallback(self):
        self.assertEqual(tile_layer("seer", "template", {}, self.TPL), {})

    def test_merge_keeps_zero_and_false(self):
        m = merge({"order": None, "hidden": True}, {"order": 0, "hidden": False, "name": ""})
        self.assertEqual((m["order"], m["hidden"]), (0, False))
        self.assertNotIn("name", m)


class Names(unittest.TestCase):
    def test_name_is_trimmed_and_bounded(self):
        self.assertEqual(clean_name("  Family   page "), "Family page")
        with self.assertRaises(ValueError):
            clean_name("  ")
        with self.assertRaises(ValueError):
            clean_name("x" * 61)

    def test_groups(self):
        self.assertEqual(clean_groups([" Media", "Media", "", "Tools"], "order"), ["Media", "Tools"])
        with self.assertRaises(ValueError):
            clean_groups("Media", "order")


if __name__ == "__main__":
    unittest.main()
