ALTER TABLE activities ADD COLUMN publish_on_close INTEGER NOT NULL DEFAULT 0 CHECK (publish_on_close IN (0,1));
UPDATE activities SET publish_on_close=1 WHERE published=1;

CREATE TRIGGER activity_publish_on_close_sync AFTER UPDATE OF published ON activities
WHEN (NEW.published=1 AND NEW.publish_on_close=0)
  OR (NEW.published=0 AND NEW.publish_on_close=1 AND (OLD.published=1 OR NEW.revision<>OLD.revision))
BEGIN UPDATE activities SET publish_on_close=NEW.published WHERE id=NEW.id; END;
