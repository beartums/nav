"""VictoriaMetrics reply handling for the vm.* widget providers.

Pure functions, standard library only -- the HTTP call lives in providers.py.
Separated so the parts with real edge cases (NaN, empty results, too many
series, step sizing) are tested in CI without a VictoriaMetrics to talk to.
"""
from __future__ import annotations

import math
import re
from typing import Any

RANGES = {"1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400}

# A timeseries draws at most this many lines: the categorical palette has eight
# validated hues and a ninth is never generated (dataviz rule). Past that, the
# query should aggregate -- say so rather than drawing an unreadable tangle.
MAX_SERIES = 8


def step_for(range_s: int, points: int) -> int:
    """Seconds between samples for ~`points` points. Never below 15 s, the
    scrape interval -- finer than that is interpolation, not data."""
    return max(15, range_s // max(points, 1))


def number(raw: Any) -> float | None:
    """A Prometheus sample value is a STRING, and may be NaN or ±Inf."""
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def result(reply: dict[str, Any], want: str) -> list[dict[str, Any]]:
    """The `result` list, or a ValueError that says what VictoriaMetrics said."""
    if reply.get("status") != "success":
        raise ValueError(f"VictoriaMetrics: {reply.get('error') or reply.get('status')}")
    data = reply.get("data") or {}
    if data.get("resultType") != want:
        raise ValueError(f"expected a {want}, got {data.get('resultType')!r} -- "
                         f"is the query a {'range' if want == 'matrix' else 'instant'} query?")
    return data.get("result") or []


TEMPLATE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def fill(text: str, metric: dict[str, str]) -> str:
    """`{{label}}` -> that label's value on this series; a missing label is
    empty rather than left as braces, which would read as a bug."""
    return TEMPLATE.sub(lambda m: metric.get(m.group(1), ""), text or "").strip()


def series_name(metric: dict[str, str], legend: str = "") -> str:
    """`legend` is a template ("{{instance}} ({{job}})"), or the older form, a
    comma list of label keys ("job,instance"); otherwise every label but
    __name__, which is the same on every line."""
    if legend and TEMPLATE.search(legend):
        return fill(legend, metric) or metric.get("__name__", "") or "value"
    keys = [k.strip() for k in legend.split(",") if k.strip()] if legend else \
        sorted(k for k in metric if k != "__name__")
    parts = [metric.get(k, "") for k in keys if metric.get(k)]
    return ", ".join(parts) or metric.get("__name__", "") or "value"


def single(rows: list[dict[str, Any]], what: str) -> dict[str, Any] | None:
    """Exactly one series, or none. Several is a query problem, named as one."""
    if len(rows) > 1:
        raise ValueError(f"{what} returned {len(rows)} series; a stat needs one -- "
                         f"aggregate it, e.g. sum(...) or max(...)")
    return rows[0] if rows else None


def level(value: float | None, warn: float | None, crit: float | None,
          higher_is: str = "bad") -> str | None:
    """ok / warn / crit against optional thresholds. None when there are none,
    so the renderer shows no status at all rather than a meaningless 'ok'."""
    if value is None or (warn is None and crit is None):
        return None
    worse = (lambda a, b: a >= b) if higher_is == "bad" else (lambda a, b: a <= b)
    if crit is not None and worse(value, crit):
        return "crit"
    if warn is not None and worse(value, warn):
        return "warn"
    return "ok"


def points(values: list[list[Any]]) -> list[list[float | None]]:
    """[[ts, "str"], ...] -> [[ts, float|None], ...]; gaps stay gaps."""
    return [[float(t), number(v)] for t, v in values]


def label_summary(rows: list[dict[str, Any]], cap: int = 10) -> dict[str, dict[str, Any]]:
    """What the designer offers to name lines by: each label the query
    returned, its distinct values (first `cap`), and how many there are.
    __name__ is left out -- it is the same everywhere a name would matter."""
    vals: dict[str, set[str]] = {}
    for r in rows:
        for k, v in (r.get("metric") or {}).items():
            if k != "__name__":
                vals.setdefault(k, set()).add(v)
    return {k: {"values": sorted(v)[:cap], "count": len(v)} for k, v in sorted(vals.items())}


def worst_level(series_points: list[list[list[float | None]]], warn: float | None,
                crit: float | None, higher_is: str = "bad") -> str | None:
    """The worst status across lines, each judged by its LATEST value -- a
    chart is "critical" when something on it is critical now, not when it
    once was. None when there are no thresholds or no data."""
    rank = {"ok": 0, "warn": 1, "crit": 2}
    worst = None
    for pts in series_points:
        last = next((v for _, v in reversed(pts) if v is not None), None)
        lv = level(last, warn, crit, higher_is)
        if lv is not None and (worst is None or rank[lv] > rank[worst]):
            worst = lv
    return worst

