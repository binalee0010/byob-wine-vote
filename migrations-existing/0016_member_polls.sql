CREATE TABLE member_polls (
  slug TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  namespace TEXT UNIQUE,
  request_id TEXT,
  creation_title TEXT NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1)),
  created_at INTEGER NOT NULL,
  UNIQUE(member_id,request_id),
  CHECK((slug='owner' AND member_id='owner' AND namespace IS NULL)
    OR (length(slug)=32 AND slug NOT GLOB '*[^a-f0-9]*' AND namespace='m_'||slug))
);
CREATE INDEX member_polls_member ON member_polls(member_id,created_at);
