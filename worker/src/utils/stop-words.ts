import { STOP_WORDS } from '../config';

const LETTER_CLASS = 'a-zA-Zа-яА-ЯёЁ';
const WORD_TOKEN_RE = new RegExp(`[${LETTER_CLASS}]+`, 'g');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsStopPhrase(text: string, stopPhrase: string): boolean {
  const parts = stopPhrase.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return false;
  }

  if (parts.length === 1) {
    const target = parts[0].toLowerCase();
    const tokens = text.match(WORD_TOKEN_RE) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase() === target) {
        return true;
      }
    }
    return false;
  }

  const pattern =
    `(?:^|[^${LETTER_CLASS}])` +
    parts.map((part) => escapeRegExp(part)).join(`[^${LETTER_CLASS}]+`) +
    `(?:[^${LETTER_CLASS}]|$)`;
  return new RegExp(pattern, 'i').test(text);
}

export function findStopWord(text: string): string | null {
  const value = String(text ?? '').trim();
  if (!value) {
    return null;
  }
  const lower = value.toLowerCase();
  for (let i = 0; i < STOP_WORDS.length; i++) {
    if (containsStopPhrase(lower, STOP_WORDS[i])) {
      return STOP_WORDS[i];
    }
  }
  return null;
}

export function containsStopWord(text: string): boolean {
  return findStopWord(text) !== null;
}
