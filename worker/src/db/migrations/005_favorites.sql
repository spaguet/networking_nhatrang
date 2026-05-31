CREATE TABLE IF NOT EXISTS favorites (
  listing_id    TEXT NOT NULL,
  tg_id         INTEGER NOT NULL,
  favorited_at  TEXT NOT NULL,
  PRIMARY KEY (listing_id, tg_id),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_favorites_tg_id ON favorites(tg_id);
CREATE INDEX IF NOT EXISTS idx_favorites_listing ON favorites(listing_id);
