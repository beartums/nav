"""The registered widget providers. See widgets.py for the interface.

One class per data source. Importing this module registers them, so app.py
imports it once and never refers to a provider by name.

Providers that call out (VictoriaMetrics, Sonarr, Plex...) belong here rather
than in widgets.py: they may need httpx, and widgets.py stays standard-library
so its tests run in CI without pip install.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import os
import time
from typing import Any

import httpx

import chorecal
import chores
import clock
import creds
import mealie
import media
import openchore
import promql
import remote
import weather
from widgets import EVERYONE, SHAPES, ActionError, Provider, register

# The operator names the service vmsingle-<CR name>; the CR is the chart's
# fullname, <release>-victoria-metrics-k8s-stack, and the release is
# `monitoring` (apps/monitoring.yaml). Overridable for when that changes.
VM_URL = os.environ.get(
    "NAV_VM_URL",
    "http://vmsingle-monitoring-victoria-metrics-k8s-stack.monitoring.svc.cluster.local:8428",
).rstrip("/")


@register
class NavVersion(Provider):
    """The plumbing check: proves registry -> cache -> endpoint -> renderer end
    to end with no upstream to blame. EVERYONE is honest here -- it shows what
    /api/version already gives any signed-in user."""
    type = "nav.version"
    title = "nav version"
    description = "The nav-api build that is running."
    app = EVERYONE
    shape = "stat"
    ttl = 300

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        sha = os.environ.get("NAV_VERSION", "unknown")
        return {"value": sha[:7] if sha != "unknown" else sha,
                "label": "nav-api",
                "sub": os.environ.get("NAV_BUILT_AT", "unknown")}


# --- VictoriaMetrics --------------------------------------------------------
#
# Gated on `grafana`: whoever can open Grafana can already query every metric,
# so these reveal nothing new to them -- and nothing at all to anyone else.
#
# The query is the user's own PromQL. That is safe because the API is
# read-only and the gate above already allows arbitrary queries via Grafana;
# the timeout and fixed point counts keep one widget from being expensive.

DISPLAY = {
    "headline": {"type": "string", "label": "Headline"},
    # A template: plain text ("°C", "/s") or a label from the result, so the
    # value can carry WHICH thing it is ("82% grifPool" from "{{pool}}").
    "unit": {"type": "string", "label": "After the value: text or {{label}}", "template": True},
    "format": {"type": "enum", "label": "Format", "default": "number",
               "choices": ["number", "percent", "bytes", "seconds"]},
    "decimals": {"type": "integer", "label": "Decimals", "default": 1},
}


async def vm(path: str, params: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(base_url=VM_URL, timeout=10) as client:
        r = await client.get(path, params=params)
        # VictoriaMetrics puts the PromQL error in a 4xx body; surface it
        # rather than a bare status code.
        if r.status_code >= 400:
            try:
                msg = r.json().get("error")
            except Exception:  # noqa: BLE001 -- not JSON: fall through to the status
                msg = None
            if msg:
                raise ValueError(f"VictoriaMetrics: {msg}")
            r.raise_for_status()
        return r.json()


def display(config: dict[str, Any]) -> dict[str, Any]:
    return {k: config.get(k) for k in DISPLAY if config.get(k) not in (None, "")}


async def instant_labels(query: str) -> dict[str, Any]:
    rows = promql.result(await vm("/api/v1/query", {"query": query}), "vector")
    return promql.label_summary(rows)


@register
class VmStat(Provider):
    type = "vm.stat"
    title = "Metric value"
    description = "One number from a PromQL query, with an optional trend line and thresholds."
    app = "grafana"
    shape = "stat"
    ttl = 30
    config_schema = {
        # max() and friends drop every label; `max by (pool) (...)` or
        # `topk(1, ...)` keeps the one {{pool}} would name.
        "query": {"type": "string", "label": "PromQL (one series; keep labels with by (...))",
                  "required": True},
        **DISPLAY,
        "range": {"type": "enum", "label": "Trend range", "default": "6h",
                  "choices": list(promql.RANGES)},
        "warn": {"type": "number", "label": "Warn at"},
        "crit": {"type": "number", "label": "Critical at"},
        "higher_is": {"type": "enum", "label": "Higher is", "default": "bad",
                      "choices": ["bad", "good"]},
    }
    # Metric names as the alerting rules use them
    # (the deployment's alerting rules), so each is known
    # to be scraped. Longhorn is not scraped, hence no volume-health preset.
    presets = [
        {"title": "Busiest node CPU", "config": {
            "query": "100 * (" + 'topk(1, 1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))' + ")",
            "headline": "Busiest node CPU", "unit": "{{instance}}", "format": "percent",
            "decimals": 0, "warn": 80, "crit": 90}},
        {"title": "Fullest node memory", "config": {
            "query": "100 * (" + "topk(1, 1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)" + ")",
            "headline": "Fullest node memory", "unit": "{{instance}}", "format": "percent",
            "decimals": 0, "warn": 80, "crit": 90}},
        {"title": "Fullest node disk", "config": {
            "query": "100 * (" + 'topk(1, 1 - node_filesystem_avail_bytes{mountpoint="/"} '
                     '/ node_filesystem_size_bytes{mountpoint="/"})' + ")",
            "headline": "Fullest root disk", "unit": "{{instance}}", "format": "percent",
            "decimals": 0, "warn": 85, "crit": 95}},
        {"title": "Fullest PVC", "config": {
            "query": "100 * (" + "topk(1, 1 - kubelet_volume_stats_available_bytes "
                     "/ kubelet_volume_stats_capacity_bytes)" + ")",
            "headline": "Fullest volume", "unit": "{{persistentvolumeclaim}}", "format": "percent",
            "decimals": 0, "warn": 85, "crit": 95}},
        {"title": "Pods not ready", "config": {
            "query": 'count(kube_pod_status_ready{condition="true"} == 0 unless on (pod, namespace) '
                     'kube_pod_status_phase{phase=~"Succeeded|Failed"} > 0) or vector(0)',
            "headline": "Pods not ready", "decimals": 0, "warn": 1, "crit": 3}},
        {"title": "Container restarts (1h)", "config": {
            "query": "sum(increase(kube_pod_container_status_restarts_total[1h]))",
            "headline": "Restarts, last hour", "decimals": 0, "warn": 3, "crit": 10}},
        {"title": "Nodes not ready", "config": {
            "query": 'count(kube_node_status_condition{condition="Ready",status="true"} == 0) or vector(0)',
            "headline": "Nodes not ready", "decimals": 0, "warn": 1, "crit": 1}},
        {"title": "UPS runtime (edge)", "config": {
            "query": 'network_ups_tools_battery_runtime{ups="cyberpower_edge"}',
            "headline": "Edge UPS runtime", "format": "seconds", "decimals": 0,
            "range": "24h", "warn": 2700, "crit": 1800, "higher_is": "good"}},
        {"title": "Last backup age", "config": {
            "query": "time() - griflab_backup_last_success_timestamp_seconds",
            "headline": "Since last backup", "format": "seconds", "decimals": 1,
            "range": "7d", "warn": 100800, "crit": 129600}},
        {"title": "Backup disk used", "config": {
            "query": "100 * (" + '1 - node_filesystem_avail_bytes{job="backup-nas", mountpoint="/srv/backup"} '
                     '/ node_filesystem_size_bytes{job="backup-nas", mountpoint="/srv/backup"}' + ")",
            "headline": "Backup disk used", "format": "percent", "decimals": 0,
            "range": "7d", "warn": 85, "crit": 95}},
    ]

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        q, now = config["query"], time.time()
        row = promql.single(promql.result(await vm("/api/v1/query", {"query": q}), "vector"), q)
        value = promql.number(row["value"][1]) if row else None
        span = promql.RANGES[config["range"]]
        rows = promql.result(await vm("/api/v1/query_range", {
            "query": q, "start": now - span, "end": now,
            "step": promql.step_for(span, 48)}), "matrix")
        spark = promql.points(rows[0]["values"]) if len(rows) == 1 else []
        out = {"value": value, "label": config.get("headline") or q,
               "sub": None if row else "no data", "spark": spark,
               "level": promql.level(value, config.get("warn"), config.get("crit"),
                                     config["higher_is"]),
               **display(config)}
        if out.get("unit"):
            out["unit"] = promql.fill(out["unit"], (row or {}).get("metric") or {})
        return out

    async def labels(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        return await instant_labels(config["query"])


@register
class VmTimeseries(Provider):
    type = "vm.timeseries"
    title = "Metric chart"
    description = "A PromQL query over time, one line per series (up to 8)."
    app = "grafana"
    shape = "timeseries"
    ttl = 60
    config_schema = {
        "query": {"type": "string", "label": "PromQL", "required": True},
        **DISPLAY,
        "range": {"type": "enum", "label": "Range", "default": "24h",
                  "choices": list(promql.RANGES)},
        "legend": {"type": "string", "label": "Line names, e.g. {{instance}}", "template": True},
        # Drawn as reference lines; the worst LATEST value across the lines
        # sets the status, which compact sizes show as a dot.
        "warn": {"type": "number", "label": "Warn at"},
        "crit": {"type": "number", "label": "Critical at"},
        "higher_is": {"type": "enum", "label": "Higher is", "default": "bad",
                      "choices": ["bad", "good"]},
    }
    presets = [
        {"title": "CPU by node", "config": {
            "query": "100 * (" + '1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))' + ")",
            "headline": "CPU by node", "legend": "{{instance}}", "format": "percent",
            "decimals": 0, "range": "24h", "warn": 90}},
        {"title": "Memory by node", "config": {
            "query": "100 * (" + "1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes" + ")",
            "headline": "Memory by node", "legend": "{{instance}}", "format": "percent",
            "decimals": 0, "range": "24h", "warn": 90}},
        {"title": "Root disk by node", "config": {
            "query": "100 * (" + '1 - node_filesystem_avail_bytes{mountpoint="/"} '
                     '/ node_filesystem_size_bytes{mountpoint="/"}' + ")",
            "headline": "Root disk by node", "legend": "{{instance}}", "format": "percent",
            "decimals": 0, "range": "7d", "warn": 85, "crit": 95}},
        {"title": "Network in by node", "config": {
            "query": 'sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*|flannel.*|cni.*"}[5m]))',
            "headline": "Network in", "legend": "{{instance}}", "unit": "/s", "format": "bytes",
            "decimals": 1, "range": "24h"}},
        {"title": "Restarts by namespace", "config": {
            "query": "topk(8, sum by (namespace) (increase(kube_pod_container_status_restarts_total[1h])))",
            "headline": "Restarts per hour", "legend": "{{namespace}}", "decimals": 0,
            "range": "24h"}},
        {"title": "UPS battery", "config": {
            "query": "network_ups_tools_battery_charge",
            "headline": "UPS battery", "legend": "{{ups}}", "unit": "%", "decimals": 0,
            "range": "7d", "warn": 50, "crit": 25, "higher_is": "good"}},
    ]

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        q, now = config["query"], time.time()
        span = promql.RANGES[config["range"]]
        rows = promql.result(await vm("/api/v1/query_range", {
            "query": q, "start": now - span, "end": now,
            "step": promql.step_for(span, 120)}), "matrix")
        unit = config.get("unit") or ""
        per_line = bool(promql.TEMPLATE.search(unit))
        named = []
        for r in rows:
            m = r.get("metric") or {}
            s = {"name": promql.series_name(m, config.get("legend", "")),
                 "points": promql.points(r.get("values") or [])}
            if per_line:
                s["unit"] = promql.fill(unit, m)     # each line its own identifier
            named.append(s)
        named.sort(key=lambda s: s["name"])
        shown = named[:promql.MAX_SERIES]
        out = {"label": config.get("headline") or q,
               "series": shown,
               "warn": config.get("warn"), "crit": config.get("crit"),
               "higher_is": config["higher_is"],
               # Judged on the lines DRAWN: a status from a hidden ninth line
               # would be a warning nobody can find on the chart.
               "level": promql.worst_level([s["points"] for s in shown], config.get("warn"),
                                           config.get("crit"), config["higher_is"]),
               # Said, not silently dropped: the fix is in the query.
               "truncated": max(0, len(named) - promql.MAX_SERIES),
               "range": [now - span, now],
               **display(config)}
        if per_line:
            out.pop("unit", None)
        return out

    async def labels(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        return await instant_labels(config["query"])


# --- clock and weather ---------------------------------------------------------
#
# EVERYONE, honestly: the time, and the weather in a place the definition
# names, reveal nothing a nav user could not see out of a window.

@register
class Clock(Provider):
    """The browser does the ticking; this resolves and checks the zones, so a
    typo is an error in the designer rather than a clock quietly showing the
    wrong city. Long ttl: nothing here changes until the definition does --
    and it bounds the geocoding to once an hour per definition."""
    type = "clock"
    title = "Clock"
    description = "Date and time, digital or analog, for one or more time zones."
    app = EVERYONE
    shape = "clock"
    ttl = 3600
    config_schema = {
        "zones": {"type": "string",
                  "label": "Clocks, comma-separated: a city or place (Brooklyn, Tokyo), "
                           "Label=place, an Area/City zone, or Home (your own time)",
                  "default": ""},
        "style": {"type": "enum", "label": "Style", "default": "digital",
                  "choices": ["digital", "analog"]},
        "seconds": {"type": "bool", "label": "Show seconds", "default": False},
        "date": {"type": "bool", "label": "Show the date", "default": True},
        "hours": {"type": "enum", "label": "Hours", "default": "auto",
                  "choices": ["auto", "12", "24"]},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        zones = clock.parse_zones(config["zones"])
        if any(z["place"] for z in zones):
            async with httpx.AsyncClient(timeout=10) as client:
                for z in zones:
                    if z["place"]:
                        r = await client.get(weather.GEOCODE_URL,
                                             params={"name": z["place"], "count": 10})
                        r.raise_for_status()
                        z["tz"] = clock.zone_from_geocode(r.json(), z["place"])
        for z in zones:
            del z["place"]
        return {"zones": zones, "style": config["style"],
                "seconds": config["seconds"], "date": config["date"], "hours": config["hours"]}


@register
class Weather(Provider):
    """Open-Meteo: no key, so no secret. Two calls (geocode, forecast) per ttl
    per definition -- the shared cache makes that per definition, not per
    viewer. Times are the PLACE's local time."""
    type = "weather"
    title = "Weather"
    description = "Now, the next hours and the week ahead for a place (Open-Meteo)."
    app = EVERYONE
    shape = "weather"
    ttl = 900
    config_schema = {
        "location": {"type": "string", "label": "Place (a city, or lat,lon)", "required": True},
        "label": {"type": "string", "label": "Show it as (optional)"},
        "units": {"type": "enum", "label": "Units", "default": "metric",
                  "choices": ["metric", "imperial"]},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        loc = config["location"].strip()
        async with httpx.AsyncClient(timeout=10) as client:
            at = weather.coords(loc)
            if at is None:
                r = await client.get(weather.GEOCODE_URL, params={"name": loc, "count": 1})
                r.raise_for_status()
                p = weather.place(r.json(), loc)
                at, name = (p["lat"], p["lon"]), p["name"]
            else:
                name = loc
            r = await client.get(weather.FORECAST_URL,
                                 params=weather.forecast_params(at[0], at[1], config["units"]))
            if r.status_code >= 400:
                # Open-Meteo says what was wrong in the body: {"reason": ...}.
                try:
                    why = r.json().get("reason")
                except Exception:  # noqa: BLE001 -- not JSON: fall through to the status
                    why = None
                if why:
                    raise ValueError(f"Open-Meteo: {why}")
                r.raise_for_status()
        return weather.payload(r.json(), config.get("label") or name, config["units"])


# --- the *arr calendars, Seerr, Mealie -------------------------------------------
#
# Where each app lives and its key: creds.py (the database, encrypted; then
# env vars; then defaults), resolved per fetch so an edit in the UI applies on
# the next refresh. A missing key is that widget's error, not a crash.

ARR_API = {"sonarr": "/api/v3", "radarr": "/api/v3", "lidarr": "/api/v1"}


async def keyed_get(client: httpx.AsyncClient, slug: str, path: str,
                    params: dict[str, Any] | None = None) -> Any:
    base, key, _ = creds.resolve(slug)
    if not key:
        raise ValueError(f"no API key for {creds.APPS[slug]['label']} -- add one in Connections")
    r = await client.get(base + path, params=params, headers=creds.headers(slug, key))
    if r.status_code in (401, 403):
        raise ValueError(f"HTTP {r.status_code}: the API key was refused")
    if r.status_code >= 400:
        raise ValueError(f"HTTP {r.status_code} from {path}")
    return r.json()


@register
class ArrCalendar(Provider):
    """Episodes, films and albums due, from Sonarr, Radarr and Lidarr. A
    source that fails is a warning under the rest, not a broken widget."""
    type = "arr.calendar"
    title = "Coming up"
    description = "New episodes, films and albums from Sonarr, Radarr and Lidarr, by week or month."
    app = ("sonarr", "radarr", "lidarr")
    shape = "calendar"
    ttl = 900
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Coming up"},
        "tv": {"type": "bool", "label": "TV (Sonarr)", "default": True},
        "movies": {"type": "bool", "label": "Films (Radarr)", "default": True},
        "music": {"type": "bool", "label": "Music (Lidarr)", "default": True},
        "view": {"type": "enum", "label": "Opens on", "default": "week",
                 "choices": ["week", "month"]},
        "unmonitored": {"type": "bool", "label": "Include unmonitored", "default": False},
    }

    @classmethod
    def needs(cls, config: dict[str, Any]) -> set[str]:
        return {slug for kind, slug in media.KINDS.items() if config.get(kind, True)}

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        start, end = media.window(dt.datetime.now(dt.timezone.utc).date())
        params = {"start": start, "end": end,
                  "unmonitored": str(config["unmonitored"]).lower()}
        names = {"sonarr": "Sonarr", "radarr": "Radarr", "lidarr": "Lidarr"}

        async def one(slug: str, client: httpx.AsyncClient) -> list[dict[str, Any]]:
            extra = {"sonarr": {"includeSeries": "true"}, "lidarr": {"includeArtist": "true"}}
            got = await keyed_get(client, slug, ARR_API[slug] + "/calendar",
                                  {**params, **extra.get(slug, {})})
            if slug == "sonarr":
                return media.sonarr_events(got)
            if slug == "radarr":
                return media.radarr_events(got, start, end)
            return media.lidarr_events(got)

        slugs = sorted(self.needs(config))
        if not slugs:
            raise ValueError("choose at least one of TV, films or music")
        async with httpx.AsyncClient(timeout=10) as client:
            got = await asyncio.gather(*(one(s, client) for s in slugs), return_exceptions=True)
        parts, warnings = [], []
        for slug, r in zip(slugs, got):
            if isinstance(r, BaseException):
                warnings.append(f"{names[slug]}: {type(r).__name__}: {r}"[:160])
            else:
                parts.append(r)
        if not parts:
            raise ValueError("; ".join(warnings))
        return media.calendar(parts, config["label"], config["view"], warnings, (start, end))


