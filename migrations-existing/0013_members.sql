-- Membership is additive; the original event and inventory remain in their existing tables.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
  workspace_slug TEXT NOT NULL UNIQUE,
  namespace TEXT UNIQUE,
  password_hash TEXT,
  credential_version TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  CHECK(length(email) BETWEEN 3 AND 254 AND email=lower(email)),
  CHECK((role='owner' AND id='owner' AND status='approved' AND workspace_slug='owner' AND namespace IS NULL AND password_hash IS NULL AND credential_version IS NULL)
    OR (role='member' AND length(id)=32 AND id NOT GLOB '*[^a-f0-9]*' AND workspace_slug=id AND namespace='m_'||id AND password_hash IS NOT NULL AND credential_version IS NOT NULL))
);
CREATE INDEX members_status ON members(status,created_at);
CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  credential_version TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX member_sessions_member ON member_sessions(member_id);
CREATE INDEX member_sessions_expiry ON member_sessions(expires_at);
CREATE TABLE member_login_attempts (key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL);
CREATE TABLE member_notice_outbox (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  email TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX member_notice_pending ON member_notice_outbox(sent_at,next_attempt_at);
CREATE TRIGGER member_session_version BEFORE INSERT ON member_sessions
WHEN NOT EXISTS(SELECT 1 FROM members m WHERE m.id=NEW.member_id AND
  ((m.role='member' AND m.credential_version=NEW.credential_version)
    OR (m.role='owner' AND m.status='approved' AND EXISTS(SELECT 1 FROM admin_credentials WHERE id=1 AND version=NEW.credential_version))))
BEGIN SELECT RAISE(ABORT,'member_credential_changed'); END;
CREATE TRIGGER member_password_revoke AFTER UPDATE OF credential_version ON members
WHEN OLD.credential_version IS NOT NEW.credential_version
BEGIN DELETE FROM member_sessions WHERE member_id=NEW.id; END;
CREATE TRIGGER member_reject_revoke AFTER UPDATE OF status ON members
WHEN NEW.status='rejected' AND OLD.status<>NEW.status
BEGIN DELETE FROM member_sessions WHERE member_id=NEW.id; END;
CREATE TRIGGER member_owner_credential_revoke AFTER UPDATE OF version ON admin_credentials
WHEN OLD.version<>NEW.version
BEGIN DELETE FROM member_sessions WHERE member_id='owner'; END;
