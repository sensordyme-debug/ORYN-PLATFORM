-- ORYN 0003 — job queue, processing runs, observations, detections, notes.

-- ── Job queue ────────────────────────────────────────────────
-- PostgreSQL-backed queue claimed with FOR UPDATE SKIP LOCKED.
--   * idempotency_key deduplicates enqueues (same work is never queued twice)
--   * failed attempts back off exponentially until max_attempts, then 'dead'
--   * running jobs heartbeat; a job whose heartbeat exceeds its timeout is
--     reclaimed and counted as a failed attempt (never silently dropped)

create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  -- Null for platform-level jobs (e.g. provider health checks).
  org_id uuid references organizations (id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  status job_status not null default 'queued',
  priority smallint not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  run_after timestamptz not null default now(),
  timeout_seconds integer not null default 900 check (timeout_seconds between 5 and 86400),
  idempotency_key text,
  locked_by text,
  locked_at timestamptz,
  heartbeat_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  last_error text,
  errors jsonb not null default '[]'::jsonb,
  result jsonb,
  cancel_requested boolean not null default false,
  parent_job_id uuid references jobs (id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create unique index jobs_idempotency on jobs (idempotency_key) where idempotency_key is not null;
create index jobs_claimable on jobs (priority, run_after) where status = 'queued';
create index jobs_running on jobs (heartbeat_at) where status = 'running';
create index jobs_org_time on jobs (org_id, created_at desc);
create index jobs_type_status on jobs (type, status);
create trigger jobs_touch before update on jobs for each row execute function touch_updated_at();
select enable_tenant_rls('jobs');

-- ── Processing runs ──────────────────────────────────────────
-- One row per execution of an analytic against an AOI. Preserved forever
-- (subject to retention) so results can be reproduced and explained.

create table processing_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  job_id uuid references jobs (id) on delete set null,
  model_id text not null,
  model_version text not null,
  attempt integer not null default 1,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'insufficient_data', 'skipped')),
  input_asset_ids uuid[] not null default '{}',
  baseline_asset_ids uuid[] not null default '{}',
  parameters jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  outputs jsonb not null default '{}'::jsonb,
  messages text[] not null default '{}',
  error text,
  software_version text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (model_id, model_version) references analytic_models (id, version)
);
create index processing_runs_aoi on processing_runs (aoi_id, started_at desc);
create index processing_runs_job on processing_runs (job_id);
select enable_tenant_rls('processing_runs');

-- ── Observations ─────────────────────────────────────────────
-- A measurement derived from one source asset over one AOI by one model
-- version. Unique per (aoi, asset, model, version): re-running the same
-- version is idempotent; a new version writes a new row and marks the old
-- one not current, preserving history.

create table observations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  run_id uuid not null references processing_runs (id) on delete cascade,
  asset_id uuid not null references source_assets (id),
  model_id text not null,
  model_version text not null,
  kind text not null,
  result_class text not null check (result_class in (
    'raw_observation', 'deterministic_calculation', 'model_prediction', 'candidate_change', 'rule_evaluation')),
  -- Acquisition time of the underlying source data.
  observed_at timestamptz not null,
  processed_at timestamptz not null default now(),
  status text not null check (status in ('valid', 'unusable')),
  metrics jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  -- Rendered/derived raster: storage keys, grid, footprint corners, legend.
  raster jsonb,
  limitations text[] not null default '{}',
  is_current boolean not null default true,
  superseded_by uuid references observations (id) on delete set null,
  unique (aoi_id, asset_id, model_id, model_version),
  foreign key (model_id, model_version) references analytic_models (id, version)
);
create index observations_series on observations (aoi_id, kind, observed_at desc) where is_current;
create index observations_run on observations (run_id);
select enable_tenant_rls('observations');

-- ── Detections (intelligence objects) ────────────────────────
-- Candidate changes, model predictions, and reported events tied to a
-- geometry. Never "verified" until a person verifies them.

create table detections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  type text not null,
  result_class text not null check (result_class in (
    'raw_observation', 'deterministic_calculation', 'model_prediction', 'candidate_change', 'rule_evaluation')),
  title text not null,
  geom geometry(Geometry, 4326) not null,
  area_m2 double precision,
  baseline_observation_id uuid references observations (id) on delete set null,
  comparison_observation_id uuid references observations (id) on delete set null,
  baseline_observed_at timestamptz,
  comparison_observed_at timestamptz,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  source_asset_ids uuid[] not null default '{}',
  run_id uuid references processing_runs (id) on delete set null,
  model_id text,
  model_version text,
  metrics jsonb not null default '{}'::jsonb,
  thresholds jsonb not null default '{}'::jsonb,
  evidence_grade text not null check (evidence_grade in ('strong', 'moderate', 'weak', 'insufficient')),
  evidence_reasons text[] not null default '{}',
  limitations text[] not null default '{}',
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'needs_field_check', 'confirmed', 'dismissed')),
  verification_note text,
  verified_by text references "auth_user" ("id") on delete set null,
  verified_at timestamptz,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index detections_geom_gix on detections using gist (geom);
create index detections_aoi_time on detections (aoi_id, comparison_observed_at desc);
create index detections_org_status on detections (org_id, verification_status, created_at desc);
create trigger detections_touch before update on detections for each row execute function touch_updated_at();
select enable_tenant_rls('detections');

-- ── Analyst notes ────────────────────────────────────────────

create table notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  target_type text not null check (target_type in ('aoi', 'detection', 'alert', 'observation', 'report')),
  target_id uuid not null,
  author_id text references "auth_user" ("id") on delete set null,
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index notes_target on notes (org_id, target_type, target_id, created_at);
select enable_tenant_rls('notes');
