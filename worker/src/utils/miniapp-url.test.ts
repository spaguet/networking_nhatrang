import { describe, expect, it } from 'vitest';
import {
  getMiniAppCatalogUrl,
  getMiniAppRulesUrl,
  isValidMiniAppUrl,
} from './miniapp-url';

describe('isValidMiniAppUrl', () => {
  it('accepts a GitHub Pages https URL', () => {
    expect(isValidMiniAppUrl('https://spaguet.github.io/networking_nhatrang/')).toBe(true);
  });

  it('rejects empty / non-https / Apps Script URLs', () => {
    expect(isValidMiniAppUrl('')).toBe(false);
    expect(isValidMiniAppUrl('http://example.com')).toBe(false);
    expect(isValidMiniAppUrl('https://script.google.com/macros/s/abc/exec')).toBe(false);
  });
});

describe('getMiniAppCatalogUrl', () => {
  it('builds a catalog.html URL with a numeric cache-buster', () => {
    const url = getMiniAppCatalogUrl('https://spaguet.github.io/networking_nhatrang/');
    expect(url).toMatch(/^https:\/\/spaguet\.github\.io\/networking_nhatrang\/catalog\.html\?v=\d+$/);
  });

  it('produces a different cache-buster on each call (never a hardcoded constant)', async () => {
    const first = getMiniAppCatalogUrl('https://spaguet.github.io/networking_nhatrang/');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = getMiniAppCatalogUrl('https://spaguet.github.io/networking_nhatrang/');
    expect(first).not.toBe(second);
  });
});

describe('getMiniAppRulesUrl', () => {
  it('builds a rules.html URL with a numeric cache-buster', () => {
    const url = getMiniAppRulesUrl('https://spaguet.github.io/networking_nhatrang/');
    expect(url).toMatch(/^https:\/\/spaguet\.github\.io\/networking_nhatrang\/rules\.html\?v=\d+$/);
  });
});
