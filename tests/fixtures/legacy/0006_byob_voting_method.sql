ALTER TABLE activities ADD COLUMN voting_method TEXT NOT NULL DEFAULT 'full' CHECK (voting_method IN ('winner','top2','full'));

CREATE TRIGGER byob_method_lock BEFORE UPDATE OF voting_method ON activities
WHEN OLD.started_at IS NOT NULL AND NEW.voting_method IS NOT OLD.voting_method
BEGIN SELECT RAISE(ABORT,'voting_method_locked'); END;

DROP TRIGGER byob_candidate_insert;
DROP TRIGGER byob_candidate_update;

CREATE TRIGGER byob_candidate_insert BEFORE INSERT ON answers
WHEN NEW.activity_id='byob' AND CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT CASE voting_method WHEN 'winner' THEN 1 WHEN 'top2' THEN 2 ELSE (SELECT count(*) FROM candidates) END FROM activities WHERE id='byob')
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;

CREATE TRIGGER byob_candidate_update BEFORE UPDATE OF payload ON answers
WHEN NEW.activity_id='byob' AND CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT CASE voting_method WHEN 'winner' THEN 1 WHEN 'top2' THEN 2 ELSE (SELECT count(*) FROM candidates) END FROM activities WHERE id='byob')
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;
