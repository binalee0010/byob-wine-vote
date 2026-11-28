ALTER TABLE activities ADD COLUMN candidate_order TEXT NOT NULL DEFAULT 'registered' CHECK(candidate_order IN ('registered','random'));
CREATE TRIGGER byob_candidate_order_lock BEFORE UPDATE OF candidate_order ON activities
WHEN OLD.started_at IS NOT NULL AND NEW.candidate_order IS NOT OLD.candidate_order
BEGIN SELECT RAISE(ABORT,'candidate_order_locked'); END;
