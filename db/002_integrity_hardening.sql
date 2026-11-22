-- 002_integrity_hardening.sql
-- Applied once by api/src/db.js (tracked in schema_migrations).
-- Adds: reference tables (domain normalization), DB-level validation,
-- temporal exclusion constraint, append-only audit history, derived-value views,
-- a hierarchy trigger, a security audit table and supporting indexes.

CREATE EXTENSION IF NOT EXISTS btree_gist;

------------------------------------------------------------------------------
-- 1. Reference (lookup) tables: move enumerated domains out of CHECK strings
--    so they are normalized, documented, joinable and carry behaviour
--    (e.g. is_terminal) that the application previously hard-coded.
------------------------------------------------------------------------------
CREATE TABLE task_statuses(
  code        text PRIMARY KEY,
  label       text NOT NULL,
  is_terminal boolean NOT NULL,
  sort_order  smallint NOT NULL UNIQUE
);
INSERT INTO task_statuses(code,label,is_terminal,sort_order) VALUES
  ('planned','Planned',false,1),
  ('in_progress','In progress',false,2),
  ('postponed','Postponed',false,3),
  ('completed','Completed',true,4),
  ('abandoned','Abandoned',true,5);

CREATE TABLE task_event_types(
  code        text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO task_event_types(code,description) VALUES
  ('created','Task row created'),
  ('status_changed','Task status changed by the owner'),
  ('focus_started','A focus session was started on the task'),
  ('focus_pause','Focus session paused'),
  ('focus_resume','Focus session resumed'),
  ('focus_finish','Focus session finished');

CREATE TABLE activity_categories(
  code        text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL
);
INSERT INTO activity_categories(code,label,description) VALUES
  ('study','Study','Domains the user labelled as study or coursework'),
  ('necessary','Necessary','Domains the user labelled as necessary tools or admin'),
  ('leisure','Leisure','Domains the user labelled as leisure'),
  ('uncategorized','Uncategorized','No label chosen by the user');

ALTER TABLE tasks         DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks         ADD  CONSTRAINT tasks_status_fk
  FOREIGN KEY(status) REFERENCES task_statuses(code);
ALTER TABLE task_events   ADD  CONSTRAINT task_events_old_status_fk
  FOREIGN KEY(old_status) REFERENCES task_statuses(code);
ALTER TABLE task_events   ADD  CONSTRAINT task_events_new_status_fk
  FOREIGN KEY(new_status) REFERENCES task_statuses(code);
ALTER TABLE task_events   ADD  CONSTRAINT task_events_type_fk
  FOREIGN KEY(event_type) REFERENCES task_event_types(code);
ALTER TABLE outbox_events ADD  CONSTRAINT outbox_events_type_fk
  FOREIGN KEY(event_type) REFERENCES task_event_types(code);

------------------------------------------------------------------------------
-- 2. Declarative validation at the database boundary (defence in depth: the
--    API validates first, but direct SQL writes can no longer store junk).
------------------------------------------------------------------------------
ALTER TABLE users ADD CONSTRAINT users_email_shape
  CHECK(email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length(email)<=254);
ALTER TABLE users ADD CONSTRAINT users_display_name_valid
  CHECK(length(btrim(display_name)) BETWEEN 1 AND 160);
ALTER TABLE users ADD CONSTRAINT users_timezone_present
  CHECK(length(btrim(timezone))>0);

ALTER TABLE projects ADD CONSTRAINT projects_name_valid
  CHECK(length(btrim(name)) BETWEEN 1 AND 160);

ALTER TABLE tasks ADD CONSTRAINT tasks_title_valid
  CHECK(length(btrim(title)) BETWEEN 1 AND 160);
ALTER TABLE tasks ADD CONSTRAINT tasks_estimate_range
  CHECK(estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 480);
ALTER TABLE tasks ADD CONSTRAINT tasks_version_positive
  CHECK(version>=1);
ALTER TABLE tasks ADD CONSTRAINT tasks_completion_consistent
  CHECK((status='completed')=(completed_at IS NOT NULL));
ALTER TABLE tasks ADD CONSTRAINT tasks_timestamps_ordered
  CHECK((first_started_at IS NULL OR first_started_at>=created_at)
    AND (completed_at IS NULL OR completed_at>=created_at));

ALTER TABLE task_checkpoints ADD CONSTRAINT checkpoints_note_valid
  CHECK(length(btrim(resume_note)) BETWEEN 1 AND 2000);
ALTER TABLE checkins ADD CONSTRAINT checkins_note_length
  CHECK(note IS NULL OR length(note)<=1000);
ALTER TABLE daily_plans ADD CONSTRAINT plans_revision_positive
  CHECK(revision>=1);
ALTER TABLE plan_tasks ADD CONSTRAINT plan_tasks_position_valid
  CHECK(position>=0);
ALTER TABLE focus_sessions ADD CONSTRAINT focus_end_matches_status
  CHECK((status='finished')=(ended_at IS NOT NULL));

ALTER TABLE devices ADD CONSTRAINT devices_label_valid
  CHECK(length(btrim(label)) BETWEEN 1 AND 160);
ALTER TABLE devices ADD CONSTRAINT devices_epoch_valid
  CHECK(consent_epoch>=0);
ALTER TABLE devices ADD CONSTRAINT devices_revoked_not_tracking
  CHECK(NOT(tracking_enabled AND revoked_at IS NOT NULL));
ALTER TABLE consent_events ADD CONSTRAINT consent_epoch_valid
  CHECK(epoch>=1);
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_expiry_ordered
  CHECK(expires_at>created_at);

------------------------------------------------------------------------------
-- 3. Temporal integrity: a user can never have two overlapping work segments.
--    EXCLUDE USING gist generalizes a unique constraint to range overlap.
--    clock_timestamp() (not now()) keeps boundaries monotonic under the
--    per-user lock even when a request's transaction began earlier.
------------------------------------------------------------------------------
ALTER TABLE work_segments ALTER COLUMN started_at SET DEFAULT clock_timestamp();
ALTER TABLE work_segments ADD CONSTRAINT work_segments_no_overlap
  EXCLUDE USING gist(
    user_id WITH =,
    tstzrange(started_at, COALESCE(ended_at,'infinity'::timestamptz), '[)') WITH &&
  );
-- Stored generated column: duration is derived once by the DBMS, never by clients.
ALTER TABLE work_segments ADD COLUMN duration_seconds double precision
  GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (ended_at-started_at))::double precision) STORED;

