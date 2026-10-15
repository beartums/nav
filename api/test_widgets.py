"""widgets.py: registration, config validation, access, cache, error isolation.

Standard library only, like the module -- CI runs this without pip install.
"""
import asyncio
import unittest

import widgets
from widgets import Cache, ConfigError, Provider, check_shape, run, validate_config, visible


def provider(**attrs):
    """A fresh, unregistered Provider subclass."""
    base = {"type": "t.demo", "app": "sonarr", "shape": "stat", "ttl": 60,
            "config_schema": {}}
    base.update(attrs)
    return type("P", (Provider,), base)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class Register(unittest.TestCase):
    def setUp(self):
        self.saved = dict(widgets.REGISTRY)

    def tearDown(self):
        widgets.REGISTRY.clear()
        widgets.REGISTRY.update(self.saved)

    def test_good_provider_registers(self):
        widgets.register(provider(type="t.ok"))
        self.assertIn("t.ok", widgets.REGISTRY)

    def test_missing_app_is_refused(self):
        # The permission model must never be a forgotten default.
        with self.assertRaisesRegex(ValueError, "app"):
            widgets.register(provider(type="t.noapp", app=""))

    def test_bad_shape_duplicate_and_schema_are_refused(self):
        with self.assertRaises(ValueError):
            widgets.register(provider(type="t.shape", shape="pie"))
        widgets.register(provider(type="t.dup"))
        with self.assertRaises(ValueError):
            widgets.register(provider(type="t.dup"))
        with self.assertRaises(ValueError):
            widgets.register(provider(type="t.enum", config_schema={"x": {"type": "enum"}}))


class Config(unittest.TestCase):
    P = provider(config_schema={
        "query": {"type": "string", "required": True},
        "range": {"type": "enum", "choices": ["1h", "24h"], "default": "1h"},
        "warn": {"type": "number"},
        "count": {"type": "integer", "default": 5},
        "flag": {"type": "bool", "default": False},
    })

    def test_defaults_fill_in(self):
        self.assertEqual(validate_config(self.P, {"query": "up"}),
                         {"query": "up", "range": "1h", "count": 5, "flag": False})

    def test_unknown_field_is_refused_not_ignored(self):
        with self.assertRaisesRegex(ConfigError, "qeury"):
            validate_config(self.P, {"query": "up", "qeury": "x"})

    def test_required_and_types(self):
        with self.assertRaises(ConfigError):
            validate_config(self.P, {})
        with self.assertRaises(ConfigError):
            validate_config(self.P, {"query": "up", "range": "7d"})
        with self.assertRaises(ConfigError):
            validate_config(self.P, {"query": "up", "warn": "high"})
        # bool is an int in Python; it must not pass as a number.
        with self.assertRaises(ConfigError):
            validate_config(self.P, {"query": "up", "count": True})
        self.assertEqual(validate_config(self.P, {"query": "up", "warn": 80})["warn"], 80)


class Access(unittest.TestCase):
    def test_app_gates_visibility(self):
        self.assertTrue(visible(provider(app="sonarr"), {"sonarr", "books"}))
        self.assertFalse(visible(provider(app="sonarr"), {"books"}))
        self.assertTrue(visible(provider(app=widgets.EVERYONE), set()))


class Shape(unittest.TestCase):
    def test_contract(self):
        self.assertIsNone(check_shape("stat", {"value": 3}))
        self.assertIsNotNone(check_shape("stat", {"v": 3}))
        self.assertIsNotNone(check_shape("timeseries", {"series": "no"}))
        self.assertIsNotNone(check_shape("status", {"state": "fine"}))
        self.assertIsNotNone(check_shape("list", []))


