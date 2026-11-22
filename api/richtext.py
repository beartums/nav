"""Rich text for text blocks: what an admin's formatting may contain.

The page's text-block editor produces HTML (contenteditable). It is cleaned
HERE, on save, against an allowlist -- tags, attributes and the few style
properties formatting needs -- so what is stored, and later drawn with
innerHTML for every viewer, can't carry script, event handlers or a
javascript: link. The page cleans again before drawing (belt and braces).

Standard library only (html.parser), like widgets.py.
"""
from __future__ import annotations

import re
from html import escape
from html.parser import HTMLParser

MAX_LEN = 50_000

TAGS = {"p", "br", "div", "span", "h1", "h2", "h3", "h4", "b", "strong", "i", "em", "u", "s",
        "strike", "sub", "sup", "ul", "ol", "li", "a", "img", "blockquote", "hr", "pre", "code"}
VOID = {"br", "img", "hr"}
# Dropped WITH their content: what's inside is not text anyone meant to show.
DROP = {"script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math"}
ATTRS = {"a": {"href", "title"}, "img": {"src", "alt", "width", "height"}, "*": {"style"},
         "ol": {"start"}}

COLOUR = r"(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*){2,3}\)|[a-zA-Z]{3,20})"
STYLE = {
    "color": re.compile(rf"^{COLOUR}$"),
    "background-color": re.compile(rf"^{COLOUR}$"),
    "font-size": re.compile(r"^(\d{1,3}(\.\d+)?(px|em|rem|%)|x-small|small|medium|large|x-large|xx-large|xxx-large)$"),
    "font-weight": re.compile(r"^(normal|bold|bolder|lighter|[1-9]00)$"),
    "font-style": re.compile(r"^(normal|italic)$"),
    "text-decoration": re.compile(r"^(none|underline|line-through|underline line-through)$"),
    "text-decoration-line": re.compile(r"^(none|underline|line-through|underline line-through)$"),
    "text-align": re.compile(r"^(left|center|right|justify)$"),
    "font-family": re.compile(r"^[\w\s,\"'-]{1,120}$"),
    "line-height": re.compile(r"^\d{1,2}(\.\d+)?(px|em|%)?$"),
    "margin-left": re.compile(r"^\d{1,3}px$"),
    "padding-left": re.compile(r"^\d{1,3}px$"),
}
LINK = re.compile(r"^(https?://|mailto:|/\?dashboard=(\d+|default)$)", re.I)
DASHBOARD = re.compile(r"^/\?dashboard=(\d+|default)$")
IMAGE = re.compile(r"^(https://|api/images/[0-9a-f]{64}$)")


def _style(v: str) -> str:
    out = []
    for decl in v.split(";"):
        if ":" not in decl:
            continue
        k, val = (x.strip() for x in decl.split(":", 1))
        k = k.lower()
        if k in STYLE and STYLE[k].match(val) and "url(" not in val.lower():
            out.append(f"{k}: {val}")
    return "; ".join(out)


class _Cleaner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.open: list[str] = []
        self.drop = 0

    def handle_starttag(self, tag, attrs):
        if tag in DROP:
            if tag not in VOID:
                self.drop += 1
            return
        if self.drop or tag not in TAGS:
            return
        allowed = ATTRS.get(tag, set()) | ATTRS["*"]
        kept = []
        for k, v in attrs:
            v = v or ""
            if k not in allowed:
                continue
            if k == "href" and not LINK.match(v.strip()):
                continue
            if k == "src" and not IMAGE.match(v.strip()):
                continue
            if k == "style":
                v = _style(v)
                if not v:
                    continue
            if k in ("width", "height", "start") and not re.match(r"^\d{1,4}$", v):
                continue
            kept.append(f' {k}="{escape(v.strip())}"')
        if tag == "img" and not any(a.startswith(" src=") for a in kept):
            return
        if tag == "a" and not any(DASHBOARD.match(v or "") for k, v in attrs if k == "href"):
            kept.append(' target="_blank" rel="noopener noreferrer"')
        self.out.append(f"<{tag}{''.join(kept)}>")
        if tag not in VOID:
            self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in self.open and tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in DROP:
            self.drop = max(0, self.drop - 1)
            return
        if self.drop or tag not in self.open:
            return
        # Close anything left open inside it, so the output always nests.
        while self.open:
            t = self.open.pop()
            self.out.append(f"</{t}>")
            if t == tag:
                break

    def handle_data(self, data):
        if not self.drop:
            self.out.append(escape(data, quote=False))


def clean(html: str) -> str:
    """The allowlisted version of `html`. Raises ValueError when too long."""
    if len(html) > MAX_LEN:
        raise ValueError(f"a text block is at most {MAX_LEN} characters of formatting")
    c = _Cleaner()
    c.feed(html)
    c.close()
    while c.open:
        c.out.append(f"</{c.open.pop()}>")
    return "".join(c.out)
