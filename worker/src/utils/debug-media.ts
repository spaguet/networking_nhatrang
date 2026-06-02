import type { Env } from '../env';

export function isDebugMedia(env: Pick<Env, 'DEBUG_MEDIA'>): boolean {
  const v = env.DEBUG_MEDIA?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function debugMediaLog(debug: boolean, ...args: unknown[]): void {
  if (debug) {
    console.log(...args);
  }
}