@register
class SeerrRequests(Provider):
    """Recent requests and where each stands. Titles come from Seerr's own
    TMDB lookups, one per request, cached with the list."""
    type = "seerr.requests"
    title = "Requests"
    description = "Recent Seerr requests: what was asked for, by whom, and whether it is ready."
    app = "seerr"
    shape = "list"
    ttl = 120
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Requests"},
        "filter": {"type": "enum", "label": "Show", "default": "all",
                   "choices": list(media.SEERR_FILTERS)},
        "take": {"type": "integer", "label": "How many", "default": 10},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        public = creds.resolve("seerr")[2]
        take = max(1, min(int(config["take"]), 25))
        async with httpx.AsyncClient(timeout=10) as client:
            got = await keyed_get(client, "seerr", "/api/v1/request", {
                "take": take, "skip": 0, "filter": config["filter"], "sort": "added"})
            reqs = got.get("results") or []

            async def detail(req: dict[str, Any]) -> dict[str, Any] | None:
                m = req.get("media") or {}
                kind = "tv" if (req.get("type") or m.get("mediaType")) == "tv" else "movie"
                if not m.get("tmdbId"):
                    return None
                try:
                    return await keyed_get(client, "seerr", f"/api/v1/{kind}/{m['tmdbId']}")
                except Exception:  # noqa: BLE001 -- the item shows its TMDB id instead
                    return None

            details = await asyncio.gather(*(detail(r) for r in reqs))
            try:
                counts = await keyed_get(client, "seerr", "/api/v1/request/count")
            except Exception:  # noqa: BLE001 -- the count is a nicety
                counts = None
        now = dt.datetime.now(dt.timezone.utc)
        return {"label": config["label"], "note": media.seerr_note(counts),
                "items": [media.seerr_item(r, d, public, now) for r, d in zip(reqs, details)],
                "empty": "No requests."}


