CREATE TABLE vote_history (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL UNIQUE,
  saved_at TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
);

CREATE TRIGGER vote_history_finalize AFTER INSERT ON vote_history
BEGIN UPDATE activities SET results_locked=1 WHERE id='byob' AND revision=NEW.revision; END;

ALTER TABLE activities ADD COLUMN full_reset_revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER vote_full_reset AFTER UPDATE OF full_reset_revision ON activities
WHEN NEW.id='byob' AND NEW.full_reset_revision<>OLD.full_reset_revision
BEGIN DELETE FROM participants; DELETE FROM candidates; END;

DROP TRIGGER candidate_photo_cleanup_enqueue;
CREATE TRIGGER candidate_photo_cleanup_enqueue AFTER DELETE ON candidates
WHEN OLD.object_key<>'' AND NOT EXISTS (
  SELECT 1 FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c
  WHERE json_extract(c.value,'$.object_key')=OLD.object_key
)
BEGIN INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) VALUES(OLD.object_key); END;
