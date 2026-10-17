-- ORYN 0004 — alerting, weather and event context, reference layers,
-- uploads, reports, and exports.

-- ── Alerting ─────────────────────────────────────────────────

create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  -- Null applies the rule to every active AOI in the organization.
  aoi_id uuid references aois (id) on delete cascade,
  rule_type text not null,
  params jsonb not null default '{}'::jsonb,
  severity text not null check (severity in ('info', 'low', 'moderate', 'high', 'critical')),
  enabled boolean not null default true,
  notify_in_app boolean not null default true,
  notify_email boolean not null default false,
  notify_roles org_role[] not null default '{org_admin,analyst}',
  -- Suppress repeat alerts for the same rule + AOI within this window.
  cooldown_hours integer not null default 24 check (cooldown_hours between 0 and 8760),
  escalate_after_hours integer check (escalate_after_hours is null or escalate_after_hours between 1 and 8760),
  escalate_to_roles org_role[] not null default '{org_admin}',
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index alert_rules_org on alert_rules (org_id, enabled);
create trigger alert_rules_touch before update on alert_rules for each row execute function touch_updated_at();
select enable_tenant_rls('alert_rules');

create table alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  rule_id uuid references alert_rules (id) on delete set null,
  aoi_id uuid not null references aois (id) on delete cascade,
  detection_id uuid references detections (id) on delete set null,
  observation_id uuid references observations (id) on delete set null,
  severity text not null check (severity in ('info', 'low', 'moderate', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'suppressed')),
  title text not null,
  -- {what, where, why, evidence:[{type,id,label}], certainty, suggested_action, limitations}
  explanation jsonb not null,
  geom geometry(Geometry, 4326),
  -- Distinct clocks: the real-world event (if known), the data acquisition,
  -- ORYN ingestion, ORYN processing, alert creation, and notification.
  event_at timestamptz,
  observed_at timestamptz,
  ingested_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  -- True when the alert came from reprocessing data that was already known.
  from_reprocessing boolean not null default false,
  dedupe_key text not null,
  assigned_to text references "auth_user" ("id") on delete set null,
  acknowledged_by text references "auth_user" ("id") on delete set null,
  acknowledged_at timestamptz,
  resolved_by text references "auth_user" ("id") on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  escalation_level integer not null default 0,
  escalated_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index alerts_org_status on alerts (org_id, status, created_at desc);
create index alerts_aoi on alerts (aoi_id, created_at desc);
create index alerts_rule_aoi on alerts (rule_id, aoi_id, created_at desc);
create trigger alerts_touch before update on alerts for each row execute function touch_updated_at();
select enable_tenant_rls('alerts');

create table alert_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  alert_id uuid not null references alerts (id) on delete cascade,
  actor_user_id text references "auth_user" ("id") on delete set null,
  action text not null,
  from_status text,
  to_status text,
  note text,
  created_at timestamptz not null default now()
);
create index alert_events_alert on alert_events (alert_id, created_at);
select enable_tenant_rls('alert_events');

create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id text not null references "auth_user" ("id") on delete cascade,
  alert_id uuid not null references alerts (id) on delete cascade,
  channel text not null check (channel in ('in_app', 'email')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  status_reason text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz,
  unique (alert_id, user_id, channel)
);
create index notifications_user on notifications (user_id, created_at desc) where channel = 'in_app';
select enable_tenant_rls('notifications');

-- ── Weather ──────────────────────────────────────────────────
-- record_kind keeps observed conditions, forecasts, and model estimates
-- (e.g. reanalysis) strictly separate. Warnings are external_events.

create table weather_records (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  provider_id text not null,
  record_kind text not null check (record_kind in ('observation', 'forecast', 'model_estimate')),
  variable text not null,
  value double precision,
  unit text not null,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  issued_at timestamptz,
  retrieved_at timestamptz not null default now(),
  station_id text,
  station_distance_km double precision,
  source_url text,
  unique (aoi_id, provider_id, record_kind, variable, valid_from, valid_to)
);
create index weather_records_series on weather_records (aoi_id, variable, valid_from desc);
select enable_tenant_rls('weather_records');

-- ── External events (official warnings, news reports) ────────
-- A news report is evidence that a source made a claim, not proof the event
-- happened; claim_status records how far it has been substantiated.