async def mealie_group(client: httpx.AsyncClient) -> str | None:
    """The group slug recipe links need (/g/<group>/r/<recipe>); a link-less
    list beats no list, so a failure here is None."""
    try:
        return (await mealie_get(client, "/api/groups/self")).get("slug")
    except Exception:  # noqa: BLE001
        return None


async def mealie_get(client: httpx.AsyncClient, path: str,
                     params: dict[str, Any] | None = None) -> Any:
    return await keyed_get(client, "mealie", path, params)


@register
class MealiePlan(Provider):
    """The household's meal plan. Days are the SERVER's calendar (nav-api runs
    in UTC unless TZ is set), so "today" turns over at midnight there."""
    type = "mealie.plan"
    title = "Meal plan"
    description = "What's for dinner (or every meal) today or over the coming days, from Mealie."
    app = "mealie"
    shape = "list"
    ttl = 300
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Dinner"},
        "days": {"type": "enum", "label": "Days", "default": "week",
                 "choices": list(mealie.DAYS)},
        "meals": {"type": "enum", "label": "Meals", "default": "dinner",
                  "choices": ["dinner", "all"]},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        today = dt.date.today()
        end = today + dt.timedelta(days=mealie.DAYS[config["days"]] - 1)
        async with httpx.AsyncClient(timeout=10) as client:
            got = await mealie_get(client, "/api/households/mealplans", {
                "start_date": today.isoformat(), "end_date": end.isoformat(),
                "perPage": 100, "orderBy": "date", "orderDirection": "asc"})
            group = await mealie_group(client)
        items = mealie.plan_items(got.get("items") or [], config["meals"], today, creds.resolve("mealie")[2], group)
        return {"label": config["label"], "items": items,
                "empty": "Nothing planned." if config["days"] != "today" else "Nothing planned tonight."}


