"""Access: who is in which Authentik group, staged as a Terraform pull request.

Some labs keep Authentik group MEMBERSHIP in Terraform (`users = [...]` on each
`authentik_group`), so a membership edit made in Authentik is undone by the
next apply. This module reads those lists from the GitOps repo, edits them,
and opens a pull request; a person reviews, merges and applies. Nothing here
writes to Authentik.

Pure functions (parse, edit, describe) are separate from the GitHub client so
they can be tested without a network.

  NAV_GITOPS_REPO     owner/name of the repo (unset: the Access panel is off)
  NAV_GITOPS_TOKEN    a token that may push branches and open PRs there
  NAV_GITOPS_BASE     the branch to read and to target (default main)
  NAV_GITOPS_TF_DIR   the directory of Authentik .tf files (default terraform/authentik)
"""
from __future__ import annotations

import base64
import os
import re
import time
from typing import Any


REPO = os.environ.get("NAV_GITOPS_REPO", "").strip()
TOKEN = os.environ.get("NAV_GITOPS_TOKEN", "").strip()
BASE = os.environ.get("NAV_GITOPS_BASE", "main").strip() or "main"
TF_DIR = os.environ.get("NAV_GITOPS_TF_DIR", "terraform/authentik").strip().strip("/")

BLOCK = re.compile(r'^resource "authentik_group" "([^"]+)" \{\n(.*?)^\}', re.M | re.S)
NAME = re.compile(r'^\s*name\s*=\s*"([^"]+)"', re.M)
USERS = re.compile(r'^(\s*)users(\s*)=(\s*)\[(.*?)\]', re.M | re.S)


def enabled() -> bool:
    return bool(REPO and TOKEN)


# --- Terraform: read and edit membership -------------------------------------

def members(body: str) -> list[int] | None:
    """The user pks in a group block's `users = [...]`; None when it has none
    (membership is not managed in Terraform for that group)."""
    u = USERS.search(body)
    if not u:
        return None
    return [int(x) for x in re.findall(r"\b(\d+)\b", re.sub(r"#.*", "", u.group(4)))]


def groups(files: dict[str, str]) -> dict[str, dict[str, Any]]:
    """Authentik group name -> {path, resource, members (None: not managed here)}."""
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(files):
        for m in BLOCK.finditer(files[path]):
            n = NAME.search(m.group(2))
            if n:
                out[n.group(1)] = {"path": path, "resource": m.group(1), "members": members(m.group(2))}
    return out


def _add(body: str, pk: int, name: str) -> str:
    u = USERS.search(body)
    inner = u.group(4)
    if "\n" in inner:
        # One "N, # who" per line: add a line in the same style.
        ind = re.search(r"\n([ \t]*)\d", inner)
        ind = ind.group(1) if ind else u.group(1) + "  "
        head, tail = inner.rstrip(), inner[len(inner.rstrip()):]
        new = head + f"\n{ind}{pk}, # {name}" + tail
    else:
        items = [x.strip() for x in inner.split(",") if x.strip()]
        new = ", ".join(items + [str(pk)])
    return body[: u.start(4)] + new + body[u.end(4):]


def _remove(body: str, pk: int) -> str:
    u = USERS.search(body)
    inner = u.group(4)
    if "\n" in inner:
        # Drop the line that holds this pk (with its comment).
        new = re.sub(rf"\n[ \t]*{pk}\b[^\n]*", "", inner, count=1)
    else:
        items = [x.strip() for x in inner.split(",") if x.strip() and x.strip() != str(pk)]
        new = ", ".join(items)
    return body[: u.start(4)] + new + body[u.end(4):]


def edit(files: dict[str, str], changes: list[dict[str, Any]]) -> dict[str, str]:
    """Apply membership changes ({group, pk, name, action: add|remove}) and return
    only the files that changed. Raises ValueError on a group that isn't
    membership-managed in Terraform, or when re-reading disagrees with the edit."""
    known = groups(files)
    texts = dict(files)
    for c in changes:
        g = known.get(c["group"])
        if g is None:
            raise ValueError(f"no Terraform group named {c['group']!r}")
        if g["members"] is None:
            raise ValueError(f"{c['group']}: membership isn't in Terraform (no users = [...])")
        text = texts[g["path"]]
        m = next(b for b in BLOCK.finditer(text) if b.group(1) == g["resource"])
        cur = members(m.group(2)) or []
        if c["action"] == "add" and c["pk"] not in cur:
            body = _add(m.group(2), c["pk"], c.get("name") or str(c["pk"]))
        elif c["action"] == "remove" and c["pk"] in cur:
            body = _remove(m.group(2), c["pk"])
        else:
            continue
        texts[g["path"]] = text[: m.start(2)] + body + text[m.end(2):]
    # Check by re-reading, not by trusting the edit.
    after = groups(texts)
    for c in changes:
        have = c["pk"] in (after[c["group"]]["members"] or [])
        if have != (c["action"] == "add"):
            raise ValueError(f"{c['group']}: user {c['pk']} is {'not ' if not have else ''}a member after editing")
    return {p: t for p, t in texts.items() if t != files[p]}