create table external_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  provider_id text not null,
  event_kind text not null check (event_kind in ('weather_warning', 'news_report')),
  external_id text not null,
  title text not null,
  description text,
  severity text,
  certainty text,
  urgency text,
  category text,
  geom geometry(Geometry, 4326),
  event_start timestamptz,
  event_end timestamptz,
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  source_url text,
  claim_status text not null default 'reported'
    check (claim_status in ('reported', 'official_warning', 'corroborated', 'verified', 'disputed')),
  details jsonb not null default '{}'::jsonb,
  unique (aoi_id, provider_id, external_id)
);
create index external_events_aoi on external_events (aoi_id, published_at desc);
select enable_tenant_rls('external_events');

-- Public news metadata (not tenant-owned). title_fingerprint groups copies
-- of the same story so syndication is not mistaken for corroboration.
create table news_articles (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  url text not null,
  canonical_url text not null unique,
  title text not null,
  domain text,
  language text,
  source_country text,
  published_at timestamptz,
  retrieved_at timestamptz not null default now(),
  title_fingerprint text not null
);
create index news_articles_fingerprint on news_articles (title_fingerprint);

create table aoi_news_matches (
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  article_id uuid not null references news_articles (id) on delete cascade,
  matched_terms text[] not null,
  location_match text not null check (location_match in ('place_in_title', 'term_in_title', 'query_only')),
  category text not null,
  story_key text not null,
  created_at timestamptz not null default now(),
  primary key (aoi_id, article_id)
);
create index aoi_news_matches_story on aoi_news_matches (aoi_id, story_key);
select enable_tenant_rls('aoi_news_matches');

-- ── Reference layers ─────────────────────────────────────────

create table reference_layers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid references aois (id) on delete cascade,
  name text not null,
  kind text not null check (kind in (
    'boundary', 'roads', 'buildings', 'infrastructure', 'permits', 'parcels', 'hydrology', 'land_use', 'custom')),
  -- {provider, method, query, url, retrieved_at, upload_id}
  source jsonb not null,
  license text,
  attribution text,
  -- Terms governing redistribution of the underlying data.
  redistribution text,
  feature_count integer not null default 0,
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now()
);
select enable_tenant_rls('reference_layers');

create table reference_features (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  layer_id uuid not null references reference_layers (id) on delete cascade,
  external_id text not null,
  geom geometry(Geometry, 4326) not null,
  properties jsonb not null default '{}'::jsonb,
  unique (layer_id, external_id)
);
create index reference_features_geom_gix on reference_features using gist (geom);
select enable_tenant_rls('reference_features');

-- ── Uploads ──────────────────────────────────────────────────

create table uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  storage_key text,
  status text not null check (status in ('received', 'validated', 'rejected', 'imported')),
  validation_errors text[] not null default '{}',
  result jsonb not null default '{}'::jsonb,
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now()
);
select enable_tenant_rls('uploads');

-- ── Reports and exports ──────────────────────────────────────

create table reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid references aois (id) on delete set null,
  report_type text not null check (report_type in (
    'field', 'aoi', 'change', 'weather', 'municipal', 'disaster', 'audit', 'processing')),
  title text not null,
  status text not null default 'queued' check (status in ('queued', 'generating', 'ready', 'failed')),
  params jsonb not null default '{}'::jsonb,
  -- Frozen snapshot of the evidence the report was built from.
  content jsonb,
  summary_method text,
  pdf_storage_key text,
  pdf_size_bytes bigint,
  error text,
  job_id uuid references jobs (id) on delete set null,
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index reports_org on reports (org_id, created_at desc);
select enable_tenant_rls('reports');

create table exports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  export_type text not null check (export_type in ('geojson', 'csv', 'pdf', 'geotiff', 'png')),
  subject text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed', 'expired')),
  storage_key text,
  filename text,
  content_type text,
  size_bytes bigint,
  license_notes text[] not null default '{}',
  error text,
  job_id uuid references jobs (id) on delete set null,
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz,
  download_count integer not null default 0,
  last_downloaded_at timestamptz
);
create index exports_org on exports (org_id, created_at desc);
select enable_tenant_rls('exports');