RECIPES: dict[str, dict[str, Any]] = {}     # id -> {name, slug}; names rarely change


@register
class MealieComments(Provider):
    type = "mealie.comments"
    title = "Recipe comments"
    description = "The latest comments on Mealie recipes."
    app = "mealie"
    shape = "list"
    ttl = 300
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Recipe comments"},
        "take": {"type": "integer", "label": "How many", "default": 8},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        take = max(1, min(int(config["take"]), 25))
        async with httpx.AsyncClient(timeout=10) as client:
            got = await mealie_get(client, "/api/comments", {
                "perPage": take, "page": 1, "orderBy": "createdAt", "orderDirection": "desc"})
            comments = got.get("items") or []
            missing = {str(mealie.get(c, "recipeId", "recipe_id")) for c in comments} - set(RECIPES)

            async def recipe(rid: str) -> None:
                try:
                    r = await mealie_get(client, f"/api/recipes/{rid}")
                    RECIPES[rid] = {"name": r.get("name"), "slug": r.get("slug")}
                except Exception:  # noqa: BLE001 -- shown as "a recipe"
                    pass

            await asyncio.gather(*(recipe(r) for r in missing if r and r != "None"))
            group = await mealie_group(client)
        now = dt.datetime.now(dt.timezone.utc)
        return {"label": config["label"],
                "items": mealie.comment_items(comments, RECIPES, now, creds.resolve("mealie")[2], group),
                "empty": "No comments yet."}


