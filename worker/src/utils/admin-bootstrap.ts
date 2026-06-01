/**
 * Idempotent grand_admin seed from env.ADMIN_TG_ID.
 * Used by post-deploy script and admin_ensure_grand_admin (prompt 3).
 */
export async function ensureGrandAdmin(
  db: D1Database,
  adminTgId: number,
): Promise<{ seeded: boolean }> {
  if (!adminTgId || adminTgId <= 0) {
    return { seeded: false };
  }

  const grandCount = await db
    .prepare("SELECT COUNT(*) AS cnt FROM admins WHERE role = 'grand_admin'")
    .first<{ cnt: number }>();

  if (grandCount && grandCount.cnt >= 1) {
    return { seeded: false };
  }

  const totalRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM admins')
    .first<{ cnt: number }>();

  if (totalRow && totalRow.cnt > 0) {
    return { seeded: false };
  }

  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO admins (tg_id, role, password_hash, password_salt, created_at, created_by, updated_at)
       VALUES (?, 'grand_admin', NULL, NULL, ?, NULL, ?)`,
    )
    .bind(adminTgId, now, now)
    .run();

  return { seeded: (result.meta.changes ?? 0) > 0 };
}
