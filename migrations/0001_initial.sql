PRAGMA foreign_keys=ON;

CREATE TABLE event (
  id INTEGER PRIMARY KEY CHECK(id=1),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  participation_mode TEXT NOT NULL DEFAULT 'open' CHECK(participation_mode IN ('open','restricted')),
  roster_revision INTEGER NOT NULL DEFAULT 0 CHECK(roster_revision>=0)
);
INSERT INTO event(id,title,starts_at,timezone) VALUES(1,'BYOB 와인 투표','','Asia/Seoul');

CREATE TABLE activities (
  id TEXT PRIMARY KEY CHECK(id='byob'),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','open','closed')),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  publish_on_close INTEGER NOT NULL DEFAULT 0 CHECK(publish_on_close IN (0,1)),
  started_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  results_locked INTEGER NOT NULL DEFAULT 0 CHECK(results_locked IN (0,1)),
  voting_method TEXT NOT NULL DEFAULT 'full' CHECK(voting_method IN ('winner','top2','full')),
  rank_points TEXT NOT NULL DEFAULT '[3,1]' CHECK(json_valid(rank_points) AND json_type(rank_points)='array' AND json_array_length(rank_points) BETWEEN 1 AND 100),
  full_reset_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO activities(id,title) VALUES('byob','BYOB 와인 투표');

CREATE TABLE participants (id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('admin','participant')),
  participant_id TEXT REFERENCES participants(id),
  expires_at INTEGER NOT NULL,
  credential_version TEXT
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_participant ON sessions(participant_id);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL);
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,number INTEGER NOT NULL,name TEXT NOT NULL,object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,request_id TEXT NOT NULL UNIQUE
);
CREATE TABLE answers (
  activity_id TEXT NOT NULL REFERENCES activities(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(activity_id,participant_id)
);
CREATE INDEX answers_participant ON answers(participant_id);
CREATE TABLE admin_credentials (
  id INTEGER PRIMARY KEY CHECK(id=1),password_hash TEXT NOT NULL,
  bootstrap_fingerprint TEXT NOT NULL,version TEXT NOT NULL
);
CREATE TABLE admin_bootstrap_history (fingerprint TEXT PRIMARY KEY);
CREATE TABLE vote_history (
  id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,saved_at TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
);
CREATE TABLE candidate_photo_cleanup (object_key TEXT PRIMARY KEY);

CREATE TRIGGER admin_credential_insert_revoke AFTER INSERT ON admin_credentials
BEGIN DELETE FROM sessions WHERE role='admin'; END;
CREATE TRIGGER admin_credential_update_revoke AFTER UPDATE OF version ON admin_credentials WHEN OLD.version<>NEW.version
BEGIN DELETE FROM sessions WHERE role='admin'; END;
CREATE TRIGGER admin_session_version BEFORE INSERT ON sessions
WHEN NEW.role='admin' AND NOT EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=NEW.credential_version)
BEGIN SELECT RAISE(ABORT,'credential_changed'); END;

