-- Field agronomy inputs for the crop water balance (FAO-56 single crop
-- coefficient, src/lib/fao56.ts and src/server/agronomy/). Values a person supplies about a field
-- — crop, planting date, soil, rooting depth — and the irrigation they
-- applied. They are never invented: a missing value makes the water balance
-- report which input it lacks instead of assuming one.
--
-- One record per area for the current season (the planting date names it).
-- Irrigation events are field records, entered by a member who may write
-- notes, and kept with who entered them.
--
-- Additive: earlier code ignores both tables.

create table field_agronomy (
  aoi_id uuid primary key references aois (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  -- An id from src/server/agronomy/fao56.ts CROP_PROFILES.
  crop text check (crop is null or crop ~ '^[a-z0-9_]{2,40}$'),
  planting_date date,
  -- Optional override of the FAO-56 Table 11 stage lengths (days).
  stage_days jsonb check (stage_days is null or jsonb_typeof(stage_days) = 'object'),
  -- Either a texture class (FAO-56 Table 19) or a measured/surveyed value.
  soil_texture text check (soil_texture is null or soil_texture ~ '^[a-z_]{3,30}$'),
  available_water_mm_per_m double precision check (available_water_mm_per_m is null or available_water_mm_per_m between 20 and 300),
  -- Overrides the FAO-56 Table 22 rooting-depth range.
  root_depth_m double precision check (root_depth_m is null or root_depth_m between 0.1 and 3),
  notes text not null default '' check (char_length(notes) <= 2000),
  updated_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index field_agronomy_org on field_agronomy (org_id);
create trigger field_agronomy_touch before update on field_agronomy for each row execute function touch_updated_at();
select enable_tenant_rls('field_agronomy');

create table irrigation_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  aoi_id uuid not null references aois (id) on delete cascade,
  applied_on date not null,
  -- Net depth reaching the root zone, as the person reports it.
  amount_mm double precision not null check (amount_mm > 0 and amount_mm <= 300),
  note text not null default '' check (char_length(note) <= 500),
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now()
);
create index irrigation_events_aoi on irrigation_events (aoi_id, applied_on);
select enable_tenant_rls('irrigation_events');
