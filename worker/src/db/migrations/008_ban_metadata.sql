-- Ban audit metadata (admin profile v1.3 §4.3)

ALTER TABLE users ADD COLUMN banned_at TEXT;
ALTER TABLE users ADD COLUMN banned_by INTEGER;
