"""Uploaded background images: what is accepted, and how it is named.

STANDARD LIBRARY ONLY (CI runs these tests without pip); the routes are in
app.py. An image is stored once, named by the SHA-256 of its bytes, so the
same picture uploaded twice is one row and its URL never changes -- which is
what lets it be cached for a year.

Only raster formats, recognised by their bytes, never by the declared type:
an SVG is a document that can carry script, and a file that SAYS it is a PNG
is not thereby one. The page shrinks a picture before sending it, so the cap
is generous for a background and small for a database row.
"""
from __future__ import annotations

import hashlib
import re

MAX_BYTES = 3 * 1024 * 1024
PER_OWNER_COUNT = 200
PER_OWNER_BYTES = 100 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{64}$")
URL = re.compile(r"^api/images/[0-9a-f]{64}$")


def sniff(data: bytes) -> str | None:
    """The image type its first bytes say it is, or None."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def name(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check(data: bytes) -> str:
    """The MIME type to store, or ValueError saying why not."""
    if not data:
        raise ValueError("an empty upload")
    if len(data) > MAX_BYTES:
        raise ValueError(f"an image is at most {MAX_BYTES // (1024 * 1024)} MB -- the page shrinks "
                         f"pictures before sending; this one came unshrunk")
    mime = sniff(data)
    if mime is None:
        raise ValueError("a JPEG, PNG, WebP or GIF image only")
    return mime
