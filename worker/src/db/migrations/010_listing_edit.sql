-- Listing edit: edits_remaining on active parent, edit_pending draft via replaces_listing_id.
-- See listing_edit_TZ.md §3.1.

ALTER TABLE listings ADD COLUMN edits_remaining INTEGER;
ALTER TABLE listings ADD COLUMN replaces_listing_id TEXT;

CREATE INDEX IF NOT EXISTS idx_listings_edit_pending
  ON listings(tg_id, status)
  WHERE status = 'edit_pending';

CREATE INDEX IF NOT EXISTS idx_listings_replaces
  ON listings(replaces_listing_id)
  WHERE replaces_listing_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_one_edit_pending_per_user
  ON listings(tg_id)
  WHERE status = 'edit_pending';

-- Backfill: all current active listings get full edit quota (same as new after approve).
UPDATE listings SET edits_remaining = 3 WHERE status = 'active' AND edits_remaining IS NULL;
