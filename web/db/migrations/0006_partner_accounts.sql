-- ORYN 0006 — administrator-provisioned partner accounts.
--
--  * Username sign-in (Better Auth username plugin; columns as printed by
--    scripts/oryn/print-auth-schema.ts). Usernames are stored normalized to
--    lower case; "displayUsername" keeps the casing the administrator chose.
--  * account_controls: account state Better Auth does not model — disabled,
--    must change password, trial-only. It lives outside auth_user so no
--    Better Auth endpoint can change it, and only platform operations
--    (app.system) can write it. A missing row means "no restrictions".
--  * Trial organizations: synthetic workspaces that trial-only accounts are
--    confined to. Enforced here with triggers and again in the application's
--    access resolver (src/server/authz/access.ts).

alter table "auth_user" add column "username" text;
alter table "auth_user" add column "displayUsername" text;
create unique index "auth_user_username_uidx" on "auth_user" ("username");
alter table "auth_user" add constraint auth_user_username_format
  check ("username" is null or "username" ~ '^[a-z0-9_.]{3,30}$');

create table account_controls (
  user_id text primary key references "auth_user" ("id") on delete cascade,
  -- Set when an administrator issues a password (new account or reset). The
  -- account cannot open any non-trial organization until it is changed.
  must_change_password boolean not null default false,
  -- Confined to trial organizations (synthetic data only).
  trial_only boolean not null default false,
  disabled_at timestamptz,
  disabled_reason text check (char_length(disabled_reason) <= 300),
  disabled_by text,
  password_changed_at timestamptz,
  provisioned_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger account_controls_touch before update on account_controls for each row execute function touch_updated_at();

alter table account_controls enable row level security;
create policy account_controls_select on account_controls for select using (app_is_system() or user_id = app_current_user());
create policy account_controls_insert on account_controls for insert with check (app_is_system());
create policy account_controls_update on account_controls for update using (app_is_system()) with check (app_is_system());
create policy account_controls_delete on account_controls for delete using (app_is_system());

-- Checked before Better Auth creates a session (no tenant context exists yet).
create function auth_account_disabled(p_user_id text) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$ select exists (select 1 from account_controls where user_id = p_user_id and disabled_at is not null) $$;

-- ── Trial organizations ──────────────────────────────────────

alter table organizations add column is_trial boolean not null default false;
-- A trial workspace holds sample data only, never a real customer's.
alter table organizations add constraint organizations_trial_is_synthetic check (not is_trial or is_synthetic);

-- SQLSTATE OR001 is mapped to a user-facing message by src/server/errors.ts.
create function enforce_trial_membership() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  begin
    if exists (select 1 from account_controls c where c.user_id = new.user_id and c.trial_only)
       and not exists (select 1 from organizations o where o.id = new.org_id and o.is_trial) then
      raise exception 'Trial-only accounts can only be members of trial organizations.' using errcode = 'OR001';
    end if;
    return new;
  end
  $$;
create trigger memberships_trial_guard before insert or update of user_id, org_id on memberships
  for each row execute function enforce_trial_membership();

create function enforce_trial_only_flag() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  begin
    if new.trial_only then
      if exists (select 1 from memberships m join organizations o on o.id = m.org_id
                  where m.user_id = new.user_id and not o.is_trial) then
        raise exception 'This account belongs to a non-trial organization; remove that membership before making it trial-only.' using errcode = 'OR001';
      end if;
      if exists (select 1 from platform_admins p where p.user_id = new.user_id) then
        raise exception 'Platform administrators cannot be trial-only accounts.' using errcode = 'OR001';
      end if;
    end if;
    return new;
  end
  $$;
create trigger account_controls_trial_guard before insert or update of trial_only on account_controls
  for each row execute function enforce_trial_only_flag();

create function enforce_trial_org_flag() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  begin
    if old.is_trial and not new.is_trial and exists (
      select 1 from memberships m join account_controls c on c.user_id = m.user_id
       where m.org_id = new.id and c.trial_only) then
      raise exception 'Trial-only accounts are members of this organization; remove them before it stops being a trial organization.' using errcode = 'OR001';
    end if;
    return new;
  end
  $$;
create trigger organizations_trial_guard before update of is_trial on organizations
  for each row execute function enforce_trial_org_flag();

create function enforce_admin_not_trial() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  begin
    if exists (select 1 from account_controls c where c.user_id = new.user_id and c.trial_only) then
      raise exception 'Trial-only accounts cannot be platform administrators.' using errcode = 'OR001';
    end if;
    return new;
  end
  $$;
create trigger platform_admins_trial_guard before insert on platform_admins
  for each row execute function enforce_admin_not_trial();
