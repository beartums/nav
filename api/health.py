"""Is each tile's app up? Probed here, every minute, never by the page.

WHY NOT PROBE THE TILE'S URL: from in the cluster it reaches Pomerium, which
answers a redirect to sign-in whether the app behind it is up or not -- every
app would look alive. So the probe goes to the BACKEND: the Pomerium Ingresses
say which service serves each host, and the service is asked directly.

WHY NOT kube-state-metrics' endpoint readiness: the LAN apps (NAS, Plex,
AdGuard) are hand-written Endpoints, ready by
definition. A powered-off NAS would read as up. A request cannot be fooled.

States:
  up       -- any HTTP reply, a 401 or 404 included: something is answering
  down     -- refused, timed out, or a 5xx (502/503 is a proxy with nothing behind)
  unknown  -- no Pomerium route for the host, or the probe has not run yet

Needs list/get on ingresses and services cluster-wide (nav-api's ClusterRole,
in the deployment). Without a service account token (tests,
local runs) nothing is probed and every host is unknown.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

# httpx is imported where it is used: CI runs these modules' unit tests with
# the standard library only (nav-api.yml), and the parts tested here -- the
# route table, the verdict, the lookup -- need nothing else.

log = logging.getLogger("nav.health")

SA = "/var/run/secrets/kubernetes.io/serviceaccount"
K8S = "https://kubernetes.default.svc"
EVERY = 60          # seconds between rounds
TIMEOUT = 4         # per probe
PARALLEL = 10

STATE: dict[str, dict[str, Any]] = {}   # host -> {state, detail, at}


def routes_from(ingresses: dict, services: dict) -> dict[str, dict[str, Any]]:
    """host -> {url, host}: the backend to ask, from the Pomerium Ingresses.

    The `/` path's backend per host, else the first: mealie's first path is
    an Exact /sw.js served by a separate killswitch, which says nothing about
    Mealie. A named service port is resolved through the Service, since DNS
    serves numbers.
    """
    ports: dict[tuple[str, str], dict[str, int]] = {}
    for s in services.get("items", []):
        m = s.get("metadata", {})
        ports[(m.get("namespace"), m.get("name"))] = {
            p.get("name"): p.get("port") for p in s.get("spec", {}).get("ports", []) if p.get("name")}
    out: dict[str, dict[str, Any]] = {}
    for ing in ingresses.get("items", []):
        spec, meta = ing.get("spec", {}), ing.get("metadata", {})
        if spec.get("ingressClassName") != "pomerium":
            continue
        ns = meta.get("namespace")
        tls = (meta.get("annotations") or {}).get("ingress.pomerium.io/secure_upstream") == "true"
        for rule in spec.get("rules", []):
            host = (rule.get("host") or "").lower()
            paths = (rule.get("http") or {}).get("paths") or []
            if not host or host in out or not paths:
                continue
            root = next((p for p in paths if p.get("path") in ("/", None, "")), paths[0])
            svc = (root.get("backend") or {}).get("service") or {}
            name, port = svc.get("name"), svc.get("port") or {}
            num = port.get("number") or ports.get((ns, name), {}).get(port.get("name"))
            if not name or not num:
                continue
            scheme = "https" if tls or num == 443 else "http"
            out[host] = {"url": f"{scheme}://{name}.{ns}.svc.cluster.local:{num}/", "host": host}
    return out


def verdict(status: int | None, error: str | None) -> tuple[str, str]:
    if error:
        return "down", error
    if status is not None and status >= 500:
        return "down", f"HTTP {status}"
    return "up", f"HTTP {status}"


async def probe(client: Any, route: dict[str, Any]) -> tuple[str, str]:
    import httpx
    try:
        # The public Host: preserve_host_header apps route on it. No
        # redirects followed -- a redirect is an answer.
        r = await client.get(route["url"], headers={"Host": route["host"]})
        return verdict(r.status_code, None)
    except httpx.TimeoutException:
        return verdict(None, "timed out")
    except httpx.ConnectError:
        return verdict(None, "refused")
    except httpx.HTTPError as exc:
        return verdict(None, type(exc).__name__)


async def discover() -> dict[str, dict[str, Any]]:
    import httpx
    with open(f"{SA}/token") as fh:
        token = fh.read().strip()
    async with httpx.AsyncClient(base_url=K8S, verify=f"{SA}/ca.crt", timeout=10,
                                 headers={"Authorization": f"Bearer {token}"}) as k:
        ing = await k.get("/apis/networking.k8s.io/v1/ingresses")
        svc = await k.get("/api/v1/services")
        ing.raise_for_status()
        svc.raise_for_status()
        return routes_from(ing.json(), svc.json())


async def one_round() -> None:
    import httpx
    routes = await discover()
    sem = asyncio.Semaphore(PARALLEL)
    # verify=False: a backend's certificate is for its public name (or self-
    # signed); this asks whether it answers, not who it is.
    async with httpx.AsyncClient(timeout=TIMEOUT, verify=False, follow_redirects=False) as client:
        async def run(host: str, route: dict[str, Any]) -> None:
            async with sem:
                state, detail = await probe(client, route)
            STATE[host] = {"state": state, "detail": detail, "at": int(time.time())}
        await asyncio.gather(*(run(h, r) for h, r in routes.items()))
    for gone in set(STATE) - set(routes):
        STATE.pop(gone, None)


async def loop() -> None:
    if not os.path.exists(f"{SA}/token"):
        log.info("no service account token: health checks off")
        return
    while True:
        try:
            await one_round()
        except Exception as exc:  # a round that fails leaves the last answers standing
            log.warning("health round failed: %s", exc)
        await asyncio.sleep(EVERY)


def lookup(hosts: list[str]) -> dict[str, dict[str, Any]]:
    """The last answer per host. One older than a few rounds is unknown: the
    probes stopped (the API refused, the loop died), and an old "up" is a
    claim nobody is checking."""
    now, out = time.time(), {}
    for h in hosts:
        h = h.lower()
        got = STATE.get(h)
        if not got:
            out[h] = {"state": "unknown", "detail": "not checked (no Pomerium route)"}
        elif now - got["at"] > 5 * EVERY:
            out[h] = {"state": "unknown", "detail": "last checked too long ago", "at": got["at"]}
        else:
            out[h] = got
    return out
