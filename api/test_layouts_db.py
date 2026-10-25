"""Templates and dashboards against a REAL Postgres: the migration and the routes.

Skipped unless NAV_TEST_DSN names a throwaway database -- CI has none, and this
test DROPS THE PUBLIC SCHEMA of whatever it is pointed at. Locally:

  docker run -d --rm --name navtest-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=nav \\
      -p 55432:5432 postgres:17
  NAV_TEST_DSN='host=localhost port=55432 dbname=nav user=postgres password=t' \\
      <venv with requirements.txt>/bin/python -m unittest test_layouts_db -v

Why a database test at all: the migration rewrites admin_overrides in place,
and SQL that has only been read is the kind that is wrong on first contact.
"""
import os
import pathlib
import unittest

DSN = os.environ.get("NAV_TEST_DSN")
if not DSN:
    raise unittest.SkipTest("NAV_TEST_DSN not set (needs a throwaway Postgres)")

os.environ["NAV_DSN"] = DSN
os.environ["NAV_ADMINS"] = "admin@x"

import psycopg  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as nav  # noqa: E402

SCHEMA = pathlib.Path(__file__).with_name("schema.sql").read_text()
# Everything before the layouts section IS the pre-template schema.
OLD_SCHEMA = SCHEMA[:SCHEMA.index("-- LAYOUTS (roadmap #34")]

APPS = ["plex", "seer", "books"]


def fake_apps(slugs):
    async def authentik_apps(who):
        return [{"slug": s, "name": s.title(), "launch_url": f"https://{s}.example",
                 "group": "Media", "meta_description": ""} for s in slugs]
    return authentik_apps


async def reach(who):
    return {"grafana", *APPS}


def as_(who):
    return {"x-authentik-email": who}


ADMIN, U, OTHER = as_("admin@x"), as_("u@x"), as_("o@x")


