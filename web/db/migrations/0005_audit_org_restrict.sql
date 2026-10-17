-- ORYN 0005 — organizations with an audit history cannot be deleted.
--
-- audit_events.org_id previously used ON DELETE SET NULL, which would rewrite
-- audit rows (blocked by the append-only trigger with an opaque error).
-- Organizations are archived (archived_at), never deleted; make that explicit.

alter table audit_events drop constraint audit_events_org_id_fkey;
alter table audit_events
  add constraint audit_events_org_id_fkey foreign key (org_id) references organizations (id) on delete restrict;
