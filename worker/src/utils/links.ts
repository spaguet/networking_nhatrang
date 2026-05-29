const LINK_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /ftp:\/\//i,
  /\bwww\./i,
  /\bt\.me\//i,
  /\btelegram\.me\//i,
  /\b[a-z0-9][-a-z0-9]{0,62}\.(?:com|ru|net|org|io|dev|me|link|site|xyz|info|biz|co|uk|ua|by|kz|pro|online|store|shop|app|tech|cloud|space|live|work|top|click|pw|cc|tv|gg|ly|to|be|de|fr|pl|cz|eu|su|рф|рус|онлайн|сайт)(?:\/[^\s]*)?\b/i,
];

export function containsLink(text: string): boolean {
  const value = String(text ?? '').trim();
  if (!value) {
    return false;
  }
  return LINK_PATTERNS.some((pattern) => pattern.test(value));
}
