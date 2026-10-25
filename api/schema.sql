-- nav's own state. Everything here is a PREFERENCE; nothing here is access.
--
-- Access lives in Authentik and is enforced by Pomerium. This database only
-- decides how the tiles a user can ALREADY reach are presented to them. If this
-- database is empty, nav still works and shows the right tiles -- that property
-- is worth preserving as the schema grows.

CREATE TABLE IF NOT EXISTS profiles (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner       TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    -- Tile overrides and layout as one document: icon, title, description,
    -- category, colour, hidden, size, position, per app slug. JSONB because the
    -- set of things a tile can override is the part of this roadmap most likely
    -- to keep changing, and a migration per new knob would be the tax.
    settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner, name)
);

-- Which profile a given DEVICE is using. Profiles are central -- that is the
-- requirement: a new device picks or duplicates one that already exists -- but
-- the CHOICE is per device, which is the only thing that legitimately differs
-- between a phone and a desktop.
CREATE TABLE IF NOT EXISTS device_selection (
    owner       TEXT        NOT NULL,
    device_id   TEXT        NOT NULL,   -- opaque, minted by the browser
    profile_id  BIGINT      REFERENCES profiles(id) ON DELETE SET NULL,
    label       TEXT,
    seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, device_id)
);

-- Administrator overrides: the CURRENT instance's defaults, per application.
--
-- THE THREE-LAYER MODEL (settled 2026-09-28)
--   1. Terraform  -> Authentik   the NEW-INSTANCE defaults. the deployment seeds
--                                meta_icon / name / meta_description / group.
--   2. admin_overrides (here)    what this instance actually shows, set in the UI.
--   3. profiles.settings         what one user chose to see instead.
--
--   Resolution is 3 ?? 2 ?? 1, and the UI NEVER writes back to Authentik. That
--   is the point of the split: an earlier design had the admin UI editing
--   Authentik directly, which would have put it in permanent conflict with the
--   Terraform generator over the same field. Seeding once and overriding in a
--   different store means neither has to yield.
--
-- Nothing is copied here at seed time. A row exists only where an admin has
-- deliberately changed something, so an empty table means "Authentik's values,
-- as Terraform set them" -- and deleting a row is how you revert to them.
CREATE TABLE IF NOT EXISTS admin_overrides (
    slug        TEXT PRIMARY KEY,
    -- icon, name, description, category, colour, hidden, ... Same shape as the
    -- per-tile object inside profiles.settings, so one merge function handles
    -- both layers.
    fields      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Instance-wide presentation settings that are not per-application: page title,
-- branding, default colour scheme.
CREATE TABLE IF NOT EXISTS site_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Click counts, for "most popular (me)" and "most popular (everyone)".
--
-- This is the one table that is genuinely SHARED state, and the reason nav
-- needed a database rather than browser storage: one user's clicks change what
-- another user's sort order shows.
CREATE TABLE IF NOT EXISTS app_clicks (
    owner       TEXT        NOT NULL,
    slug        TEXT        NOT NULL,
    clicks      BIGINT      NOT NULL DEFAULT 0,
    last_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, slug)
);

CREATE INDEX IF NOT EXISTS app_clicks_slug ON app_clicks (slug);
CREATE INDEX IF NOT EXISTS profiles_owner  ON profiles (owner);

