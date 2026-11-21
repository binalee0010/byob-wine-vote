ALTER TABLE activities ADD COLUMN pre_reveal INTEGER NOT NULL DEFAULT 0 CHECK (pre_reveal IN (0, 1));
