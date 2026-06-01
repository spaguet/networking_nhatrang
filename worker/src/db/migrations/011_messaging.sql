-- In-app messaging: conversations, messages, reads, complaints (user_messaging_TZ.md §4.2)

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