------------------------------------------------------------------------------
-- 4. Hierarchy rule enforced in SQL (previously API-only): one subtask level.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_single_level() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM tasks p
              WHERE p.user_id=NEW.user_id AND p.id=NEW.parent_task_id AND p.parent_task_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Subtasks may be nested one level only' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM tasks c
                                 WHERE c.user_id=NEW.user_id AND c.parent_task_id=NEW.id) THEN
      RAISE EXCEPTION 'A task that has subtasks cannot become a subtask' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS single_level_subtasks ON tasks;
CREATE TRIGGER single_level_subtasks BEFORE INSERT OR UPDATE OF parent_task_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_single_level();

------------------------------------------------------------------------------
-- 5. Append-only history. Audit facts cannot be edited or deleted, except by
--    the account-erasure routine, which sets the transaction-local flag
--    steady.allow_erasure (SET LOCAL semantics) and may only DELETE.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND current_setting('steady.allow_erasure',true)='on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only; % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE='23000';
END $$;
DROP TRIGGER IF EXISTS task_events_append_only ON task_events;
CREATE TRIGGER task_events_append_only BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();
DROP TRIGGER IF EXISTS consent_events_append_only ON consent_events;
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();
DROP TRIGGER IF EXISTS task_checkpoints_append_only ON task_checkpoints;
CREATE TRIGGER task_checkpoints_append_only BEFORE UPDATE OR DELETE ON task_checkpoints
  FOR EACH ROW EXECUTE FUNCTION forbid_history_mutation();

