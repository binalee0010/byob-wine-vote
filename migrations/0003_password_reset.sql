-- Store only token hashes; credential changes atomically invalidate every issued link.
CREATE TABLE member_password_resets (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  member_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  credential_version TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX member_password_reset_expiry ON member_password_resets(expires_at);
CREATE INDEX member_password_reset_member ON member_password_resets(member_id);
CREATE TRIGGER member_password_reset_invalidate AFTER UPDATE OF credential_version,email ON members
WHEN OLD.credential_version IS NOT NEW.credential_version OR OLD.email<>NEW.email
BEGIN DELETE FROM member_password_resets WHERE member_id=NEW.id; END;
CREATE TRIGGER member_password_reset_delete AFTER DELETE ON members
BEGIN DELETE FROM member_password_resets WHERE member_id=OLD.id; END;
CREATE TRIGGER owner_password_reset_invalidate AFTER UPDATE OF version ON admin_credentials
WHEN OLD.version<>NEW.version
BEGIN DELETE FROM member_password_resets WHERE role='owner'; END;
