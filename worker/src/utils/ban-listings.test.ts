import { describe, expect, it } from 'vitest';
import { listingStatusAfterUnban } from './ban-listings';

describe('listingStatusAfterUnban', () => {
  const now = new Date('2026-06-03T12:00:00.000Z');

  it('returns active for lifetime placement', () => {
    expect(listingStatusAfterUnban('lifetime', now)).toBe('active');
    expect(listingStatusAfterUnban(null, now)).toBe('active');
  });

  it('returns active when expires_at is in the future', () => {
    expect(listingStatusAfterUnban('2026-07-01T00:00:00.000Z', now)).toBe('active');
  });

  it('returns archived when placement period expired', () => {
    expect(listingStatusAfterUnban('2026-05-01T00:00:00.000Z', now)).toBe('archived');
  });
});