-- Custom tiles: links to things that are NOT Authentik applications.
--
-- 🔴 THIS IS THE ONE PLACE WHERE A TILE IS NOT DERIVED FROM ACCESS. Read why
-- before adding to it.
--
--   Everywhere else, who is offered a tile comes from the same tiers.yaml entry
--   that decides who may reach the host, so the two cannot disagree. That
--   invariant only holds for things Pomerium actually gates. It has nothing to
--   say about AdGuard on bare metal at 192.0.2.8, or Pomerium's own
--   /.pomerium page, or a link to something off-network -- and
--   a seeding script that derives https://<host>.<domain> cannot express
--   them anyway.
--
--   So a row here is a BOOKMARK, not a grant. `visible_to` decides who is
--   OFFERED the link and nothing else; whatever is at the far end is exactly as
--   reachable as it was before the tile existed. Never treat this column as a
--   control, and never use a custom tile for something Pomerium could gate --
--   that belongs in tiers.yaml, where the tile follows the access decision.
--
-- The row is layer 1 for its slug, standing in for Authentik. admin_overrides
-- and profiles.settings then apply on top exactly as they do for a real
-- application, so one merge handles both kinds of tile.
CREATE TABLE IF NOT EXISTS custom_tiles (
    slug        TEXT PRIMARY KEY,
    url         TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    description TEXT        NOT NULL DEFAULT '',
    category    TEXT        NOT NULL DEFAULT '',
    icon        TEXT        NOT NULL DEFAULT '',
    icon_light  TEXT        NOT NULL DEFAULT '',
    -- Lowercase group names. EMPTY MEANS EVERYONE who can load nav.
    visible_to  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WIDGETS (roadmap #34). A definition is WHAT to show (a provider type plus
-- its config, e.g. a PromQL query); a placement is WHERE (a group, in order).
-- One definition can be placed in several groups.
--
-- Site-wide and admin-written, like admin_overrides. Who SEES a placed widget
-- is not stored anywhere: it is decided per viewer, per request, by the
-- provider's `app` against that viewer's Authentik access (widgets.py). A
-- placement is layout, never a grant.
CREATE TABLE IF NOT EXISTS widget_defs (
    id          SERIAL      PRIMARY KEY,
    type        TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS widget_placements (
    id          SERIAL      PRIMARY KEY,
    def_id      INTEGER     NOT NULL REFERENCES widget_defs(id) ON DELETE CASCADE,
    category    TEXT        NOT NULL,
    ord         INTEGER     NOT NULL DEFAULT 0,
    -- Reserved for resizing (roadmap #34): NULL means the shape's default.
    size        TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS widget_placements_def ON widget_placements (def_id);

-- LAYOUTS (roadmap #34, decided 2026-10-11): templates and personal dashboards.
-- See layouts.py for the model and the cascade. A template has no owner; a
-- dashboard has one, and is a FULL COPY of the template it was made from
-- (`template_id`, kept for "revert to template").
CREATE TABLE IF NOT EXISTS layouts (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         TEXT        NOT NULL CHECK (kind IN ('template', 'dashboard')),
    owner        TEXT,
    name         TEXT        NOT NULL,
    template_id  BIGINT      REFERENCES layouts(id) ON DELETE SET NULL,
    is_default   BOOLEAN     NOT NULL DEFAULT false,
    group_order  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    group_hidden JSONB       NOT NULL DEFAULT '[]'::jsonb,
    updated_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((kind = 'template') = (owner IS NULL)),
    CHECK (kind = 'template' OR NOT is_default)
);
-- Names unique per owner (templates share the NULL owner), case-insensitively:
-- "Family" and "family" side by side in a picker is a bug report.
CREATE UNIQUE INDEX IF NOT EXISTS layouts_name ON layouts (COALESCE(owner, ''), lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS layouts_one_default ON layouts (is_default) WHERE is_default;

-- One row per tile a layout says something about. Same shape as
-- admin_overrides.fields, so one merge() handles every layer.
CREATE TABLE IF NOT EXISTS layout_tiles (
    layout_id   BIGINT      NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    slug        TEXT        NOT NULL,
    fields      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (layout_id, slug)
);

ALTER TABLE widget_placements ADD COLUMN IF NOT EXISTS
    layout_id BIGINT REFERENCES layouts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS widget_placements_layout ON widget_placements (layout_id);
-- NULL = the shared library (admin-written). Otherwise a user's own widget,
-- listed and placeable only by them. Who SEES data is still the provider's
-- `app` gate at fetch time; ownership is about who may edit and place it.
ALTER TABLE widget_defs ADD COLUMN IF NOT EXISTS owner TEXT;
-- Which layout a device shows. NULL: the default template. Replaces
-- profile_id, which nothing ever set (the page never called /api/profiles).
ALTER TABLE device_selection ADD COLUMN IF NOT EXISTS
    layout_id BIGINT REFERENCES layouts(id) ON DELETE SET NULL;

-- ONE-TIME MIGRATION: the layout that existed before templates becomes the
-- default template, "Default". Runs only while there is no template at all,
-- so it is a no-op on every start after the first -- and on a fresh install it
-- simply creates an empty Default.
--
-- 🔴 BACKUP FIRST. admin_overrides loses its layout fields here (they move to
-- the template), so the pre-migration table is kept verbatim as
-- admin_overrides_pre_layouts, with the two site keys. Rolling back to an
-- image older than this is: restore those, then deploy. Drop them once the
-- template UI has been in use for a while.
DO $$
DECLARE
    tpl BIGINT;
BEGIN
    -- Two pods starting at once must not both migrate.
    PERFORM pg_advisory_xact_lock(hashtext('nav-layouts-migration'));
    IF EXISTS (SELECT 1 FROM layouts WHERE kind = 'template') THEN
        RETURN;
    END IF;

    CREATE TABLE IF NOT EXISTS admin_overrides_pre_layouts AS
        SELECT * FROM admin_overrides;
    CREATE TABLE IF NOT EXISTS site_settings_pre_layouts AS
        SELECT * FROM site_settings WHERE key IN ('group_order', 'group_hidden');

    INSERT INTO layouts (kind, name, is_default, group_order, group_hidden, updated_by)
    VALUES ('template', 'Default', true,
            COALESCE((SELECT value FROM site_settings WHERE key = 'group_order'
                      AND jsonb_typeof(value) = 'array'), '[]'::jsonb),
            COALESCE((SELECT value FROM site_settings WHERE key = 'group_hidden'
                      AND jsonb_typeof(value) = 'array'), '[]'::jsonb),
            'migration')
    RETURNING id INTO tpl;

    INSERT INTO layout_tiles (layout_id, slug, fields)
    SELECT tpl, slug, sub.f
    FROM (SELECT slug, (SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
                        FROM jsonb_each(fields)
                        WHERE key IN ('category', 'order', 'size', 'hidden', 'above_fold')) AS f
          FROM admin_overrides) AS sub
    WHERE sub.f <> '{}'::jsonb;

    UPDATE admin_overrides
       SET fields = fields - 'category' - 'order' - 'size' - 'hidden' - 'above_fold';
    DELETE FROM site_settings WHERE key IN ('group_order', 'group_hidden');

    UPDATE widget_placements SET layout_id = tpl WHERE layout_id IS NULL;
END $$;

ALTER TABLE widget_placements ALTER COLUMN layout_id SET NOT NULL;

-- A widget, like a tile, can be hidden (off the page, kept in the layout) or
-- above the fold (still shown when its group is collapsed). 2026-10-25.
ALTER TABLE widget_placements ADD COLUMN IF NOT EXISTS hidden     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE widget_placements ADD COLUMN IF NOT EXISTS above_fold BOOLEAN NOT NULL DEFAULT false;
-- A library widget's AUDIENCE: Authentik groups (lower-cased) who see its data
-- without its app, or '*' for everyone signed in -- the family seeing what is
-- coming up without a Sonarr login. Admin-set, per definition; NULL or empty
-- means the provider's app gate alone (widgets.py). Ignored on personal widgets.
ALTER TABLE widget_defs ADD COLUMN IF NOT EXISTS audience TEXT[];
-- Where each upstream app lives and its API key (creds.py). `secret` is
-- Fernet ciphertext under NAV_SECRET_KEY, which is NOT in this database; `hint`
-- is the key's last four characters, to tell two keys apart. NULL url /
-- public_url fall back to env vars, then defaults.
CREATE TABLE IF NOT EXISTS app_connections (
    slug        TEXT PRIMARY KEY,
    url         TEXT,
    public_url  TEXT,
    secret      TEXT,
    hint        TEXT,
    updated_by  TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Custom connections (creds.py), for remote widgets: an admin-named slug with
-- its own label and auth style. Built-ins have custom = false and take label
-- and auth from creds.APPS.
ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS auth TEXT;
ALTER TABLE app_connections ADD COLUMN IF NOT EXISTS custom BOOLEAN NOT NULL DEFAULT false;

-- A layout's mode (layouts.py MODES): packed groups, or free placement at
-- explicit cells. And a widget's cell on a free layout. 2026-10-25.
ALTER TABLE layouts ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'packed'
    CHECK (mode IN ('packed', 'free'));
ALTER TABLE widget_placements ADD COLUMN IF NOT EXISTS x INTEGER;
ALTER TABLE widget_placements ADD COLUMN IF NOT EXISTS y INTEGER;

-- A free layout's groups (layouts.py clean_free_groups), as one list.
ALTER TABLE layouts ADD COLUMN IF NOT EXISTS free_groups JSONB NOT NULL DEFAULT '[]'::jsonb;

-- A layout's own look: {"bg": {c?, img?}} (layouts.py clean_bg).
ALTER TABLE layouts ADD COLUMN IF NOT EXISTS style JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Uploaded background images (images.py): named by the SHA-256 of their
-- bytes, so one picture is one row and its URL never changes.
CREATE TABLE IF NOT EXISTS images (
    sha        TEXT        PRIMARY KEY,
    owner      TEXT        NOT NULL,
    mime       TEXT        NOT NULL,
    bytes      INTEGER     NOT NULL,
    data       BYTEA       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS images_owner ON images (owner);