-- Frozen plans stay immutable, but the erasure routine may delete them.
CREATE OR REPLACE FUNCTION protect_plan_members() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' AND current_setting('steady.allow_erasure',true)='on' THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM daily_plans WHERE id IN (NEW.plan_id,OLD.plan_id) AND frozen_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Frozen plan is immutable' USING ERRCODE='23000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION protect_plan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' AND current_setting('steady.allow_erasure',true)='on' THEN RETURN OLD; END IF;
  IF OLD.frozen_at IS NOT NULL THEN RAISE EXCEPTION 'Frozen plan is immutable' USING ERRCODE='23000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;

------------------------------------------------------------------------------
-- 6. Security audit trail for authentication (supports per-account lockout).
------------------------------------------------------------------------------
CREATE TABLE auth_events(
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id),
  email       text NOT NULL,
  event_type  text NOT NULL CHECK(event_type IN('register','login_success','login_failure','login_locked','logout')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_email_time ON auth_events(email,occurred_at DESC);
CREATE INDEX auth_events_user ON auth_events(user_id) WHERE user_id IS NOT NULL;

------------------------------------------------------------------------------
-- 7. Views: derived values computed by the DBMS (single source of truth).
------------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_task_continuity AS
SELECT t.id AS task_id, t.user_id, t.title, t.status, t.estimated_minutes, t.due_at,
       t.created_at, t.first_started_at, t.completed_at,
       EXTRACT(EPOCH FROM (t.first_started_at-t.created_at))::double precision AS initiation_latency_seconds,
       COALESCE(s.actual_seconds,0)::double precision AS actual_seconds,
       COALESCE(s.segment_count,0)::int AS segment_count,
       (SELECT count(*)::int FROM tasks ch WHERE ch.user_id=t.user_id AND ch.parent_task_id=t.id) AS subtask_count,
       c.resume_note AS latest_note, c.created_at AS latest_note_at
FROM tasks t
LEFT JOIN LATERAL (
  SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(w.ended_at,clock_timestamp())-w.started_at))) AS actual_seconds,
         COUNT(*) AS segment_count
  FROM work_segments w JOIN focus_sessions f ON f.id=w.session_id AND f.user_id=w.user_id
  WHERE f.task_id=t.id AND f.user_id=t.user_id) s ON true
LEFT JOIN LATERAL (
  SELECT k.resume_note, k.created_at FROM task_checkpoints k
  WHERE k.task_id=t.id AND k.user_id=t.user_id ORDER BY k.created_at DESC LIMIT 1) c ON true;

-- Controlled-redundancy audit: devices.consent_epoch must equal the ledger.
-- Any row returned is an integrity violation (expected: zero rows).
CREATE OR REPLACE VIEW v_consent_epoch_drift AS
SELECT d.id AS device_id, d.user_id, d.consent_epoch, COALESCE(MAX(e.epoch),0) AS ledger_epoch
FROM devices d LEFT JOIN consent_events e ON e.device_id=d.id AND e.user_id=d.user_id
GROUP BY d.id, d.user_id, d.consent_epoch
HAVING d.consent_epoch<>COALESCE(MAX(e.epoch),0);

------------------------------------------------------------------------------
-- 8. Indexes matched to real query shapes.
------------------------------------------------------------------------------
CREATE INDEX outbox_pending         ON outbox_events(created_at) WHERE processed_at IS NULL;
CREATE INDEX tasks_due_open         ON tasks(user_id,due_at) WHERE due_at IS NOT NULL AND status NOT IN('completed','abandoned');
CREATE INDEX task_events_by_task    ON task_events(user_id,task_id,occurred_at DESC);
CREATE INDEX focus_sessions_by_task ON focus_sessions(user_id,task_id);
CREATE INDEX work_segments_by_session ON work_segments(user_id,session_id);
CREATE INDEX plan_tasks_by_task     ON plan_tasks(user_id,task_id);
CREATE INDEX consent_events_by_device ON consent_events(device_id,effective_at);
