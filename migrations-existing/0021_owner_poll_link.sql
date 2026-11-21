-- Public addresses change without rewriting shared root tables, sessions or tombstones.
CREATE TABLE owner_poll_link (
  id INTEGER PRIMARY KEY CHECK(id=1),
  slug TEXT NOT NULL UNIQUE CHECK(length(slug)=32 AND slug NOT GLOB '*[^a-f0-9]*')
);
INSERT INTO owner_poll_link(id,slug) VALUES(1,lower(hex(randomblob(16))));