# --- the remote widget ---------------------------------------------------------
#
# Any HTTP service that returns one of the shapes' JSON (docs/widgets.md).
# Admin-only to set up -- see remote.py for why.

@register
class DonetickChores(Provider):
    """What is due in Donetick, by when, and whose it is. One request for the
    chores and one for the household's names, both as the token's user --
    so the token's owner should be a member who sees every shared chore."""
    type = "donetick.chores"
    title = "Chores"
    description = "Donetick chores: overdue, today and the week ahead, with who each is on."
    app = "donetick"
    shape = "list"
    ttl = 120
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Chores"},
        "horizon": {"type": "enum", "label": "Show", "default": "week",
                    "choices": list(chores.HORIZONS)},
        "person": {"type": "string", "label": "Only this person (name, blank for everyone)",
                   "default": ""},
        # Whose "today": the household's. NAV_TZ sets the default for every
        # widget; the tz database ships in the image (see clock.py).
        "timezone": {"type": "string", "label": "Time zone",
                     "default": os.environ.get("NAV_TZ") or "UTC"},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        chores.zone(config["timezone"])          # a bad zone is an error tile, before any I/O
        public = creds.resolve("donetick")[2]
        async with httpx.AsyncClient(timeout=10) as client:
            got = await keyed_get(client, "donetick", "/eapi/v1/chore")
            try:
                members = await keyed_get(client, "donetick", "/eapi/v1/circle/members")
            except Exception:  # noqa: BLE001 -- rows say "Unassigned" rather than fail
                members = None
        items, overdue = chores.chore_items(
            got if isinstance(got, list) else [], members if isinstance(members, list) else None,
            dt.datetime.now(dt.timezone.utc), config["timezone"], config["horizon"],
            config["person"], public)
        return {"label": config["label"], "note": chores.note(overdue, len(items)),
                "items": items,
                "empty": "Nothing due." if config["horizon"] != "all" else "No chores yet."}


