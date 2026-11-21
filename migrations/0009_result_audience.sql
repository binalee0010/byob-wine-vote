ALTER TABLE activities ADD COLUMN result_visibility TEXT NOT NULL DEFAULT 'private' CHECK(result_visibility IN ('private','participants','public'));
UPDATE activities SET result_visibility=CASE WHEN published=1 OR publish_on_close=1 THEN 'public' ELSE 'private' END;

CREATE TABLE participant_round_entries (
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>=0),
  PRIMARY KEY(participant_id,revision)
);
-- The first round has no earlier entries; later rounds require a ballot or an entry after this round started.
INSERT OR IGNORE INTO participant_round_entries(participant_id,revision)
SELECT e.participant_id,a.revision FROM participant_entries e CROSS JOIN activities a
WHERE a.id='byob' AND (a.revision=0 OR (a.started_at IS NOT NULL AND e.entered_at>=CAST((julianday(a.started_at)-2440587.5)*86400000 AS INTEGER)));
INSERT OR IGNORE INTO participant_round_entries(participant_id,revision)
SELECT participant_id,(SELECT revision FROM activities WHERE id='byob') FROM answers WHERE activity_id='byob';
CREATE TRIGGER participant_session_round_entry AFTER INSERT ON sessions WHEN NEW.role='participant'
BEGIN INSERT OR IGNORE INTO participant_round_entries(participant_id,revision)
SELECT NEW.participant_id,revision FROM activities WHERE id='byob' AND status IN ('waiting','open'); END;

DROP TRIGGER activity_publish_on_close_sync;
CREATE TRIGGER activity_publish_on_close_sync AFTER UPDATE OF published,revision ON activities
WHEN NEW.revision<>OLD.revision OR NEW.published<>OLD.published
BEGIN UPDATE activities SET publish_on_close=NEW.published,
  result_visibility=CASE WHEN NEW.revision<>OLD.revision OR NEW.published=0 THEN 'private'
    WHEN NEW.result_visibility='private' THEN 'public' ELSE NEW.result_visibility END
  WHERE id=NEW.id; END;
