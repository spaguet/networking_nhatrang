-- users
CREATE TABLE IF NOT EXISTS users (
  tg_id       INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT NOT NULL,
  reg_date    TEXT NOT NULL,
  free_used   INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0,
  banned_at   TEXT,
  banned_by   INTEGER
);

-- listings
-- status: on_moderation | active | archived | rejected | edit_pending
--   edit_pending — draft edit (not in catalog/profile list); parent active row stays visible until approve
CREATE TABLE IF NOT EXISTS listings (
  listing_id          TEXT PRIMARY KEY,
  tg_id               INTEGER NOT NULL,
  display_name        TEXT NOT NULL,
  category            TEXT NOT NULL,
  description         TEXT NOT NULL,
  experience          TEXT,
  contact_type        TEXT NOT NULL,
  contacts            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'on_moderation',
  payment_status      TEXT NOT NULL DEFAULT 'free',
  created_at          TEXT,
  expires_at          TEXT,
  submitted_at        TEXT NOT NULL,
  avatar_emoji        TEXT,
  pin_status          TEXT NOT NULL DEFAULT 'regular',
  pinned_at           TEXT,
  pin_expires_at      TEXT,
  archived_at         TEXT,
  keywords            TEXT NOT NULL DEFAULT '[]',
  edits_remaining     INTEGER,
  replaces_listing_id TEXT,
  FOREIGN KEY (tg_id) REFERENCES users(tg_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_tg_id    ON listings(tg_id);
CREATE INDEX IF NOT EXISTS idx_listings_pin      ON listings(pin_status, status);
CREATE INDEX IF NOT EXISTS idx_listings_expires  ON listings(expires_at);
CREATE INDEX IF NOT EXISTS idx_listings_archived_at ON listings(archived_at) WHERE status = 'archived';
CREATE INDEX IF NOT EXISTS idx_listings_edit_pending ON listings(tg_id, status) WHERE status = 'edit_pending';
CREATE INDEX IF NOT EXISTS idx_listings_replaces ON listings(replaces_listing_id) WHERE replaces_listing_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_one_edit_pending_per_user ON listings(tg_id) WHERE status = 'edit_pending';

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

-- admins (grand_admin / admin roles; admin_profile_TZ.md)
CREATE TABLE IF NOT EXISTS admins (
  tg_id          INTEGER PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('grand_admin', 'admin')),
  password_hash  TEXT,
  password_salt  TEXT,
  created_at     TEXT NOT NULL,
  created_by     INTEGER,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role);

-- app_settings (dynamic prices / QR file_ids; D1 priority over env)
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL
);
