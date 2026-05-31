-- users
CREATE TABLE IF NOT EXISTS users (
  tg_id       INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT NOT NULL,
  reg_date    TEXT NOT NULL,
  free_used   INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0
);

-- listings
CREATE TABLE IF NOT EXISTS listings (
  listing_id      TEXT PRIMARY KEY,
  tg_id           INTEGER NOT NULL,
  display_name    TEXT NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL,
  experience      TEXT,
  contact_type    TEXT NOT NULL,
  contacts        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'on_moderation',
  payment_status  TEXT NOT NULL DEFAULT 'free',
  created_at      TEXT,
  expires_at      TEXT,
  submitted_at    TEXT NOT NULL,
  avatar_emoji    TEXT,
  pin_status      TEXT NOT NULL DEFAULT 'regular',
  pinned_at       TEXT,
  pin_expires_at  TEXT,
  archived_at     TEXT,
  keywords        TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (tg_id) REFERENCES users(tg_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_tg_id    ON listings(tg_id);
CREATE INDEX IF NOT EXISTS idx_listings_pin      ON listings(pin_status, status);
CREATE INDEX IF NOT EXISTS idx_listings_expires  ON listings(expires_at);
CREATE INDEX IF NOT EXISTS idx_listings_archived_at ON listings(archived_at) WHERE status = 'archived';

-- listing_media (portfolio photos; see migrations/002_portfolio.sql)
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

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  tg_id        INTEGER PRIMARY KEY,
  state        TEXT NOT NULL,
  draft        TEXT,
  updated_at   TEXT NOT NULL,
  session_type TEXT DEFAULT 'payment'
);

-- logs
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  tg_id       INTEGER,
  action      TEXT NOT NULL,
  details     TEXT
);

-- likes
CREATE TABLE IF NOT EXISTS likes (
  listing_id  TEXT NOT NULL,
  tg_id       INTEGER NOT NULL,
  liked_at    TEXT NOT NULL,
  PRIMARY KEY (listing_id, tg_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_listing ON likes(listing_id);

-- favorites
CREATE TABLE IF NOT EXISTS favorites (
  listing_id    TEXT NOT NULL,
  tg_id         INTEGER NOT NULL,
  favorited_at  TEXT NOT NULL,
  PRIMARY KEY (listing_id, tg_id),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_favorites_tg_id ON favorites(tg_id);
CREATE INDEX IF NOT EXISTS idx_favorites_listing ON favorites(listing_id);

-- admin_links (reply админа → пользователь)
CREATE TABLE IF NOT EXISTS admin_links (
  admin_message_id INTEGER PRIMARY KEY,
  user_tg_id       INTEGER NOT NULL,
  link_type        TEXT,
  listing_id       TEXT,
  created_at       TEXT NOT NULL
);
