DROP TRIGGER byob_candidate_insert;
DROP TRIGGER byob_candidate_update;

CREATE TRIGGER byob_candidate_insert BEFORE INSERT ON answers
WHEN NEW.activity_id='byob' AND CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(*) FROM candidates)
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;

CREATE TRIGGER byob_candidate_update BEFORE UPDATE OF payload ON answers
WHEN NEW.activity_id='byob' AND CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(*) FROM candidates)
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;
