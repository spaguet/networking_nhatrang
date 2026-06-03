-- Listing status `banned`: hidden from catalog, not archived; purged 30 days after user ban.

UPDATE listings
SET status = 'banned'
WHERE status = 'active'
  AND tg_id IN (SELECT tg_id FROM users WHERE banned = 1);
