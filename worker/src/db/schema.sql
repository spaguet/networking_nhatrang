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
-- status: on_moderation | active | archived | rejected | edit_pending | banned
--   banned — hidden from catalog while user is banned; purged 30d after users.banned_at
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
  edits_remaining            INTEGER,
  replaces_listing_id        TEXT,
  telegram_username_verified TEXT,
  telegram_verified_at       TEXT,
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

-- conversations (in-app messaging; user_messaging_TZ.md §4.2)
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id      TEXT PRIMARY KEY,
  listing_id           TEXT NOT NULL,
  owner_tg_id          INTEGER NOT NULL,
  peer_tg_id           INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  first_message_at     TEXT,
  expires_at           TEXT,
  last_message_at      TEXT,
  last_message_id      TEXT,
  last_message_preview TEXT,
  status               TEXT NOT NULL DEFAULT 'open',
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_pair
  ON conversations(listing_id, owner_tg_id, peer_tg_id);

CREATE INDEX IF NOT EXISTS idx_conversations_expires ON conversations(expires_at);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_tg_id);
CREATE INDEX IF NOT EXISTS idx_conversations_peer ON conversations(peer_tg_id);
CREATE INDEX IF NOT EXISTS idx_conversations_owner_last
  ON conversations(owner_tg_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_peer_last
  ON conversations(peer_tg_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_empty_created
  ON conversations(created_at) WHERE first_message_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_tg_id    INTEGER NOT NULL,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id      TEXT NOT NULL,
  reader_tg_id         INTEGER NOT NULL,
  last_read_at         TEXT NOT NULL,
  last_read_message_id TEXT,
  PRIMARY KEY (conversation_id, reader_tg_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_complaints (
  complaint_id        TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL,
  reporter_tg_id      INTEGER NOT NULL,
  body                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  participant_a_tg_id INTEGER NOT NULL,
  participant_b_tg_id INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  resolved_at         TEXT,
  resolved_by         INTEGER,
  punished_tg_id      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_complaints_status ON message_complaints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaints_conversation ON message_complaints(conversation_id);