# OpenChore's wall-display endpoints are public and read-only, so no key and
# no Connections entry: an in-cluster URL (NAV_OPENCHORE_URL overrides) and the
# public one rows link to.
OPENCHORE_URL = os.environ.get("NAV_OPENCHORE_URL", "http://openchore.tools.svc.cluster.local")
OPENCHORE_PUBLIC = os.environ.get("NAV_OPENCHORE_PUBLIC", "")


@register
class OpenChoreChores(Provider):
    """Today's (or the next week's) chores in OpenChore, per person, with
    what is done. Read-only: one request for the people, then two per person
    (chores, points), all against the endpoints its wall display reads."""
    type = "openchore.chores"
    title = "Chores (OpenChore)"
    description = "OpenChore: today's chores per person with points, or the week ahead by day."
    app = "openchore"
    shape = "list"
    ttl = 120
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Chores"},
        "horizon": {"type": "enum", "label": "Show", "default": "today",
                    "choices": list(openchore.HORIZONS)},
        "person": {"type": "string", "label": "Only this person (name, blank for everyone)",
                   "default": ""},
        "timezone": {"type": "string", "label": "Time zone",
                     "default": os.environ.get("NAV_TZ") or "UTC"},
    }

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        tz = openchore.zone(config["timezone"])
        today = dt.datetime.now(tz).date()
        week = config["horizon"] == "week"
        base = OPENCHORE_URL.rstrip("/")

        async def get(client: httpx.AsyncClient, path: str, params: dict[str, Any] | None = None) -> Any:
            r = await client.get(base + path, params=params)
            if r.status_code >= 400:
                raise ValueError(f"HTTP {r.status_code} from OpenChore {path}")
            return r.json()

        async with httpx.AsyncClient(timeout=10) as client:
            users = openchore.people(await get(client, "/api/users"), config["person"])

            async def one(u: dict[str, Any]) -> tuple[dict[str, Any], list[Any], int | None]:
                # OpenChore's "weekly" is Monday-Sunday around `date`; the next
                # seven days can straddle two of them.
                dates = [today] + ([today + dt.timedelta(days=6)] if week else [])
                got: list[Any] = []
                for d in {x.isocalendar()[:2]: x for x in dates}.values():
                    rows = await get(client, f"/api/users/{u['id']}/chores",
                                     {"view": "weekly" if week else "daily", "date": d.isoformat()})
                    got += rows if isinstance(rows, list) else []
                try:
                    pts = (await get(client, f"/api/users/{u['id']}/points")).get("balance")
                except Exception:  # noqa: BLE001 -- the heading drops its points, the rows stay
                    pts = None
                return u, got, pts if isinstance(pts, int) else None

            by_user = await asyncio.gather(*(one(u) for u in users))
        items, done, total = openchore.chore_items(list(by_user), config["horizon"], today,
                                                   OPENCHORE_PUBLIC.rstrip("/"))
        return {"label": config["label"], "note": openchore.note(done, total), "items": items,
                "empty": "Nothing scheduled." if users else "No one in OpenChore yet."}


async def cb_call(client: httpx.AsyncClient, method: str, path: str, who: str | None,
                  body: dict[str, Any] | None = None, params: dict[str, Any] | None = None,
                  via: str | None = None) -> Any:
    """A choreboard request, as `who` when given (X-Choreboard-As: the
    token needs the act_as scope), so choreboard applies THAT person's
    permissions. `via`: the real viewer, an admin acting as `who`
    (choreboard checks they're an admin and records them). Its refusals come
    back as ActionError, in its words."""
    base, key, _ = creds.resolve("choreboard")
    if not key:
        raise ActionError(503, "no API key for Choreboard -- add one in Connections")
    headers = creds.headers("choreboard", key)
    if who:
        headers["X-Choreboard-As"] = who
    if who and via and via.lower() != who.lower():
        headers["X-Choreboard-Via"] = via
    r = await client.request(method, base + path, json=body, params=params, headers=headers)
    if r.status_code >= 400:
        try:
            msg = r.json().get("error") or r.json().get("detail") or r.text
        except ValueError:
            msg = r.text
        if r.status_code == 401:
            msg = "Choreboard refused the API key -- check it in Connections"
        raise ActionError(r.status_code if r.status_code < 500 else 502, str(msg)[:300])
    return r.json() if r.content else {}


# Widget action -> (method, choreboard path, body) for the simple ones; the
# rest are spelled out in act(). The VIEWER does each one (X-Choreboard-As),
# so choreboard's permissions -- who may mark what, when -- decide.
CB_OUTCOMES = ("done", "skipped", "failed", "covered", "failed_covered")


