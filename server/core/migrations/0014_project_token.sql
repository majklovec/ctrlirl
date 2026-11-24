-- Give every project a persistent token of its own: the overlay runtime URLs
-- (and device connections) authenticate with it, so they no longer depend on
-- a device token existing. `randomblob(24)` is a non-constant default, which
-- SQLite allows for a NOT NULL added column; existing rows are filled with a
-- fresh random value. The unique index is what the token lookup needs (a
-- UNIQUE constraint cannot ride on ALTER TABLE ADD COLUMN).

ALTER TABLE projects
    ADD COLUMN token TEXT NOT NULL DEFAULT (lower(hex(randomblob(24))));

CREATE UNIQUE INDEX IF NOT EXISTS projects_token
    ON projects(token);
