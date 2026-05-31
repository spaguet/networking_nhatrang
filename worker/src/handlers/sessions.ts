import type { Env } from '../env';
import type { Session } from '../types';

export interface PaidListingDraft {
  type: 'paid_listing';
  listing_id: string;
  display_name: string;
  category: string;
  description: string;
  experience: string;
  contact_type: string;
  contacts: string;
  avatar_emoji: string;
  payment_method: string;
  username: string;
  first_name: string;
  keywords: string[];
}

export interface LegacySessionDraft {
  type: 'legacy';
  listing_id: string;
}

export type SessionDraft = PaidListingDraft | LegacySessionDraft;

export interface PinSessionDraft {
  listing_id: string;
  pin_duration: string;
  payment_method: string;
  price_label: string;
}

function inferSessionType(state: string, sessionType?: string | null): string {
  if (sessionType) {
    return sessionType;
  }
  if (state === 'contact_admin') {
    return 'contact';
  }
  if (state === 'await_pin_proof') {
    return 'pin';
  }
  return 'payment';
}

export async function getSession(tgId: number, env: Env): Promise<Session | null> {
  const row = await env.DB
    .prepare(
      'SELECT tg_id, state, draft, updated_at, session_type FROM sessions WHERE tg_id = ?',
    )
    .bind(tgId)
    .first<Session>();

  return row ?? null;
}

export async function upsertSession(
  tgId: number,
  state: string,
  draft: string,
  env: Env,
  sessionType?: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const type = inferSessionType(state, sessionType);

  await env.DB
    .prepare(
      `INSERT INTO sessions (tg_id, state, draft, updated_at, session_type)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tg_id) DO UPDATE SET
         state = excluded.state,
         draft = excluded.draft,
         updated_at = excluded.updated_at,
         session_type = excluded.session_type`,
    )
    .bind(tgId, state, draft, now, type)
    .run();
}

export async function clearSession(tgId: number, env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE tg_id = ?').bind(tgId).run();
}

export function parseSessionDraft(
  draft: string | null | undefined,
): SessionDraft | null {
  if (!draft) {
    return null;
  }

  try {
    const parsed = JSON.parse(draft) as { type?: string };
    if (parsed && parsed.type === 'paid_listing') {
      return parsed as PaidListingDraft;
    }
  } catch {
    // legacy: draft is listing_id string
  }

  return { type: 'legacy', listing_id: String(draft) };
}

export function parsePinSessionDraft(
  draft: string | null | undefined,
): PinSessionDraft | null {
  if (!draft) {
    return null;
  }

  try {
    const parsed = JSON.parse(draft) as PinSessionDraft;
    if (parsed && parsed.listing_id) {
      return parsed;
    }
  } catch {
    // ignore
  }

  return null;
}