@register
class ChoreboardCalendar(Provider):
    """choreboard's calendar -- who does which chore when, swaps and outcomes
    included -- drawn by the calendar shape, coloured by person. Interactive:
    each chore offers what the VIEWER may do with it (choreboard decides),
    acted on as the viewer."""
    type = "choreboard.calendar"
    title = "Chore calendar"
    description = "Choreboard: who does which chore, by week or month; mark done, swap, approve swaps."
    app = "choreboard"
    shape = "calendar"
    ttl = 120
    acts_as = True        # choreboard admins: "as Toby", recorded as done by the admin as Toby
    actions = (*CB_OUTCOMES, "undo", "skip", "give", "swap", "propose_swap", "approve_swap", "decline_swap",
               "cancel_swap", "candidates", "undo_swap", "request_undo", "propose_give")
    config_schema = {
        "label": {"type": "string", "label": "Headline", "default": "Chores"},
        "view": {"type": "enum", "label": "Opens on", "default": "week", "choices": ["week", "month"]},
        "show": {"type": "enum", "label": "Whose chores", "default": "everyone", "choices": ["everyone", "mine"]},
        "skipped": {"type": "bool", "label": "Show skipped days", "default": True},
    }

    @classmethod
    def per_user_for(cls, config: dict[str, Any]) -> bool:
        return True       # what you can do, and your unread count, are yours

    async def fetch(self, config: dict[str, Any], who: str, as_: int | None = None) -> dict[str, Any]:
        start, end = chorecal.window(dt.date.today())
        async with httpx.AsyncClient(timeout=10) as client:
            people, chores_ = await asyncio.gather(cb_call(client, "GET", "/api/people", None),
                                                   cb_call(client, "GET", "/api/chores", None))
            real = next((p for p in people if (p.get("email") or "").lower() == who.lower()), None)
            via = None
            if as_:
                target = await self._as(client, as_)
                if target.lower() != who.lower():      # "as" yourself is just you
                    who, via = target, who
            me = next((p for p in people if (p.get("email") or "").lower() == who.lower()), None)
            # As the viewer when Choreboard knows them (their own `can` lists);
            # otherwise as the token's owner, read-only from their side.
            as_me = who if me else None
            try:
                entries = await cb_call(client, "GET", "/api/calendar", as_me, params={"from": start, "to": end},
                                        via=via)
            except ActionError as e:
                if as_me is None or e.status != 403 or via:
                    raise ValueError(e.message) from None
                as_me = None                  # the token lacks act_as: still show the calendar
                entries = await cb_call(client, "GET", "/api/calendar", None, params={"from": start, "to": end})
            unread = 0
            if as_me:
                try:
                    unread = int((await cb_call(client, "GET", "/api/me/inbox", as_me, via=via,
                                                params={"unread": "true", "limit": 1})).get("unread", 0))
                except Exception:  # noqa: BLE001 -- the bell is a nicety
                    unread = 0
        mine = None
        if config["show"] == "mine":
            if me is None:
                raise ValueError(f"{who} isn't in Choreboard yet; sign in there once")
            mine = me["id"]
        events, legend = chorecal.events(entries, people, chores_, mine, config["skipped"])
        if not as_me:
            for e in events:
                e["can"], e["cannot"] = [], {}
        out = media.calendar([events], config["label"], config["view"], [], (start, end))
        public = creds.resolve("choreboard")[2]
        out.update({"legend": legend, "actions": bool(as_me), "unread": unread,
                    "inbox_url": f"{public}/inbox" if public else "",
                    "people": [{"id": p["id"], "name": p.get("name")} for p in people if p.get("active", 1)],
                    # Choreboard admins may act as anyone else (choreboard checks it again on every call).
                    "can_act_as": bool(real and real.get("role") == "admin" and as_me is not None),
                    "acting_as": {"id": me["id"], "name": me.get("name")} if via and me else None})
        return out

    @staticmethod
    async def _as(client: httpx.AsyncClient, person_id: int) -> str:
        """The email choreboard knows person `person_id` by."""
        people = await cb_call(client, "GET", "/api/people", None)
        p = next((p for p in people if p.get("id") == person_id and p.get("active", 1)), None)
        if p is None or not p.get("email"):
            raise ActionError(404, "no such person in Choreboard (or they have no sign-in)")
        return str(p["email"])

    async def act(self, config: dict[str, Any], who: str, action: str, params: dict[str, Any],
                  as_: int | None = None) -> dict[str, Any]:
        key = str(params.get("key") or "")
        note = str(params.get("note") or params.get("reason") or "").strip()
        async with httpx.AsyncClient(timeout=15) as client:
            via = None
            if as_:
                target = await self._as(client, as_)
                if target.lower() != who.lower():      # "as" yourself is just you
                    who, via = target, who

            async def cb(method: str, path: str, body: dict[str, Any] | None = None,
                         params: dict[str, Any] | None = None) -> Any:
                return await cb_call(client, method, path, who, body, params, via=via)
            settle = params.get("pending") if params.get("pending") in ("approve", "decline") else None
            if action in CB_OUTCOMES:
                body: dict[str, Any] = {"status": action, "note": note}
                if action in ("covered", "failed_covered"):
                    body["done_by"] = int(params.get("done_by") or 0) or None
                if action in ("failed", "failed_covered"):
                    body["deduct"] = int(params.get("deduct") or 0)
                return await cb("POST", f"/api/occurrences/{key}/outcome", body)
            if action == "undo":
                return await cb("POST", f"/api/outcomes/{int(params['outcome_id'])}/undo",
                                {"note": note or "undone from nav"})
            if action == "skip":
                return await cb("POST", f"/api/occurrences/{key}/skip", {"reason": note, "pending": settle})
            if action == "give":
                return await cb("POST", f"/api/occurrences/{key}/reassign",
                                {"person_id": int(params["person_id"]), "reason": note, "pending": settle})
            if action in ("swap", "propose_swap"):
                path = "/api/swaps" if action == "swap" else "/api/swap-requests"
                swap_body: dict[str, Any] = {"a": key, "b": str(params["other"]), "reason": note}
                if action == "swap":
                    swap_body["pending"] = settle
                return await cb("POST", path, swap_body)
            if action in ("approve_swap", "decline_swap"):
                verb = "approve" if action == "approve_swap" else "decline"
                return await cb("POST", f"/api/swap-requests/{int(params['request'])}/{verb}", {"reason": note})
            if action == "undo_swap":
                group = str(params.get("group") or "")
                if not group.startswith("sw_"):
                    raise ActionError(400, "that day isn't swapped")
                return await cb("DELETE", f"/api/overrides/{group}")
            if action == "propose_give":
                return await cb("POST", "/api/swap-requests/give",
                                {"key": key, "person_id": int(params["person_id"]), "reason": note})
            if action == "request_undo":
                return await cb("POST", "/api/swap-requests/undo", {"key": key, "reason": note})
            if action == "cancel_swap":
                return await cb("POST", f"/api/swap-requests/{int(params['request'])}/cancel")
            if action == "candidates":
                today = dt.date.today()
                start = today.isoformat()
                end = (today + dt.timedelta(weeks=int(params.get("weeks") or 12))).isoformat()
                entries, people, chores_ = await asyncio.gather(
                    cb("GET", "/api/calendar", params={"from": min(start, key.split(":")[1]), "to": end}),
                    cb_call(client, "GET", "/api/people", None), cb_call(client, "GET", "/api/chores", None))
                return {"candidates": chorecal.candidates(entries, key, people, chores_, start)}
        raise ActionError(400, f"unknown action {action}")


