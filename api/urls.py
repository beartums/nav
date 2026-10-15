"""Validation for things nav puts in front of a user: launch URLs and slugs.

Deliberately dependency-free so it can be tested without installing FastAPI
and psycopg. app.py is the only importer.
"""

import re


def launchable(url: str | None) -> bool:
    """Can a browser actually navigate to this?

    Authentik's way of saying "this application has no launch page" is the
    sentinel `blank://blank`, and terraform/authentik/pomerium.tf sets it on
    purpose: authenticate.example.com is not a destination a person
    visits. nav reimplements the application listing rather than using
    Authentik's own library, so it has to honour that convention itself --
    and it did not. `"blank://blank"` is a non-empty string, so the old
    `if not url` guard passed it straight through and Pomerium rendered as a
    tile that did nothing when clicked.

    Checked by scheme rather than by matching `blank:`, which costs nothing
    and also keeps `javascript:` out of an href. That field is admin-set, so
    it is not much of a vector, but it lands in the DOM unescaped.
    """
    if not url:
        return False
    u = url.strip()
    if not u:
        return False
    # Root-relative and protocol-relative are both navigable.
    if u.startswith("/"):
        return True
    return u.lower().startswith(("http://", "https://"))


# A slug is a primary key, an icon filename (`icons/<slug>.svg`) and part of a
# URL path. Must start AND end alphanumeric: a trailing hyphen is legal in a
# URL and harmless, but it makes two slugs that differ only by it look
# identical in the table, and the editor's own derivation strips them anyway.
#
# This guards custom tiles only -- Authentik's slugs arrive already made and
# are never checked here -- so tightening it cannot reject an existing app.
_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def valid_slug(slug: str | None) -> bool:
    return bool(slug and _SLUG.match(slug))


def offered_to(visible_to: list[str] | None, groups: set[str], who: str = "") -> bool:
    """Is a custom tile offered to this person?

    🔴 PRESENTATION ONLY. This decides whether the LINK IS SHOWN. It is not a
    gate: whatever is at the far end is exactly as reachable either way, and a
    custom tile points at things Pomerium does not sit in front of. Never cite
    this function as the reason something is protected.

    Entries are `group:<name>` or `user:<email>`. A bare string is a group --
    that is what the column held before users could be picked, and rewriting
    old rows to add a prefix would be a migration for no behaviour change.

    An empty list means everyone who can load nav. Selecting several is OR:
    being in ANY listed group, or being a listed user, is enough.
    """
    if not visible_to:
        return True
    who = (who or "").strip().lower()
    for raw in visible_to:
        entry = str(raw).strip().lower()
        if not entry:
            continue
        if entry.startswith("user:"):
            if who and entry[5:] == who:
                return True
        elif entry.removeprefix("group:") in groups:
            return True
    return False


def pick_account(results: list[dict]) -> tuple[int | None, str | None]:
    """Choose the one Authentik account an email identifies.

    Returns (pk, error). Exactly one of them is ever set; (None, None) means
    the email matched nothing, which is a normal "this person has no account"
    and not an error.

    🔴 AN AMBIGUOUS EMAIL IS REFUSED, NOT GUESSED. Authentik does not enforce
    unique emails, and its built-in `akadmin` was found carrying
    owner@example.com -- the same address as the real `owner`
    account. The old code took `results[0]`, which sorted to akadmin, whose
    only application is `pomerium` (launch URL `blank://blank`, correctly
    dropped). owner's dashboard therefore rendered EMPTY, with nothing
    logged and nothing raised: it read as "Authentik grants this person
    nothing" for as long as it stood, and surfaced only because group
    impersonation happened to pick that member first.

    nav identifies people by the email Pomerium puts in the header, so when
    two accounts share one there is no correct guess to make. Saying so beats
    a blank page that blames the wrong system.
    """
    if not results:
        return None, None
    if len(results) > 1:
        names = ", ".join(sorted(str(u.get("username")) for u in results))
        return None, (
            f"{len(results)} Authentik accounts share this email ({names}). nav "
            f"identifies people by the email Pomerium puts in the header, so it "
            f"cannot tell which account is meant. Give each account its own "
            f"address -- the usual culprit is the built-in admin.")
    return results[0].get("pk"), None


def group_can_see(bindings: list[dict], groups, engine_mode: str = "any"):
    """Would a user whose ONLY groups are `groups` reach this application?

    `groups` is a name or a collection of names. Several are OR'd, which is
    what a real membership means: being in any one of them is enough under
    policy_engine_mode=any.

    Returns True, False, or None for "cannot be determined" — and the caller
    must surface None rather than rounding it to either answer.

    WHY THIS IS COMPUTED RATHER THAN SAMPLED
      Authentik answers `for_user` and has no `for_group`, so the first
      version of impersonation showed one real member's view. That is almost
      always the wrong answer to the question being asked: real people are in
      several groups at once, so "view as family" rendered everything evan
      could reach, which is the opposite of what you wanted to check.

      A hypothetical member of exactly one group is not a real account, so it
      has to be evaluated here. That is only safe because this estate's
      bindings are plain group and user bindings — access.tf says so ("groups
      are the whole mechanism, no expression policies") and a live audit
      confirmed it: 39 group bindings, 1 user binding, no policy bindings, no
      negations, every application on policy_engine_mode=any.

      🔴 THAT IS AN ASSUMPTION WITH AN EXPIRY DATE. The moment an expression
      policy is bound to an application, evaluating it here would mean
      reimplementing Authentik's policy engine. So anything this function
      cannot read exactly returns None, and the UI says which applications it
      could not judge instead of quietly dropping or including them.

    A USER BINDING NEVER MATCHES. A hypothetical group-only user is nobody in
    particular, so a binding naming a specific person does not grant it — that
    is the correct answer, and it is why mom's direct audiobookshelf binding
    does not show up under "view as family".
    """
    live = [b for b in bindings if b.get("enabled", True)]
    if not live:
        # Authentik's default: an application with no bindings is reachable by
        # every authenticated user. Six were closed in 2026-09 for exactly
        # this, so it is a real state and not a theoretical one.
        return True
    if any(b.get("policy") for b in live):
        return None
    if any(b.get("negate") for b in live):
        return None

    if isinstance(groups, str):
        groups = [groups]
    want = {g.strip().lower() for g in groups if g and g.strip()}
    if not want:
        return False

    def matches(b):
        name = (b.get("group_obj") or {}).get("name")
        return bool(name) and name.strip().lower() in want

    if engine_mode == "all":
        return all(matches(b) for b in live)
    return any(matches(b) for b in live)
