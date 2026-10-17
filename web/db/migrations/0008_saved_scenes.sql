-- Saved map scenes: a named view of the map workspace — extent, projection,
-- basemap and overlays, selected area, displayed date and index, and change
-- filters. A scene stores view state only. Restoring it never grants access:
-- every record is fetched again through the normal permission-checked APIs,
-- and an area the viewer cannot see is dropped from the restored view.
--
-- Additive: earlier code ignores this table; rolling images back is safe.

create table saved_scenes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  -- 'org': every member of the organization; 'private': only its author.
  visibility text not null default 'org' check (visibility in ('private', 'org')),
  -- Validated by the application (src/server/scenes/service.ts); bounded here as a backstop.
  state jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 8192),
  created_by text references "auth_user" ("id") on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_scenes_org on saved_scenes (org_id, created_at desc);
create trigger saved_scenes_touch before update on saved_scenes for each row execute function touch_updated_at();

select enable_tenant_rls('saved_scenes');
-- Private scenes are visible to (and changeable by) their author only. A
-- restrictive policy combines with the tenant policy: both must pass.
create policy saved_scenes_private on saved_scenes as restrictive for all
  using (app_is_system() or visibility = 'org' or created_by = app_current_user())
  with check (app_is_system() or visibility = 'org' or created_by = app_current_user());
