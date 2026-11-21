ALTER TABLE activities ADD COLUMN rank_points TEXT NOT NULL DEFAULT '[3,1]' CHECK (json_valid(rank_points) AND json_type(rank_points)='array' AND json_array_length(rank_points) BETWEEN 1 AND 100);

CREATE TRIGGER byob_rank_points_lock BEFORE UPDATE OF rank_points ON activities
WHEN OLD.started_at IS NOT NULL AND NEW.rank_points IS NOT OLD.rank_points
BEGIN SELECT RAISE(ABORT,'voting_method_locked'); END;

DROP TRIGGER byob_candidate_insert;
DROP TRIGGER byob_candidate_update;

CREATE TRIGGER byob_candidate_insert BEFORE INSERT ON answers
WHEN NEW.activity_id='byob' AND CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT CASE voting_method WHEN 'winner' THEN 1 WHEN 'top2' THEN json_array_length(rank_points) ELSE (SELECT count(*) FROM candidates) END FROM activities WHERE id='byob')
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;

CREATE TRIGGER byob_candidate_update BEFORE UPDATE OF payload ON answers
WHEN NEW.activity_id='byob' AND CASE WHEN json_type(NEW.payload,'$.ranking')='array' THEN
  json_array_length(NEW.payload,'$.ranking')<1
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT CASE voting_method WHEN 'winner' THEN 1 WHEN 'top2' THEN json_array_length(rank_points) ELSE (SELECT count(*) FROM candidates) END FROM activities WHERE id='byob')
  OR json_array_length(NEW.payload,'$.ranking')<>(SELECT count(DISTINCT ranked.value) FROM json_each(NEW.payload,'$.ranking') ranked JOIN candidates c ON c.id=ranked.value)
ELSE NOT EXISTS(SELECT 1 FROM candidates WHERE id=json_extract(NEW.payload,'$.candidateId')) END
BEGIN SELECT RAISE(ABORT,'candidate_missing'); END;

CREATE TABLE candidate_photo_cleanup (object_key TEXT PRIMARY KEY);
CREATE TRIGGER candidate_photo_cleanup_enqueue AFTER DELETE ON candidates
BEGIN INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) VALUES(OLD.object_key); END;
