-- Keep public aliases independently of poll data so deleted addresses remain reserved.
CREATE TABLE poll_public_links (
  poll_slug TEXT PRIMARY KEY NOT NULL CHECK(poll_slug='owner' OR (length(poll_slug)=32 AND poll_slug NOT GLOB '*[^a-f0-9]*')),
  alias TEXT NOT NULL UNIQUE CHECK(length(alias)=8 AND alias NOT GLOB '*[^23456789abcdefghjkmnpqrstuvwxyz]*')
);
