"""authentik_apps: fresh answers reused, stale ones served while one is fetched."""
import asyncio
import os
import unittest

# The same values test_layouts_db would set, should it import app after this.
if os.environ.get("NAV_TEST_DSN"):
    os.environ.setdefault("NAV_DSN", os.environ["NAV_TEST_DSN"])
    os.environ.setdefault("NAV_ADMINS", "admin@x")
os.environ.setdefault("NAV_DSN", "postgresql://unused/none")
try:
    import app as nav  # noqa: E402
except ImportError as e:  # CI's unit job is stdlib-only (no fastapi/httpx)
    raise unittest.SkipTest(f"app needs requirements.txt: {e}")


class AppsCache(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        nav._APPS_SEEN.clear()
        nav._APPS_FETCH.clear()
        self.calls = 0
        self.live = nav.authentik_apps_live
        self.gate = None

        async def fake(who):
            self.calls += 1
            if self.gate:
                await self.gate.wait()
            return [{"slug": f"s{self.calls}"}]
        nav.authentik_apps_live = fake

    def tearDown(self):
        nav.authentik_apps_live = self.live

    async def test_concurrent_misses_share_one_call(self):
        self.gate = asyncio.Event()
        both = asyncio.gather(nav.authentik_apps("a@x"), nav.reachable_slugs("a@x"))
        await asyncio.sleep(0)
        self.gate.set()
        apps, slugs = await both
        self.assertEqual(self.calls, 1)
        self.assertEqual(slugs, {"s1"})

    async def test_fresh_is_reused(self):
        await nav.authentik_apps("a@x")
        await nav.authentik_apps("a@x")
        self.assertEqual(self.calls, 1)

    async def test_stale_served_at_once_then_refreshed(self):
        await nav.authentik_apps("a@x")
        at, got = nav._APPS_SEEN["a@x"]
        nav._APPS_SEEN["a@x"] = (at - nav.APPS_FRESH - 1, got)
        self.gate = asyncio.Event()
        self.assertEqual(await nav.authentik_apps("a@x"), [{"slug": "s1"}])   # no wait
        self.gate.set()
        await asyncio.sleep(0.01)
        self.assertEqual(await nav.authentik_apps("a@x"), [{"slug": "s2"}])

    async def test_too_old_waits_for_fresh(self):
        await nav.authentik_apps("a@x")
        at, got = nav._APPS_SEEN["a@x"]
        nav._APPS_SEEN["a@x"] = (at - nav.APPS_STALE - 1, got)
        self.assertEqual(await nav.authentik_apps("a@x"), [{"slug": "s2"}])

    async def test_forget_access(self):
        await nav.authentik_apps("a@x")
        nav.forget_access()
        await nav.authentik_apps("a@x")
        self.assertEqual(self.calls, 2)

    async def test_error_propagates_and_is_not_cached(self):
        async def boom(who):
            raise nav.HTTPException(409, "two accounts")
        nav.authentik_apps_live = boom
        with self.assertRaises(nav.HTTPException):
            await nav.authentik_apps("b@x")
        self.assertNotIn("b@x", nav._APPS_SEEN)


if __name__ == "__main__":
    unittest.main()
