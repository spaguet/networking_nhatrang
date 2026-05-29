ALTER TABLE listings ADD COLUMN archived_at TEXT;

CREATE TABLE IF NOT EXISTS listing_media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id    TEXT NOT NULL,
  position      INTEGER NOT NULL CHECK (position >= 1 AND position <= 5),
  r2_key        TEXT NOT NULL,
  thumb_r2_key  TEXT,
  mime_type     TEXT NOT NULL DEFAULT 'image/webp',
  byte_size     INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  UNIQUE (listing_id, position),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_listing_media_listing ON listing_media(listing_id);
CREATE INDEX IF NOT EXISTS idx_listings_archived_at ON listings(archived_at) WHERE status = 'archived';
