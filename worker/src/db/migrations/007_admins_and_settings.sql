-- admins + app_settings (admin profile v1.3)
-- Seed grand_admin: post-deploy via scripts/seed-grand-admin.ps1 or ensureGrandAdmin() — not in SQL (D1 cannot read env).

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

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL
);
