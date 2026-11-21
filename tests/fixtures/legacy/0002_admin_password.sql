CREATE TABLE admin_credentials (id INTEGER PRIMARY KEY CHECK(id=1),password_hash TEXT NOT NULL,bootstrap_fingerprint TEXT NOT NULL,version TEXT NOT NULL);
CREATE TABLE admin_bootstrap_history (fingerprint TEXT PRIMARY KEY);
ALTER TABLE sessions ADD COLUMN credential_version TEXT;
CREATE TRIGGER admin_credential_insert_revoke AFTER INSERT ON admin_credentials BEGIN DELETE FROM sessions WHERE role='admin'; END;
CREATE TRIGGER admin_credential_update_revoke AFTER UPDATE OF version ON admin_credentials WHEN OLD.version<>NEW.version BEGIN DELETE FROM sessions WHERE role='admin'; END;
CREATE TRIGGER admin_session_version BEFORE INSERT ON sessions WHEN NEW.role='admin' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1) AND NOT EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=NEW.credential_version) BEGIN SELECT RAISE(ABORT,'credential_changed'); END;
CREATE TRIGGER byob_candidate_insert BEFORE INSERT ON answers WHEN NEW.activity_id='byob' AND NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;
CREATE TRIGGER byob_candidate_update BEFORE UPDATE OF payload ON answers WHEN NEW.activity_id='byob' AND NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;
