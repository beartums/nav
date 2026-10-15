import os
import re
import time
import unittest

import health

ING = {"items": [
    {"metadata": {"namespace": "media", "name": "sonarr"},
     "spec": {"ingressClassName": "pomerium", "rules": [{"host": "Sonarr.example.com", "http": {"paths": [
         {"path": "/", "backend": {"service": {"name": "sonarr", "port": {"number": 8989}}}}]}}]}},
    {"metadata": {"namespace": "grif-apps", "name": "nas"},
     "spec": {"ingressClassName": "pomerium", "rules": [{"host": "nas.example.com", "http": {"paths": [
         {"path": "/", "backend": {"service": {"name": "nas", "port": {"name": "web"}}}}]}}]}},
    {"metadata": {"namespace": "x", "name": "tls", "annotations": {"ingress.pomerium.io/secure_upstream": "true"}},
     "spec": {"ingressClassName": "pomerium", "rules": [{"host": "pve.example.com", "http": {"paths": [
         {"path": "/", "backend": {"service": {"name": "pve", "port": {"number": 8006}}}}]}}]}},
    {"metadata": {"namespace": "old", "name": "nginx"},
     "spec": {"ingressClassName": "nginx", "rules": [{"host": "old.example.com", "http": {"paths": [
         {"path": "/", "backend": {"service": {"name": "old", "port": {"number": 80}}}}]}}]}},
]}
ING["items"].append(
    {"metadata": {"namespace": "mealie", "name": "mealie"},
     "spec": {"ingressClassName": "pomerium", "rules": [{"host": "mealie.example.com", "http": {"paths": [
         {"path": "/sw.js", "pathType": "Exact", "backend": {"service": {"name": "killswitch", "port": {"number": 80}}}},
         {"path": "/", "backend": {"service": {"name": "mealie", "port": {"number": 9000}}}}]}}]}})
SVC = {"items": [{"metadata": {"namespace": "grif-apps", "name": "nas"},
                  "spec": {"ports": [{"name": "web", "port": 80}]}}]}


class Routes(unittest.TestCase):
    def test_backends_from_pomerium_ingresses(self):
        r = health.routes_from(ING, SVC)
        self.assertEqual(r["sonarr.example.com"]["url"], "http://sonarr.media.svc.cluster.local:8989/")
        self.assertEqual(r["nas.example.com"]["url"], "http://nas.grif-apps.svc.cluster.local:80/",
                         "a named port resolves through its Service")
        self.assertTrue(r["pve.example.com"]["url"].startswith("https://"))
        self.assertNotIn("old.example.com", r, "not a Pomerium route")
        self.assertEqual(r["mealie.example.com"]["url"], "http://mealie.mealie.svc.cluster.local:9000/",
                         "the / route, not an Exact path listed before it")

    def test_any_reply_is_up_but_a_5xx_is_not(self):
        self.assertEqual(health.verdict(401, None)[0], "up")
        self.assertEqual(health.verdict(404, None)[0], "up")
        self.assertEqual(health.verdict(302, None)[0], "up")
        self.assertEqual(health.verdict(503, None)[0], "down")
        self.assertEqual(health.verdict(None, "refused"), ("down", "refused"))

    def test_lookup_unknown_and_stale(self):
        health.STATE.clear()
        now = int(time.time())
        health.STATE["a.x"] = {"state": "up", "detail": "HTTP 200", "at": now}
        health.STATE["b.x"] = {"state": "up", "detail": "HTTP 200", "at": now - 10 * health.EVERY}
        got = health.lookup(["A.x", "b.x", "c.x"])
        self.assertEqual(got["a.x"]["state"], "up")
        self.assertEqual(got["b.x"]["state"], "unknown", "an old up is not a current one")
        self.assertEqual(got["c.x"]["state"], "unknown")


class Image(unittest.TestCase):
    def test_the_image_copies_every_module_and_the_page(self):
        # A module the image leaves out imports fine here and crashes the pod;
        # so it copies them all by glob, and the page with them.
        here = os.path.dirname(__file__)
        with open(os.path.join(here, "..", "Dockerfile")) as fh:
            text = fh.read()
        self.assertIn("COPY api/*.py api/schema.sql ./", text)
        self.assertIn("COPY ui/ ./ui/", text)


if __name__ == "__main__":
    unittest.main()
