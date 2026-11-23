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
  NAV_GITOPS_CF_FILE  the .tf file holding the edge's email allow-list (a Cloudflare
                      Access policy whose `include` lists `email = { email = "..." }`
                      entries); unset: adding someone from outside the household
                      domain is left to a person, and the panel says where
  NAV_GITOPS_CF_POLICY  that policy's Terraform resource name in the file

Outside access is the same idea as membership: a person whose address isn't
the household's own domain must be named on the edge's allow-list, which lives
in Terraform. The entry is copied from an existing one with only the address
swapped, then the file is re-read to check exactly that address was added.
"""
from __future__ import annotations

import asyncio
import base64
import os
import re
import time
from typing import Any


REPO = os.environ.get("NAV_GITOPS_REPO", "").strip()
TOKEN = os.environ.get("NAV_GITOPS_TOKEN", "").strip()
BASE = os.environ.get("NAV_GITOPS_BASE", "main").strip() or "main"
TF_DIR = os.environ.get("NAV_GITOPS_TF_DIR", "terraform/authentik").strip().strip("/")
CF_FILE = os.environ.get("NAV_GITOPS_CF_FILE", "").strip().strip("/")
CF_POLICY = os.environ.get("NAV_GITOPS_CF_POLICY", "").strip()

BLOCK = re.compile(r'^resource "authentik_group" "([^"]+)" \{\n(.*?)^\}', re.M | re.S)
NAME = re.compile(r'^\s*name\s*=\s*"([^"]+)"', re.M)
USERS = re.compile(r'^(\s*)users(\s*)=(\s*)\[(.*?)\]', re.M | re.S)


def enabled() -> bool:
    return bool(REPO and TOKEN)


def cf_enabled() -> bool:
    return bool(enabled() and CF_FILE and CF_POLICY)


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


# --- Terraform: the edge's email allow-list ------------------------------------

def _policy_re(resource: str) -> re.Pattern[str]:
    return re.compile(rf'^resource "cloudflare_zero_trust_access_policy" "{re.escape(resource)}" \{{\n.*?^\}}',
                      re.M | re.S)


# One `include` entry: "    {" ... "    }," with an `email = { email = "..." }` inside.
_CF_ENTRY = re.compile(r'^(?P<ind>[ \t]*)\{\n(?:(?!^(?P=ind)\},).)*?email = \{\n\s*email = "[^"]+"\n.*?^(?P=ind)\},\n',
                       re.M | re.S)
_CF_EMAIL = re.compile(r'email = \{\n\s*email = "([^"]+)"')


def cf_emails(text: str, resource: str | None = None) -> list[str] | None:
    """The addresses on the policy; None when the file has no such policy."""
    m = _policy_re(resource or CF_POLICY).search(text)
    return _CF_EMAIL.findall(m.group(0)) if m else None


def cf_add(text: str, email: str, resource: str | None = None) -> str:
    """The file with `email` added to the policy (unchanged when it's already
    there). ValueError when the policy is missing, has no email entry to copy,
    or re-reading the result disagrees."""
    resource = resource or CF_POLICY
    pr = _policy_re(resource)
    pm = pr.search(text)
    if not pm:
        raise ValueError(f'no cloudflare_zero_trust_access_policy "{resource}" in {CF_FILE or "the file"}')
    policy = pm.group(0)
    have = _CF_EMAIL.findall(policy)
    if email.lower() in (e.lower() for e in have):
        return text
    em = _CF_ENTRY.search(policy)
    if not em:
        raise ValueError(f"{resource}: no email entry to copy -- add the first address by hand")
    entry = _CF_EMAIL.sub(lambda m: m.group(0).replace(f'"{m.group(1)}"', '"' + email.replace('"', "") + '"'),
                          em.group(0), count=1)
    out = text[:pm.start()] + policy[:em.end()] + entry + policy[em.end():] + text[pm.end():]
    after = cf_emails(out, resource)
    if sorted(after or []) != sorted(have + [email]):
        raise ValueError(f"{resource}: editing the allow-list did not add exactly {email}")
    return out


def edit_all(files: dict[str, str], changes: list[dict[str, Any]],
             emails: list[dict[str, Any]] | None = None) -> dict[str, str]:
    """Membership changes, then outside-access addresses: the changed files."""
    changed = edit(files, changes) if changes else {}
    if emails:
        if not CF_FILE or CF_FILE not in files:
            raise ValueError("outside access is staged but NAV_GITOPS_CF_FILE isn't read")
        text = changed.get(CF_FILE, files[CF_FILE])
        for e in emails:
            text = cf_add(text, e["email"])
        if text != files[CF_FILE]:
            changed[CF_FILE] = text
    return changed


def describe(changes: list[dict[str, Any]], gains: dict[int, list[str]], losses: dict[int, list[str]],
             emails: list[dict[str, Any]] | None = None) -> str:
    """The pull request body: who changes, the apps they gain or lose, and any
    address added to the edge's allow-list."""
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
    for e in emails or []:
        lines.append(f"- **{e.get('name') or e['email']}**: outside access for `{e['email']}` ({CF_POLICY} in `{CF_FILE}`)")
    where = f"`{TF_DIR}`" + (f" and `{CF_FILE.rsplit('/', 1)[0]}`" if emails else "")
    lines += ["", f"Takes effect after `terraform plan` / `apply` in {where}.",
              "App lists are computed from Authentik's group bindings; direct user bindings aren't counted."]
    return "\n".join(lines)


# --- GitHub ------------------------------------------------------------------

def _client():
    import httpx   # here, so the pure half imports with the standard library alone (tests)
    return httpx.AsyncClient(base_url="https://api.github.com", timeout=20, headers={
        "Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"})


# The files as of one commit of BASE: re-read only when BASE moves.
_TF_CACHE: dict[str, Any] = {"sha": None, "files": None}


async def read_tf() -> dict[str, str]:
    """The .tf files under TF_DIR on BASE: {path: text}. One request to see
    whether BASE moved; the files themselves only when it did, in parallel."""
    async with _client() as gh:
        ref = await gh.get(f"/repos/{REPO}/commits/{BASE}", headers={"Accept": "application/vnd.github.sha"})
        ref.raise_for_status()
        sha = ref.text.strip()
        if sha == _TF_CACHE["sha"] and _TF_CACHE["files"] is not None:
            return dict(_TF_CACHE["files"])
        r = await gh.get(f"/repos/{REPO}/contents/{TF_DIR}", params={"ref": sha})
        r.raise_for_status()
        paths = [f["path"] for f in r.json() if f.get("type") == "file" and f["name"].endswith(".tf")]
        if CF_FILE and CF_POLICY and CF_FILE not in paths:
            paths.append(CF_FILE)

        async def one(path: str) -> tuple[str, str]:
            b = await gh.get(f"/repos/{REPO}/contents/{path}", params={"ref": sha})
            b.raise_for_status()
            return path, base64.b64decode(b.json()["content"]).decode()

        out = dict(await asyncio.gather(*(one(p) for p in paths)))
    _TF_CACHE.update(sha=sha, files=out)
    return dict(out)


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
