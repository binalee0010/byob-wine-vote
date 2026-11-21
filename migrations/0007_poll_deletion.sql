ALTER TABLE member_polls ADD COLUMN deleted_at INTEGER;
ALTER TABLE member_polls ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1));
ALTER TABLE member_polls ADD COLUMN cleanup_version INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_version>=0);
CREATE TRIGGER member_poll_deleted_initialize BEFORE UPDATE OF initialized ON member_polls
WHEN OLD.deleted_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'poll_deleted'); END;
