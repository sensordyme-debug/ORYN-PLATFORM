-- Season comparisons: compare one area across two user-selected, seasonally
-- matched periods (e.g. September 2025 and September 2026) with Sentinel-2
-- L2A NDVI, and keep every step reviewable.
--
-- A comparison records the two windows, the image chosen in each (and every
-- image considered, with why it was or was not used), the method version, and
-- an explicit outcome — including the cases where nothing can be compared.
-- Candidate changes it finds are ordinary detections (review, notes, exports)
-- linked back through detections.comparison_id; they never trigger alerts.
-- The change_evidence report type renders one comparison as a PDF.
--
-- Additive: earlier code ignores the new table and column; rolling images
-- back is safe (a change_evidence report row would fail its earlier check
-- only if inserted by the old code, which cannot create one).

create table comparisons (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  -- Only Sentinel-2 L2A for now: sensors are never mixed within a comparison.
  product_id text not null check (product_id in ('earth-search:sentinel-2-l2a')),
  collection text not null check (collection in ('sentinel-2-l2a')),
  baseline_from date not null,
  baseline_to date not null,
  comparison_from date not null,
  comparison_to date not null,
  check (baseline_from <= baseline_to and comparison_from <= comparison_to and baseline_to < comparison_from),
  status text not null default 'queued' check (status in ('queued', 'searching', 'processing', 'comparing', 'done', 'failed')),
  -- Set when status = 'done'; see src/server/comparisons/outcomes.ts.
  outcome text check (outcome in (
    'changes_found', 'no_change_above_threshold', 'no_imagery_baseline', 'no_imagery_comparison',
    'cloud_cover_baseline', 'cloud_cover_comparison', 'incompatible_tiles', 'insufficient_overlap', 'not_configured')),
  outcome_detail text,
  baseline_observation_id uuid references observations (id) on delete set null,
  comparison_observation_id uuid references observations (id) on delete set null,
  -- Images considered per window and the reason each was or was not chosen.
  selection jsonb not null default '{}'::jsonb,
  -- Method, thresholds, overlap, counts and the stored ΔNDVI preview.
  result jsonb,
  run_id uuid references processing_runs (id) on delete set null,
  error text,
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index comparisons_aoi on comparisons (org_id, aoi_id, created_at desc);
create trigger comparisons_touch before update on comparisons for each row execute function touch_updated_at();
select enable_tenant_rls('comparisons');

alter table detections add column comparison_id uuid references comparisons (id) on delete cascade;
create index detections_comparison on detections (comparison_id) where comparison_id is not null;

alter table reports drop constraint reports_report_type_check;
alter table reports add constraint reports_report_type_check check (report_type in (
  'field', 'aoi', 'change', 'weather', 'municipal', 'disaster', 'audit', 'processing', 'change_evidence'));
