import type { Env } from '../env';

export const APP_SETTINGS_CACHE_KEY = 'app_settings_cache';
export const APP_SETTINGS_CACHE_TTL = 60;

export async function loadAppSettingsMap(
  db: D1Database,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT key, value FROM app_settings')
    .all<{ key: string; value: string }>();

  const map = new Map<string, string>();
  if (results) {
    for (let i = 0; i < results.length; i++) {
      map.set(results[i].key, results[i].value);
    }
  }
  return map;
}

/** D1 → KV cache (60s) → Map for merge in getConfigWithSettings. */
export async function loadAppSettings(env: Env): Promise<Map<string, string>> {
  const cached = await env.CACHE.get(APP_SETTINGS_CACHE_KEY, 'json');
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(cached as Record<string, string>)) {
      if (typeof value === 'string') {
        map.set(key, value);
      }
    }
    return map;
  }

  const map = await loadAppSettingsMap(env.DB);
  const obj: Record<string, string> = {};
  map.forEach((value, key) => {
    obj[key] = value;
  });
  await env.CACHE.put(APP_SETTINGS_CACHE_KEY, JSON.stringify(obj), {
    expirationTtl: APP_SETTINGS_CACHE_TTL,
  });
  return map;
}

export async function invalidateAppSettingsCache(env: Env): Promise<void> {
  await env.CACHE.delete(APP_SETTINGS_CACHE_KEY);
}

export async function upsertAppSetting(
  db: D1Database,
  key: string,
  value: string,
  updatedBy: number,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .bind(key, value, now, updatedBy)
    .run();
}

export function qrSettingKey(methodKey: string): string {
  return `qr_${methodKey}_file_id`;
}