def describe(changes: list[dict[str, Any]], gains: dict[int, list[str]], losses: dict[int, list[str]]) -> str:
    """The pull request body: who changes, and the apps they gain or lose."""
    by: dict[int, dict[str, Any]] = {}
    for c in changes:
        p = by.setdefault(c["pk"], {"name": c.get("name") or str(c["pk"]), "add": [], "remove": []})
        p[c["action"]].append(c["group"])
    lines = ["Group membership changes staged in nav's Access panel.", ""]
    for pk, p in by.items():
        bits = ([f"joins {', '.join(p['add'])}"] if p["add"] else []) + \
               ([f"leaves {', '.join(p['remove'])}"] if p["remove"] else [])
        apps = ([f"gains {', '.join(gains[pk])}"] if gains.get(pk) else []) + \
               ([f"loses {', '.join(losses[pk])}"] if losses.get(pk) else [])
        lines.append(f"- **{p['name']}** ({pk}): {'; '.join(bits)}" + (f". Apps: {'; '.join(apps)}" if apps else ""))
    lines += ["", f"Takes effect after `terraform plan` / `apply` in `{TF_DIR}`.",
              "App lists are computed from Authentik's group bindings; direct user bindings aren't counted."]
    return "\n".join(lines)


# --- GitHub ------------------------------------------------------------------

def _client():
    import httpx   # here, so the pure half imports with the standard library alone (tests)
    return httpx.AsyncClient(base_url="https://api.github.com", timeout=20, headers={
        "Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"})


async def read_tf() -> dict[str, str]:
    """The .tf files under TF_DIR on BASE: {path: text}."""
    async with _client() as gh:
        r = await gh.get(f"/repos/{REPO}/contents/{TF_DIR}", params={"ref": BASE})
        r.raise_for_status()
        out = {}
        for f in r.json():
            if f.get("type") == "file" and f["name"].endswith(".tf"):
                b = await gh.get(f"/repos/{REPO}/contents/{f['path']}", params={"ref": BASE})
                b.raise_for_status()
                out[f["path"]] = base64.b64decode(b.json()["content"]).decode()
        return out


async def open_pr(files: dict[str, str], title: str, body: str, who: str) -> str:
    """One branch, one commit with every changed file, one PR against BASE. Returns its URL."""
    branch = f"nav-access-{time.strftime('%Y%m%d-%H%M%S')}"
    async with _client() as gh:
        ref = await gh.get(f"/repos/{REPO}/git/ref/heads/{BASE}")
        ref.raise_for_status()
        head = ref.json()["object"]["sha"]
        commit = await gh.get(f"/repos/{REPO}/git/commits/{head}")
        commit.raise_for_status()
        tree = []
        for path, text in files.items():
            blob = await gh.post(f"/repos/{REPO}/git/blobs", json={"content": text, "encoding": "utf-8"})
            blob.raise_for_status()
            tree.append({"path": path, "mode": "100644", "type": "blob", "sha": blob.json()["sha"]})
        t = await gh.post(f"/repos/{REPO}/git/trees", json={"base_tree": commit.json()["tree"]["sha"], "tree": tree})
        t.raise_for_status()
        c = await gh.post(f"/repos/{REPO}/git/commits", json={
            "message": f"{title}\n\nStaged in nav by {who}.", "tree": t.json()["sha"], "parents": [head]})
        c.raise_for_status()
        b = await gh.post(f"/repos/{REPO}/git/refs", json={"ref": f"refs/heads/{branch}", "sha": c.json()["sha"]})
        b.raise_for_status()
        pr = await gh.post(f"/repos/{REPO}/pulls", json={"title": title, "head": branch, "base": BASE, "body": body})
        pr.raise_for_status()
        return pr.json()["html_url"]
