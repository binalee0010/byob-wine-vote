CREATE TABLE participant_entries (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  entered_at INTEGER NOT NULL
);
CREATE TRIGGER participant_session_entry AFTER INSERT ON sessions WHEN NEW.role='participant'
BEGIN INSERT OR IGNORE INTO participant_entries(participant_id,entered_at) VALUES(NEW.participant_id,CAST(strftime('%s','now') AS INTEGER)*1000); END;
-- Older rows without surviving session or ballot evidence remain canonical but are not marked as joined.
INSERT INTO participant_entries(participant_id,entered_at)
SELECT p.id,0 FROM participants p WHERE EXISTS(
  SELECT 1 FROM sessions s WHERE s.role='participant' AND s.participant_id=p.id
) OR EXISTS(SELECT 1 FROM answers a WHERE a.activity_id='byob' AND a.participant_id=p.id);
