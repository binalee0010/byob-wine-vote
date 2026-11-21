DROP TRIGGER candidates_update_lock;
CREATE TRIGGER candidates_update_lock BEFORE UPDATE ON candidates
WHEN EXISTS(SELECT 1 FROM activities WHERE id='byob' AND started_at IS NOT NULL)
  AND (NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number OR NEW.request_id IS NOT OLD.request_id
    OR (NOT EXISTS(SELECT 1 FROM activities WHERE id='byob' AND status='closed')
      AND (NEW.name IS NOT OLD.name OR NEW.description IS NOT OLD.description)))
BEGIN SELECT RAISE(ABORT,'candidates_locked'); END;
CREATE TRIGGER candidate_photo_replace_cleanup AFTER UPDATE OF object_key ON candidates
WHEN OLD.object_key<>'' AND NEW.object_key IS NOT OLD.object_key
  AND NOT EXISTS(SELECT 1 FROM candidates WHERE object_key=OLD.object_key)
  AND NOT EXISTS(SELECT 1 FROM vote_history h CROSS JOIN json_each(h.snapshot,'$.rows') c WHERE json_extract(c.value,'$.object_key')=OLD.object_key)
BEGIN INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) VALUES(OLD.object_key); END;
