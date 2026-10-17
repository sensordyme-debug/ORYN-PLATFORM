-- ORYN 0007 — operational state for production: cross-process provider
-- request spacing, worker heartbeats, honest sync-run outcomes, and
-- readiness access to the migration ledger.

-- ── Provider request slots ───────────────────────────────────
-- Some public APIs limit request rates per client address (GDELT: one request
-- every 5 seconds). An in-process limiter cannot coordinate several worker
-- processes or the web service, so request slots are reserved here, on the
-- database clock. After a rate-limit response the provider is put in a
-- cooldown that every process honours.
create table provider_request_slots (
  provider_id text primary key,
  next_at timestamptz not null default now(),
  cooldown_until timestamptz,
  cooldown_reason text,
  updated_at timestamptz not null default now()
);

-- ── Worker heartbeats ────────────────────────────────────────
-- Each worker process records that it is alive; readiness checks and the
-- processing page report the most recent one. Not tenant data.
create table worker_heartbeats (
  worker_id text primary key,
  hostname text not null,
  pid integer not null,
  version text not null,
  scheduler boolean not null,
  concurrency integer not null,
  in_flight integer not null default 0,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index worker_heartbeats_seen on worker_heartbeats (last_seen_at desc);

-- ── Sync runs: a provider that was not called is "skipped", not "succeeded" ──
alter table provider_sync_runs drop constraint provider_sync_runs_status_check;
alter table provider_sync_runs add constraint provider_sync_runs_status_check
  check (status in ('running', 'succeeded', 'failed', 'partial', 'skipped'));

-- ── Readiness: the application role may read (not change) applied migrations ──
grant select on schema_migrations to oryn_app_role;
