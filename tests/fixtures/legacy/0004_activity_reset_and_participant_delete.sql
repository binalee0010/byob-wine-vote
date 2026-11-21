ALTER TABLE activities ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE event ADD COLUMN roster_revision INTEGER NOT NULL DEFAULT 0 CHECK (roster_revision >= 0);
CREATE INDEX sessions_participant ON sessions(participant_id);
CREATE INDEX answers_participant ON answers(participant_id);
CREATE TRIGGER activity_reset_clear AFTER UPDATE OF revision ON activities WHEN NEW.revision <> OLD.revision BEGIN DELETE FROM answers WHERE activity_id=OLD.id; DELETE FROM grades WHERE OLD.id='blind'; END;
CREATE TRIGGER participant_delete_children BEFORE DELETE ON participants BEGIN DELETE FROM sessions WHERE participant_id=OLD.id AND role='participant'; DELETE FROM answers WHERE participant_id=OLD.id; DELETE FROM grades WHERE participant_id=OLD.id; END;
CREATE TRIGGER participant_added_revision AFTER INSERT ON participants BEGIN UPDATE event SET roster_revision=roster_revision+1 WHERE id=1; END;
CREATE TRIGGER participant_deleted_revision AFTER DELETE ON participants BEGIN UPDATE event SET roster_revision=roster_revision+1 WHERE id=1; END;
CREATE TRIGGER participant_renamed_revision AFTER UPDATE OF name ON participants WHEN NEW.name<>OLD.name BEGIN UPDATE event SET roster_revision=roster_revision+1 WHERE id=1; END;
