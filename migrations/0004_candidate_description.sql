ALTER TABLE candidates ADD COLUMN description TEXT NOT NULL DEFAULT '';
DROP TRIGGER candidates_update_lock;
CREATE TRIGGER candidates_update_lock BEFORE UPDATE ON candidates
WHEN EXISTS(SELECT 1 FROM activities WHERE id='byob' AND started_at IS NOT NULL)
  AND (NOT EXISTS(SELECT 1 FROM activities WHERE id='byob' AND status='closed')
    OR NEW.id IS NOT OLD.id OR NEW.number IS NOT OLD.number
    OR NEW.object_key IS NOT OLD.object_key OR NEW.content_type IS NOT OLD.content_type
    OR NEW.request_id IS NOT OLD.request_id)
BEGIN SELECT RAISE(ABORT,'candidates_locked'); END;