class Run(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.cache = Cache(clock=self.clock)
        self.calls = 0

    def counting(self, result=None, exc=None, delay=0, **attrs):
        test = self

        async def fetch(self, config, who):
            test.calls += 1
            if delay:
                await asyncio.sleep(delay)
            if exc:
                raise exc
            return result if result is not None else {"value": test.calls, "who": who}
        return provider(fetch=fetch, **attrs)

    async def test_cached_within_ttl_then_refetched(self):
        P = self.counting(ttl=60)
        a = await run(P, {}, "evan", self.cache)
        b = await run(P, {}, "evan", self.cache)
        self.assertEqual((a["data"]["value"], b["data"]["value"], self.calls), (1, 1, 1))
        self.clock.t += 61
        c = await run(P, {}, "evan", self.cache)
        self.assertEqual((c["data"]["value"], self.calls), (2, 2))

    async def test_concurrent_misses_share_one_upstream_call(self):
        P = self.counting(delay=0.01)
        out = await asyncio.gather(*(run(P, {}, "evan", self.cache) for _ in range(5)))
        self.assertEqual(self.calls, 1)
        self.assertTrue(all(o["data"]["value"] == 1 for o in out))

    async def test_shared_provider_is_shared_across_users(self):
        P = self.counting()
        await run(P, {}, "evan", self.cache)
        await run(P, {}, "mom", self.cache)
        self.assertEqual(self.calls, 1)

    async def test_per_user_provider_never_serves_one_user_to_another(self):
        P = self.counting(per_user=True)
        a = await run(P, {}, "evan", self.cache)
        b = await run(P, {}, "mom", self.cache)
        self.assertEqual((a["data"]["who"], b["data"]["who"], self.calls), ("evan", "mom", 2))

    async def test_acting_as_someone_is_its_own_entry_and_reaches_the_provider(self):
        test = self

        async def fetch(self, config, who, as_=None):
            test.calls += 1
            return {"value": test.calls, "who": who, "as": as_}
        P = provider(fetch=fetch, per_user=True, acts_as=True)
        plain = await run(P, {}, "evan", self.cache)
        toby = await run(P, {}, "evan", self.cache, as_=2)
        again = await run(P, {}, "evan", self.cache)
        self.assertEqual((plain["data"]["as"], toby["data"]["as"], again["data"]["as"], self.calls),
                         (None, 2, None, 2))

    async def test_config_is_part_of_the_key(self):
        P = self.counting(config_schema={"q": {"type": "string"}})
        await run(P, {"q": "a"}, "evan", self.cache)
        await run(P, {"q": "b"}, "evan", self.cache)
        self.assertEqual(self.calls, 2)

    async def test_failure_is_an_error_payload_cached_briefly(self):
        P = self.counting(exc=RuntimeError("upstream down"), ttl=300)
        a = await run(P, {}, "evan", self.cache)
        self.assertIn("upstream down", a["error"])
        self.assertNotIn("data", a)
        await run(P, {}, "evan", self.cache)
        self.assertEqual(self.calls, 1)
        self.clock.t += widgets.ERROR_TTL + 1   # well inside the 300 s ttl
        await run(P, {}, "evan", self.cache)
        self.assertEqual(self.calls, 2)

    async def test_wrong_shape_is_an_error_not_a_crash(self):
        P = self.counting(result={"nope": 1})
        a = await run(P, {}, "evan", self.cache)
        self.assertIn("contract", a["error"])

    async def test_cache_is_capped(self):
        P = self.counting(config_schema={"q": {"type": "integer"}})
        small = Cache(clock=self.clock, cap=3)
        for i in range(5):
            self.clock.t += 1
            await run(P, {"q": i}, "evan", small)
        self.assertEqual(len(small.entries), 3)


class Sizes(unittest.TestCase):
    def test_named_and_custom(self):
        self.assertTrue(widgets.size_ok("clock", "L"))
        self.assertTrue(widgets.size_ok("clock", "16x5"))
        self.assertTrue(widgets.size_ok("clock", None))
        self.assertFalse(widgets.size_ok("clock", "W"), "W is weather's")
        self.assertFalse(widgets.size_ok("clock", "49x2"))
        self.assertFalse(widgets.size_ok("clock", "0x2"))
        self.assertFalse(widgets.size_ok("clock", "4x4; drop"))



class ManyApps(unittest.TestCase):
    """A provider over several apps, and a library widget's audience."""
    P = provider(type="t.many", app=("sonarr", "radarr"), config_schema={
        "tv": {"type": "bool", "default": True}, "movies": {"type": "bool", "default": True}})

    def setUp(self):
        def needs(cls, config):
            return {s for k, s in (("tv", "sonarr"), ("movies", "radarr")) if config.get(k, True)}
        self.P.needs = classmethod(needs)

    def test_one_app_offers_the_type_but_a_config_needs_all_it_reads(self):
        self.assertTrue(visible(self.P, {"sonarr"}))
        self.assertFalse(widgets.allowed(self.P, {"tv": True, "movies": True}, {"sonarr"}))
        self.assertTrue(widgets.allowed(self.P, {"tv": True, "movies": False}, {"sonarr"}))
        self.assertFalse(widgets.allowed(self.P, {"tv": False, "movies": False}, {"sonarr", "radarr"}),
                         "a config that reads nothing is not a free pass")

    def test_audience(self):
        self.assertEqual(widgets.clean_audience(" Family, family,staff "), ["family", "staff"])
        self.assertEqual(widgets.clean_audience(None), [])
        with self.assertRaises(ConfigError):
            widgets.clean_audience([1])
        self.assertTrue(widgets.in_audience(["family"], {"family", "x"}))
        self.assertTrue(widgets.in_audience(["*"], set()))
        self.assertFalse(widgets.in_audience([], {"family"}))
        self.assertFalse(widgets.in_audience(None, {"family"}))

    def test_a_bad_preset_is_refused_at_registration(self):
        saved = dict(widgets.REGISTRY)
        try:
            with self.assertRaisesRegex(ValueError, "preset"):
                widgets.register(provider(type="t.pre", presets=[{"title": "x", "config": {"nope": 1}}]))
            with self.assertRaises(ValueError):
                widgets.register(provider(type="t.tup", app=("*",)))
        finally:
            widgets.REGISTRY.clear()
            widgets.REGISTRY.update(saved)

    def test_calendar_contract(self):
        self.assertIsNone(check_shape("calendar", {"events": []}))
        self.assertIsNotNone(check_shape("calendar", {}))

if __name__ == "__main__":
    unittest.main()