CREATE TRIGGER candidates_insert_lock BEFORE INSERT ON candidates
WHEN EXISTS(SELECT 1 FROM activities WHERE id='byob' AND started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'candidates_locked'); END;
CREATE TRIGGER candidates_update_lock BEFORE UPDATE ON candidates
WHEN EXISTS(SELECT 1 FROM activities WHERE id='byob' AND started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'candidates_locked'); END;
CREATE TRIGGER candidates_delete_lock BEFORE DELETE ON candidates
WHEN EXISTS(SELECT 1 FROM activities WHERE id='byob' AND started_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'candidates_locked'); END;
CREATE TRIGGER answer_insert_open BEFORE INSERT ON answers
WHEN NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND status='open' AND published=0)
BEGIN SELECT RAISE(ABORT,'activity_closed'); END;
CREATE TRIGGER answer_update_open BEFORE UPDATE ON answers
WHEN NOT EXISTS(SELECT 1 FROM activities WHERE id=NEW.activity_id AND status='open' AND published=0)
BEGIN SELECT RAISE(ABORT,'activity_closed'); END;
CREATE TRIGGER byob_candidate_insert BEFORE INSERT ON answers
WHEN CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT CASE voting_method WHEN 'winner' THEN 1 WHEN 'top2' THEN json_array_length(rank_points) ELSE (SELECT count(*) FROM candidates) END FROM activities WHERE id='byob')
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE 1 END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;
CREATE TRIGGER byob_candidate_update BEFORE UPDATE OF payload ON answers
WHEN CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT CASE voting_method WHEN 'winner' THEN 1 WHEN 'top2' THEN json_array_length(rank_points) ELSE (SELECT count(*) FROM candidates) END FROM activities WHERE id='byob')
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE 1 END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;
CREATE TRIGGER byob_method_lock BEFORE UPDATE OF voting_method ON activities
WHEN OLD.started_at IS NOT NULL AND NEW.voting_method IS NOT OLD.voting_method
BEGIN SELECT RAISE(ABORT,'voting_method_locked'); END;
CREATE TRIGGER byob_rank_points_lock BEFORE UPDATE OF rank_points ON activities
WHEN OLD.started_at IS NOT NULL AND NEW.rank_points IS NOT OLD.rank_points
BEGIN SELECT RAISE(ABORT,'voting_method_locked'); END;

CREATE TRIGGER activity_reset_clear AFTER UPDATE OF revision ON activities WHEN NEW.revision<>OLD.revision
BEGIN DELETE FROM answers WHERE activity_id=OLD.id; END;
CREATE TRIGGER participant_delete_children BEFORE DELETE ON participants
BEGIN DELETE FROM sessions WHERE participant_id=OLD.id AND role='participant'; DELETE FROM answers WHERE participant_id=OLD.id; END;
CREATE TRIGGER participant_added_revision AFTER INSERT ON participants
BEGIN UPDATE event SET roster_revision=roster_revision+1 WHERE id=1; END;
CREATE TRIGGER participant_deleted_revision AFTER DELETE ON participants
BEGIN UPDATE event SET roster_revision=roster_revision+1 WHERE id=1; END;
CREATE TRIGGER participant_renamed_revision AFTER UPDATE OF name ON participants WHEN NEW.name<>OLD.name
BEGIN UPDATE event SET roster_revision=roster_revision+1 WHERE id=1; END;
CREATE TRIGGER activity_results_lock_sync AFTER UPDATE OF published,revision ON activities
WHEN (NEW.published=1 AND NEW.results_locked=0)
  OR (NEW.revision<>OLD.revision AND NEW.published=0 AND NEW.results_locked=1)
BEGIN UPDATE activities SET results_locked=NEW.published WHERE id=NEW.id; END;
CREATE TRIGGER activity_results_reopen_lock BEFORE UPDATE OF status ON activities
WHEN OLD.results_locked=1 AND NEW.status='open'
BEGIN SELECT RAISE(ABORT,'results_locked'); END;
CREATE TRIGGER activity_publish_on_close_sync AFTER UPDATE OF published ON activities
WHEN (NEW.published=1 AND NEW.publish_on_close=0)
  OR (NEW.published=0 AND NEW.publish_on_close=1 AND (OLD.published=1 OR NEW.revision<>OLD.revision))
BEGIN UPDATE activities SET publish_on_close=NEW.published WHERE id=NEW.id; END;
CREATE TRIGGER vote_history_finalize AFTER INSERT ON vote_history
BEGIN UPDATE activities SET results_locked=1 WHERE id='byob' AND revision=NEW.revision; END;
CREATE TRIGGER vote_full_reset AFTER UPDATE OF full_reset_revision ON activities
WHEN NEW.full_reset_revision<>OLD.full_reset_revision
BEGIN DELETE FROM participants; DELETE FROM candidates; END;
CREATE TRIGGER candidate_photo_cleanup_enqueue AFTER DELETE ON candidates
WHEN OLD.object_key<>'' AND NOT EXISTS (
  SELECT 1 FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c
  WHERE json_extract(c.value,'$.object_key')=OLD.object_key
)
BEGIN INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) VALUES(OLD.object_key); END;
