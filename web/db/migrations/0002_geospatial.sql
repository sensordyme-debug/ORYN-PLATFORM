-- ORYN 0002 — areas of interest, provider state, source assets, analytic models.

create type aoi_kind as enum (
  'field', 'farm', 'municipal_boundary', 'construction_site', 'watershed',
  'road_corridor', 'public_asset', 'infrastructure_project', 'region', 'other'
);
create type aoi_status as enum ('active', 'archived');

create table aois (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  parent_id uuid references aois (id) on delete set null,
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '' check (char_length(description) <= 4000),
  kind aoi_kind not null,
  status aoi_status not null default 'active',
  -- Analysis geometry (always areal). Points and lines are buffered on input.
  geom geometry(MultiPolygon, 4326) not null,
  -- The shape as the user drew, uploaded, or imported it.
  input_geom geometry(Geometry, 4326),
  input_buffer_m double precision check (input_buffer_m is null or input_buffer_m > 0),
  area_m2 double precision not null default 0,
  label_point geometry(Point, 4326),
  -- Where the boundary came from: {method, provider, external_id, retrieved_at, license, note}
  boundary_source jsonb not null,
  -- True when the boundary is a development placeholder, not a customer's real boundary.
  is_synthetic boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  monitoring_enabled boolean not null default true,
  monitoring_interval_hours integer not null default 24 check (monitoring_interval_hours between 1 and 8760),
  next_check_at timestamptz,
  last_checked_at timestamptz,
  data_sources text[] not null default '{}',
  enabled_analytics text[] not null default '{}',
  max_cloud_cover numeric(5, 2) not null default 40 check (max_cloud_cover between 0 and 100),
  news_terms text[] not null default '{}',
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index aois_geom_gix on aois using gist (geom);
create index aois_org_status on aois (org_id, status, created_at desc);
create index aois_parent on aois (parent_id);
create index aois_due on aois (next_check_at) where status = 'active' and monitoring_enabled;
select enable_tenant_rls('aois');

create function aois_derive() returns trigger
  language plpgsql
  as $$
  begin
    if not ST_IsValid(new.geom) then
      raise exception 'AOI geometry is invalid: %', ST_IsValidReason(new.geom) using errcode = '22023';
    end if;
    if ST_IsEmpty(new.geom) then
      raise exception 'AOI geometry is empty' using errcode = '22023';
    end if;
    new.area_m2 := ST_Area(new.geom::geography);
    new.label_point := ST_PointOnSurface(new.geom);
    new.updated_at := now();
    return new;
  end
  $$;
create trigger aois_derive before insert or update of geom on aois for each row execute function aois_derive();
create trigger aois_touch before update on aois for each row execute function touch_updated_at();

-- Geographic access restriction for members with aoi_restricted = true.
create table aoi_grants (
  org_id uuid not null references organizations (id) on delete cascade,
  membership_id uuid not null references memberships (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  granted_by text,
  granted_at timestamptz not null default now(),
  primary key (membership_id, aoi_id)
);
select enable_tenant_rls('aoi_grants');

-- ── Providers ────────────────────────────────────────────────
-- Static provider metadata (endpoints, licensing, capabilities) is defined in
-- code (src/server/providers/registry.ts). This table holds runtime health.

create table provider_status (
  provider_id text primary key,
  status text not null default 'unknown'
    check (status in ('healthy', 'degraded', 'unavailable', 'unconfigured', 'disabled', 'unknown')),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  request_count_24h integer not null default 0,
  quota jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table provider_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  org_id uuid references organizations (id) on delete cascade,
  aoi_id uuid references aois (id) on delete cascade,
  product text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  items_found integer not null default 0,
  items_new integer not null default 0,
  error text,
  details jsonb not null default '{}'::jsonb
);
create index provider_sync_runs_provider on provider_sync_runs (provider_id, started_at desc);
create index provider_sync_runs_aoi on provider_sync_runs (aoi_id, started_at desc);
select enable_tenant_rls('provider_sync_runs');

-- ── Source assets ────────────────────────────────────────────
-- Catalog metadata for public or licensed source data. Not tenant-owned:
-- it describes a provider's product, not a customer's interest. Which assets
-- matter to which AOI is tenant data (aoi_assets).

create table source_assets (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  collection text not null,
  external_id text not null,
  kind text not null check (kind in ('optical', 'sar', 'landcover', 'elevation', 'other')),
  platform text,
  instruments text[] not null default '{}',
  -- Sensor acquisition time (start), and end for products spanning a period.
  acquired_at timestamptz not null,
  acquired_end_at timestamptz,
  -- When the provider published or last updated the item.
  provider_published_at timestamptz,
  -- When ORYN first and most recently saw the item in the catalog.
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  footprint geometry(Geometry, 4326) not null,
  cloud_cover numeric(6, 3),
  gsd_m numeric(8, 2),
  epsg integer,
  -- Grid identifier (e.g. MGRS tile, WRS-2 path/row). Same grid + EPSG means
  -- pixel-aligned products, so per-pixel comparison needs no resampling.
  grid_code text,
  processing_level text,
  processing_baseline text,
  properties jsonb not null default '{}'::jsonb,
  assets jsonb not null default '{}'::jsonb,
  license text,
  license_url text,
  attribution text,
  stac_url text,
  metadata_hash text not null,
  unique (provider_id, collection, external_id)
);
create index source_assets_footprint_gix on source_assets using gist (footprint);
create index source_assets_collection_time on source_assets (collection, acquired_at desc);

create table aoi_assets (
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  asset_id uuid not null references source_assets (id) on delete cascade,
  discovered_at timestamptz not null default now(),
  coverage_fraction double precision not null check (coverage_fraction between 0 and 1.000001),
  status text not null default 'discovered'
    check (status in ('discovered', 'queued', 'processed', 'unusable', 'failed', 'skipped')),
  status_reason text,
  updated_at timestamptz not null default now(),
  primary key (aoi_id, asset_id)
);
create index aoi_assets_org on aoi_assets (org_id, discovered_at desc);
select enable_tenant_rls('aoi_assets');
create trigger aoi_assets_touch before update on aoi_assets for each row execute function touch_updated_at();

-- ── Analytic model registry ──────────────────────────────────
-- Mirrors src/server/analytics/registry.ts so every stored result can be
-- joined to the exact model version, contract, and documented limitations.

create table analytic_models (
  id text not null,
  version text not null,
  name text not null,
  result_class text not null check (result_class in (
    'raw_observation', 'deterministic_calculation', 'model_prediction', 'candidate_change', 'rule_evaluation')),
  description text not null,
  input_contract jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  limitations text[] not null default '{}',
  registered_at timestamptz not null default now(),
  primary key (id, version)
);
