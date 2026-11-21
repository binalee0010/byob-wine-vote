DROP TRIGGER candidate_photo_cleanup_enqueue;

CREATE TRIGGER candidate_photo_cleanup_enqueue AFTER DELETE ON candidates
WHEN OLD.object_key<>''
BEGIN INSERT OR IGNORE INTO candidate_photo_cleanup(object_key) VALUES(OLD.object_key); END;
