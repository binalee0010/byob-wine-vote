ALTER TABLE activities ADD COLUMN results_locked INTEGER NOT NULL DEFAULT 0 CHECK (results_locked IN (0,1));
UPDATE activities SET results_locked=1 WHERE published=1;

CREATE TRIGGER activity_results_lock_sync AFTER UPDATE OF published,revision ON activities
WHEN (NEW.published=1 AND NEW.results_locked=0)
  OR (NEW.revision<>OLD.revision AND NEW.published=0 AND NEW.results_locked=1)
BEGIN UPDATE activities SET results_locked=NEW.published WHERE id=NEW.id; END;

CREATE TRIGGER activity_results_reopen_lock BEFORE UPDATE OF status ON activities
WHEN OLD.results_locked=1 AND NEW.status='open'
BEGIN SELECT RAISE(ABORT,'results_locked'); END;

CREATE TRIGGER grade_insert_results_lock BEFORE INSERT ON grades
WHEN EXISTS(SELECT 1 FROM activities WHERE id='blind' AND results_locked=1)
BEGIN SELECT RAISE(ABORT,'results_locked'); END;

CREATE TRIGGER grade_update_results_lock BEFORE UPDATE ON grades
WHEN EXISTS(SELECT 1 FROM activities WHERE id='blind' AND results_locked=1)
BEGIN SELECT RAISE(ABORT,'results_locked'); END;
