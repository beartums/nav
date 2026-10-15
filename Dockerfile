# nav: the API and the page in one image, so they always match.
#
# Kept deliberately boring: a slim base, pinned requirements, no compiler in the
# final image (psycopg[binary] ships wheels), non-root.
#
# NOT digest-pinned yet, deliberately rather than by omission: pinning needs a
# digest that has actually been pulled and verified, and inventing one produces
# a build failure that reads like a registry problem. Pin it after the first
# successful build:
#     docker buildx imagetools inspect python:3.13-slim | head -2
FROM python:3.14-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/*.py api/schema.sql ./
RUN rm -f test_*.py
COPY ui/ ./ui/

# Build identity, surfaced by /api/version and the About dialog.
#
# Passed in rather than derived: nothing inside the image can know the commit
# it was built from, and a version the app guesses is worse than none.
ARG NAV_VERSION=unknown
ARG NAV_BUILT_AT=unknown
ENV NAV_VERSION=$NAV_VERSION \
    NAV_BUILT_AT=$NAV_BUILT_AT
# The page reports its version from this file; it is the image's.
RUN printf '{"page": "%s"}\n' "$NAV_VERSION" > ui/static/version.json

# uid 1000 to match the rest of the estate's non-root apps.
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin nav
USER 1000

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--no-server-header"]