class Layouts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(DSN, autocommit=True) as c:
            c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            c.execute(OLD_SCHEMA)
            c.execute("""INSERT INTO admin_overrides (slug, fields) VALUES
                ('plex', '{"name": "Plex TV", "category": "Media", "order": 2, "size": "XS"}'),
                ('seer', '{"hidden": true}')""")
            c.execute("""INSERT INTO site_settings (key, value) VALUES
                ('group_order', '["Media", "Tools"]'), ('group_hidden', '["Tools"]'),
                ('title', '"nav"')""")
            c.execute("""INSERT INTO widget_defs (type, title, config) VALUES
                ('nav.version', 'Version', '{}')""")
            c.execute("INSERT INTO widget_placements (def_id, category, ord) VALUES (1, 'Media', 0)")
        nav.authentik_apps = fake_apps(APPS)
        nav.reachable_slugs = reach
        cls.ctx = TestClient(nav.app)
        cls.c = cls.ctx.__enter__()          # runs the lifespan: schema + migration

    @classmethod
    def tearDownClass(cls):
        cls.ctx.__exit__(None, None, None)

    def sql(self, q, *a):
        with psycopg.connect(DSN) as c:
            return c.execute(q, a).fetchall()

    def apps(self, who, **params):
        r = self.c.get("/api/apps", headers=who, params=params)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def by_slug(self, reply):
        return {a["slug"]: a for a in reply["apps"]}

    # --- the migration --------------------------------------------------------

    def test_01_migration_moves_layout_to_default(self):
        self.assertEqual(self.sql("SELECT fields FROM admin_overrides WHERE slug = 'plex'"),
                         [({"name": "Plex TV"},)])
        tpl = self.sql("SELECT id, name, is_default, group_order, group_hidden FROM layouts")
        self.assertEqual(len(tpl), 1)
        self.assertEqual(tpl[0][1:], ("Default", True, ["Media", "Tools"], ["Tools"]))
        tiles = dict(self.sql("SELECT slug, fields FROM layout_tiles"))
        self.assertEqual(tiles["plex"], {"category": "Media", "order": 2, "size": "XS"})
        self.assertEqual(tiles["seer"], {"hidden": True})
        self.assertEqual(self.sql("SELECT count(*) FROM admin_overrides_pre_layouts"), [(2,)])
        self.assertEqual(self.sql("SELECT key FROM site_settings"), [("title",)])
        self.assertEqual(self.sql("SELECT layout_id FROM widget_placements"), [(tpl[0][0],)])

    def test_99_restart_is_idempotent(self):
        # Last: a second lifespan replaces and then closes the module-level pool.
        with TestClient(nav.app):
            pass
        self.assertEqual(self.sql("SELECT count(*) FROM layouts WHERE kind = 'template'"), [(1,)])

    # --- reading ----------------------------------------------------------------

    def test_03_default_template_renders_and_admin_flag_is_a_bool(self):
        r = self.apps(U)
        self.assertIs(r["admin"], False, "was the admin_overrides rows: truthy for everyone")
        self.assertEqual(r["layout"]["name"], "Default")
        a = self.by_slug(r)
        self.assertEqual((a["plex"]["name"], a["plex"]["size"]), ("Plex TV", "XS"))
        self.assertNotIn("seer", a, "hidden in the template")
        self.assertIs(self.apps(ADMIN)["admin"], True)

    def test_04_admin_editor_sees_hidden_with_both_halves(self):
        a = self.by_slug(self.apps(ADMIN, include_hidden="true"))
        self.assertTrue(a["seer"]["hidden"])
        self.assertEqual(a["plex"]["override"], {"name": "Plex TV", "category": "Media",
                                                 "order": 2, "size": "XS"})
        # A non-admin asking gets no hidden tiles from a template.
        self.assertNotIn("seer", self.by_slug(self.apps(U, include_hidden="true")))

    # --- pre-template routes still work, split ------------------------------------

    def test_05_old_override_route_splits(self):
        r = self.c.put("/api/admin/overrides/books", headers=ADMIN,
                       json={"fields": {"name": "Books", "size": "S", "order": 0}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sql("SELECT fields FROM admin_overrides WHERE slug = 'books'"),
                         [({"name": "Books"},)])
        self.assertEqual(self.sql("SELECT fields FROM layout_tiles WHERE slug = 'books'"),
                         [({"size": "S", "order": 0},)])
        self.assertEqual(self.c.put("/api/admin/overrides/books", headers=U,
                                    json={"fields": {}}).status_code, 403)

    def test_06_old_site_keys_live_on_the_template(self):
        self.assertEqual(self.c.get("/api/site", headers=U).json()["group_order"], ["Media", "Tools"])
        self.c.put("/api/site/group_order", headers=ADMIN, json={"value": ["Tools", "Media"]})
        self.assertEqual(self.sql("SELECT group_order FROM layouts WHERE is_default"),
                         [(["Tools", "Media"],)])
        self.assertEqual(self.sql("SELECT count(*) FROM site_settings WHERE key = 'group_order'"), [(0,)])

    def test_07_old_layout_route_orders_the_template(self):
        pid = self.sql("SELECT id FROM widget_placements")[0][0]
        r = self.c.put("/api/admin/layout", headers=ADMIN, json={
            "category": "Media", "items": [{"app": "books"}, {"widget": pid}, {"app": "plex"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sql("SELECT ord FROM widget_placements"), [(1,)])
        self.assertEqual(self.sql("SELECT fields->>'order' FROM layout_tiles WHERE slug = 'plex'"),
                         [("2",)])

    # --- dashboards ---------------------------------------------------------------

    def test_10_dashboard_is_a_full_copy(self):
        r = self.c.post("/api/layouts", headers=U, json={"kind": "dashboard", "name": "Mine"})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["id"]
        self.assertEqual(self.c.post("/api/layouts", headers=U,
                                     json={"kind": "dashboard", "name": "mine"}).status_code, 409)
        # Users may rename and re-icon in their own dashboard.
        r = self.c.put(f"/api/layouts/{d}/tiles", headers=U,
                       json={"tiles": {"plex": {"name": "Films", "category": "Fun", "size": "M"}}})
        self.assertEqual(r.status_code, 200, r.text)
        mine = self.by_slug(self.apps(U, layout=d))
        self.assertEqual((mine["plex"]["name"], mine["plex"]["category"]), ("Films", "Fun"))
        # A template edit afterwards does NOT reach the copy...
        self.c.put("/api/admin/overrides/books", headers=ADMIN,
                   json={"fields": {"name": "Books", "size": "L"}})
        self.assertEqual(self.by_slug(self.apps(U, layout=d))["books"]["size"], "S")
        # ...but a template row for an app the copy has NO row for does.
        self.c.put(f"/api/layouts/{self.default()}/tiles", headers=ADMIN,
                   json={"tiles": {"newapp": {"category": "New"}}})
        nav.authentik_apps = fake_apps(APPS + ["newapp"])
        try:
            self.assertEqual(self.by_slug(self.apps(U, layout=d))["newapp"]["category"], "New")
        finally:
            nav.authentik_apps = fake_apps(APPS)
        # Hidden tiles come back for the owner in edit mode.
        self.assertIn("seer", self.by_slug(self.apps(U, layout=d, include_hidden="true")))
        self.assertNotIn("seer", self.by_slug(self.apps(U, layout=d)))
        # The copy's widgets.
        w = self.c.get("/api/widgets", headers=U, params={"layout": d}).json()
        self.assertEqual(len(w["placements"]), 1)
        self.assertEqual(w["layout_id"], d)
        type(self).dash = d

    def test_11_dashboards_are_private(self):
        d = self.dash
        self.assertEqual(self.c.get("/api/apps", headers=OTHER, params={"layout": d}).status_code, 404)
        self.assertEqual(self.c.put(f"/api/layouts/{d}/tiles", headers=OTHER,
                                    json={"tiles": {}}).status_code, 404)
        self.assertEqual(self.c.get("/api/widgets", headers=OTHER, params={"layout": d}).status_code, 404)
        self.assertEqual(self.c.put("/api/device/phone", headers=OTHER,
                                    json={"layout_id": d}).status_code, 404)
        self.assertEqual(self.c.get("/api/layouts", headers=OTHER).json()["dashboards"], [])
        self.assertEqual(len(self.c.get("/api/layouts", headers=U).json()["dashboards"]), 1)

    def test_12_device_selection(self):
        r = self.c.put("/api/device/phone", headers=U, json={"layout_id": self.dash})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.c.get("/api/device/phone", headers=U).json()["layout_id"], self.dash)

    def test_13_dashboard_placements(self):
        d = self.dash
        r = self.c.post(f"/api/layouts/{d}/placements", headers=U, json={"def_id": 1, "category": "Fun"})
        self.assertEqual(r.status_code, 200, r.text)
        pid = r.json()["id"]
        self.assertEqual(self.c.put(f"/api/layouts/{d}/placements/{pid}", headers=U,
                                    json={"size": "S"}).status_code, 200)
        # Not through someone else's layout id.
        self.assertEqual(self.c.put(f"/api/layouts/{self.default()}/placements/{pid}", headers=ADMIN,
                                    json={"size": "L"}).status_code, 404)
        r = self.c.put(f"/api/layouts/{d}/order", headers=U,
                       json={"category": "Fun", "items": [{"widget": pid}, {"app": "plex"}]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_14_revert_recopies(self):
        d = self.dash
        self.assertEqual(self.c.post(f"/api/layouts/{d}/revert", headers=U).status_code, 200)
        a = self.by_slug(self.apps(U, layout=d))
        self.assertEqual(a["plex"]["name"], "Plex TV")
        self.assertEqual(a["books"]["size"], "L", "now the template's current value")
        self.assertEqual(len(self.c.get("/api/widgets", headers=U, params={"layout": d})
                             .json()["placements"]), 1)

    # --- templates ----------------------------------------------------------------

    def test_20_templates_are_admin_only_and_layout_only(self):
        t = self.default()
        self.assertEqual(self.c.put(f"/api/layouts/{t}/tiles", headers=U,
                                    json={"tiles": {"plex": {"size": "S"}}}).status_code, 403)
        r = self.c.put(f"/api/layouts/{t}/tiles", headers=ADMIN,
                       json={"tiles": {"plex": {"name": "X"}}})
        self.assertEqual(r.status_code, 422)
        self.assertIn("site-wide", r.text)
        self.assertEqual(self.c.post("/api/layouts", headers=U,
                                     json={"kind": "template", "name": "Kids"}).status_code, 403)

    def test_21_default_moves_never_clears(self):
        old = self.default()
        self.assertEqual(self.c.delete(f"/api/layouts/{old}", headers=ADMIN).status_code, 409)
        r = self.c.post("/api/layouts", headers=ADMIN,
                        json={"kind": "template", "name": "Family", "from_id": old})
        self.assertEqual(r.status_code, 200, r.text)
        fam = r.json()["id"]
        self.assertEqual(self.c.put(f"/api/layouts/{fam}", headers=ADMIN,
                                    json={"is_default": True}).status_code, 200)
        self.assertEqual(self.default(), fam)
        self.assertEqual(self.apps(U)["layout"]["name"], "Family")
        # The old one can go now; a dashboard made from it reverts to the default.
        self.assertEqual(self.c.delete(f"/api/layouts/{old}", headers=ADMIN).status_code, 200)
        r = self.c.post(f"/api/layouts/{self.dash}/revert", headers=U)
        self.assertEqual(r.json()["template_id"], fam)

    def test_22_personal_widgets_stay_personal(self):
        did = self.sql("INSERT INTO widget_defs (type, title, config, owner) "
                       "VALUES ('nav.version', 'Mine', '{}', 'u@x') RETURNING id")[0][0]
        self.assertIn(did, [x["id"] for x in self.c.get("/api/widgets", headers=U).json()["defs"]])
        self.assertNotIn(did, [x["id"] for x in self.c.get("/api/widgets", headers=OTHER).json()["defs"]])
        self.assertEqual(self.c.get(f"/api/widgets/{did}/data", headers=OTHER).status_code, 404)
        self.assertEqual(self.c.get(f"/api/widgets/{did}/data", headers=U).status_code, 200)
        r = self.c.post(f"/api/layouts/{self.default()}/placements", headers=ADMIN,
                        json={"def_id": did, "category": "Media"})
        self.assertEqual(r.status_code, 404, "not even the admin can place someone's own widget")

    def test_24_personal_widget_routes(self):
        body = {"type": "nav.version", "title": "My version", "config": {}}
        r = self.c.post("/api/widgets", headers=U, json=body)
        self.assertEqual(r.status_code, 200, r.text)
        did = r.json()["id"]
        self.assertEqual(self.sql("SELECT owner FROM widget_defs WHERE id = %s", did), [("u@x",)])
        # Someone else's: 404 to edit or delete, as to read; the admin route
        # is the library's only.
        self.assertEqual(self.c.put(f"/api/widgets/{did}", headers=OTHER, json=body).status_code, 404)
        self.assertEqual(self.c.delete(f"/api/widgets/{did}", headers=OTHER).status_code, 404)
        self.assertEqual(self.c.put(f"/api/admin/widgets/{did}", headers=ADMIN, json=body).status_code, 404)
        self.assertEqual(self.c.put("/api/widgets/1", headers=U, json=body).status_code, 404,
                         "a library widget is not yours to edit")
        r = self.c.put(f"/api/widgets/{did}", headers=U, json={**body, "title": "Renamed"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sql("SELECT title FROM widget_defs WHERE id = %s", did), [("Renamed",)])
        self.assertEqual(self.c.post("/api/widgets", headers=U,
                                     json={**body, "type": "nope"}).status_code, 404)
        self.assertEqual(self.c.delete(f"/api/widgets/{did}", headers=U).status_code, 200)
        self.assertEqual(self.sql("SELECT count(*) FROM widget_defs WHERE id = %s", did), [(0,)])

    def test_25_edit_a_placed_widget(self):
        dash = self.c.post("/api/layouts", headers=U,
                           json={"kind": "dashboard", "name": "Custom", "from_id": self.default()}).json()["id"]
        pid, = self.sql("SELECT id FROM widget_placements WHERE layout_id = %s AND def_id = 1", dash)[0]
        before = self.sql("SELECT category, ord, size FROM widget_placements WHERE id = %s", pid)
        url = f"/api/layouts/{dash}/placements/{pid}/widget"
        # A library widget: copied, for this placement only.
        r = self.c.put(url, headers=U, json={"title": "Mine now", "config": {}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["copied"])
        did = r.json()["def_id"]
        self.assertEqual(self.sql("SELECT owner, type FROM widget_defs WHERE id = %s", did),
                         [("u@x", "nav.version")])
        self.assertEqual(self.sql("SELECT category, ord, size FROM widget_placements WHERE id = %s", pid), before)
        self.assertTrue(self.sql("SELECT 1 FROM widget_placements WHERE layout_id = %s AND def_id = 1",
                                 self.default()), "the template keeps the original")
        # Yours, placed only here: edited in place.
        r = self.c.put(url, headers=U, json={"title": "Renamed", "config": {}})
        self.assertEqual((r.json()["copied"], r.json()["def_id"]), (False, did))
        self.assertEqual(self.sql("SELECT title FROM widget_defs WHERE id = %s", did), [("Renamed",)])
        # Yours, placed twice: the edit forks, the other placement keeps it.
        self.c.post(f"/api/layouts/{dash}/placements", headers=U, json={"def_id": did, "category": "Media"})
        r = self.c.put(url, headers=U, json={"title": "Fork", "config": {}})
        self.assertTrue(r.json()["copied"])
        self.assertEqual(self.sql("SELECT title FROM widget_defs WHERE id = %s", did), [("Renamed",)])
        # Not someone else's dashboard, not a template.
        self.assertEqual(self.c.put(url, headers=OTHER, json={"title": "x", "config": {}}).status_code, 404)
        tpid, = self.sql("SELECT id FROM widget_placements WHERE layout_id = %s LIMIT 1", self.default())[0]
        self.assertEqual(self.c.put(f"/api/layouts/{self.default()}/placements/{tpid}/widget",
                                    headers=ADMIN, json={"title": "x", "config": {}}).status_code, 422)

    def test_26_widget_hidden_and_above_fold(self):
        d = self.dash
        pid = self.c.get("/api/widgets", headers=U, params={"layout": d}).json()["placements"][0]["id"]
        r = self.c.put(f"/api/layouts/{d}/placements/{pid}", headers=U, json={"hidden": True, "above_fold": True})
        self.assertEqual(r.status_code, 200, r.text)
        p = self.c.get("/api/widgets", headers=U, params={"layout": d}).json()["placements"][0]
        self.assertEqual((p["hidden"], p["above_fold"]), (True, True))
        self.assertEqual(self.c.put(f"/api/layouts/{d}/placements/{pid}", headers=U,
                                    json={"hidden": "yes"}).status_code, 422)

    def test_30_a_free_dashboard_starts_empty_and_places_by_cell(self):
        F = as_("f@x")
        r = self.c.post("/api/layouts", headers=F, json={"kind": "dashboard", "name": "Free", "mode": "free"})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()["id"]
        reply = self.apps(F, layout=d)
        self.assertEqual(reply["layout"]["mode"], "free")
        # Every app is still listed (the palette needs them) but none is placed.
        self.assertTrue(reply["apps"])
        self.assertTrue(all(a.get("x") is None for a in reply["apps"]), "nothing copied in")
        self.assertEqual(self.c.get("/api/widgets", headers=F, params={"layout": d}).json()["placements"], [])
        # Place a tile and a widget at cells.
        r = self.c.put(f"/api/layouts/{d}/tiles", headers=F, json={"tiles": {"plex": {"x": 4, "y": 2, "size": "M"}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self.by_slug(self.apps(F, layout=d))["plex"]["x"], 
                          self.by_slug(self.apps(F, layout=d))["plex"]["y"]), (4, 2))
        r = self.c.post(f"/api/layouts/{d}/placements", headers=F,
                        json={"def_id": 1, "category": "Page", "x": 0, "y": 0})
        self.assertEqual(r.status_code, 200, r.text)
        pid = r.json()["id"]
        self.assertEqual(self.c.put(f"/api/layouts/{d}/placements/{pid}", headers=F,
                                    json={"x": 8, "y": 6}).status_code, 200)
        p = self.c.get("/api/widgets", headers=F, params={"layout": d}).json()["placements"][0]
        self.assertEqual((p["x"], p["y"]), (8, 6))
        # Out of range, and the things a free dashboard can't be.
        self.assertEqual(self.c.put(f"/api/layouts/{d}/placements/{pid}", headers=F,
                                    json={"x": 24}).status_code, 422)
        self.assertEqual(self.c.put(f"/api/layouts/{d}/tiles", headers=F,
                                    json={"tiles": {"plex": {"x": -1}}}).status_code, 422)
        # A tile on a free dashboard may be any span; a nonsense size is still refused.
        self.assertEqual(self.c.put(f"/api/layouts/{d}/tiles", headers=F,
                                    json={"tiles": {"plex": {"x": 4, "y": 2, "size": "5x1"}}}).status_code, 200)
        self.assertEqual(self.c.put(f"/api/layouts/{d}/tiles", headers=F,
                                    json={"tiles": {"plex": {"size": "huge"}}}).status_code, 422)
        self.assertEqual(self.c.post(f"/api/layouts/{d}/revert", headers=F).status_code, 422)
        self.assertEqual(self.c.post("/api/layouts", headers=ADMIN,
                                     json={"kind": "template", "name": "T", "mode": "free"}).status_code, 422)
        self.assertEqual(self.c.post("/api/layouts", headers=F, json={"kind": "dashboard", "name": "F2",
                                     "mode": "free", "from_id": d}).status_code, 422)
        listed = self.c.get("/api/layouts", headers=F).json()["dashboards"]
        self.assertEqual([(x["name"], x["mode"]) for x in listed], [("Free", "free")])

    def test_23_presentation_route_is_presentation_only(self):
        r = self.c.put("/api/admin/presentation", headers=ADMIN,
                       json={"tiles": {"plex": {"name": "Plex!", "icon": "p.svg"}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.sql("SELECT fields FROM admin_overrides WHERE slug = 'plex'"),
                         [({"name": "Plex!", "icon": "p.svg"},)])
        before = self.sql("SELECT fields FROM layout_tiles WHERE slug = 'plex' AND layout_id = %s",
                          self.default())
        self.assertTrue(before, "the template's layout row survives a presentation edit")
        self.assertEqual(self.c.put("/api/admin/presentation", headers=ADMIN,
                                    json={"tiles": {"plex": {"size": "S"}}}).status_code, 422)
        self.assertEqual(self.c.put("/api/admin/presentation", headers=U,
                                    json={"tiles": {}}).status_code, 403)
        self.assertEqual(self.c.delete("/api/admin/presentation/plex", headers=ADMIN).status_code, 200)
        self.assertEqual(self.sql("SELECT count(*) FROM admin_overrides WHERE slug = 'plex'"), [(0,)])

    def default(self):
        return self.sql("SELECT id FROM layouts WHERE is_default")[0][0]


if __name__ == "__main__":
    unittest.main()
