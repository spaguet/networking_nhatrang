import { containsLink } from './links';
import { containsStopWord } from './stop-words';
import type { ListingFormError } from './validation';

export const KEYWORD_LETTERS_RE = /^[a-zA-Zа-яА-ЯёЁ]+$/;
export const KEYWORD_MAX_LEN = 15;
export const KEYWORD_MAX_COUNT = 5;

export function normalizeKeywordToken(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function isValidKeywordToken(token: string): boolean {
  const normalized = normalizeKeywordToken(token);
  if (!normalized) {
    return false;
  }
  return (
    normalized.length >= 1 &&
    normalized.length <= KEYWORD_MAX_LEN &&
    KEYWORD_LETTERS_RE.test(normalized)
  );
}

export function parseKeywordsJson(value: string | null | undefined): string[] {
  if (!value || value.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeKeywordToken)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function serializeKeywords(keywords: string[]): string {
  return JSON.stringify(keywords);
}

function keywordViolatesStopWords(word: string): boolean {
  const lower = normalizeKeywordToken(word);
  if (!lower) {
    return false;
  }
  return containsStopWord(lower);
}

export function formatKeywordsModerationLine(keywords: string[]): string {
  if (!keywords.length) {
    return '🏷 Ключевые слова: —';
  }
  return `🏷 Ключевые слова: ${keywords.join(', ')}`;
}

export type ValidateKeywordsResult =
  | { error: null; keywords: string[] }
  | ListingFormError;

export function validateKeywords(
  enabled: boolean,
  raw: unknown,
): ValidateKeywordsResult {
  if (enabled !== true) {
    return { error: null, keywords: [] };
  }

  if (!Array.isArray(raw)) {
    return {
      error: 'keywords_required',
      message:
        'Укажите хотя бы одно ключевое слово или снимите галочку «Ключевые слова».',
    };
  }

  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const item of raw) {
    const token = normalizeKeywordToken(String(item ?? ''));
    if (!token) {
      continue;
    }

    if (keywords.length >= KEYWORD_MAX_COUNT) {
      return {
        error: 'keywords_limit',
        message: 'Не более 5 ключевых слов.',
      };
    }

    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    if (!isValidKeywordToken(token)) {
      return {
        error: 'keywords_invalid',
        message: 'Ключевое слово: только буквы, одно слово, до 15 символов.',
      };
    }

    if (containsLink(token)) {
      return {
        error: 'links_forbidden',
        message: 'Ссылки не разрешены к использованию.',
      };
    }

    if (keywordViolatesStopWords(token)) {
      return {
        error: 'keyword_stop_word',
        message: 'Данное слово нарушает правила пользования «Место встречи».',
      };
    }

    keywords.push(token);
  }

  if (keywords.length === 0) {
    return {
      error: 'keywords_required',
      message:
        'Укажите хотя бы одно ключевое слово или снимите галочку «Ключевые слова».',
    };
  }

  return { error: null, keywords };
}
