-- One-time backfill after 002_portfolio.sql (portfolio_TZ.md §5.3)
UPDATE listings
SET archived_at = COALESCE(archived_at, expires_at, datetime('now'))
WHERE status = 'archived' AND archived_at IS NULL;