@register
class Remote(Provider):
    type = "remote"
    title = "Remote widget"
    description = ("JSON from a URL you choose, drawn as any shape. "
                   "The contract is docs/widgets.md.")
    app = EVERYONE           # narrowed per definition by `app` (needs())
    admin_only = True
    shape = "list"           # the class's; each definition chooses (shape_for)
    ttl = 300
    config_schema = {
        "url": {"type": "string", "label": "URL nav-api fetches (GET, returns JSON)", "required": True},
        "shape": {"type": "enum", "label": "Drawn as", "default": "list", "choices": list(SHAPES)},
        "app": {"type": "string", "required": True,
                "label": "Shown to people who can open this app (its slug), or * for everyone"},
        "connection": {"type": "string", "label": "Connection whose key to send (optional)"},
        "ttl": {"type": "integer", "label": "Refresh every (seconds, 15-3600)", "default": 300},
        "per_user": {"type": "bool", "label": "Ask per viewer (sends X-Nav-User; cached per person)",
                     "default": False},
    }

    @classmethod
    def needs(cls, config: dict[str, Any]) -> set[str]:
        try:
            app = remote.clean_app(config.get("app") or "")
        except ValueError:
            return set()          # a bad slug reads nothing: shown to nobody
        return {EVERYONE} if app == "*" else {app}

    @classmethod
    def shape_for(cls, config: dict[str, Any]) -> str:
        return config.get("shape") if config.get("shape") in SHAPES else cls.shape

    @classmethod
    def ttl_for(cls, config: dict[str, Any]) -> int:
        return remote.ttl(config.get("ttl", cls.ttl))

    @classmethod
    def per_user_for(cls, config: dict[str, Any]) -> bool:
        return bool(config.get("per_user"))

    async def fetch(self, config: dict[str, Any], who: str) -> dict[str, Any]:
        url = remote.clean_url(config["url"])
        remote.clean_app(config["app"])
        headers = {"Accept": "application/json",
                   "User-Agent": f"nav-api/{os.environ.get('NAV_VERSION', 'dev')[:7]}",
                   "X-Nav-Shape": self.shape_for(config)}
        if config.get("per_user"):
            headers["X-Nav-User"] = who
        name = (config.get("connection") or "").strip().lower()
        if name:
            if not creds.exists(name):
                raise ValueError(f"no connection {name!r} -- add it in Connections")
            if not creds.key_ok_for(name, url):
                raise ValueError(f"this URL is not under the {name} connection's base URL, "
                                 f"so its key is not sent")
            key = creds.resolve(name)[1]
            if not key:
                raise ValueError(f"connection {name!r} has no key")
            headers.update(creds.headers(name, key))
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            async with client.stream("GET", url, headers=headers) as r:
                buf, over = bytearray(), False
                async for chunk in r.aiter_bytes():
                    buf.extend(chunk)
                    if len(buf) > remote.MAX_BYTES:
                        over = True
                        break
                return remote.body(r.status_code, bytes(buf), over)
