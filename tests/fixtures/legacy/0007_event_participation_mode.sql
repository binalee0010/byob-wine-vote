ALTER TABLE event ADD COLUMN participation_mode TEXT NOT NULL DEFAULT 'open' CHECK (participation_mode IN ('open','restricted'));
