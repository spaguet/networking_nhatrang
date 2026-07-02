import { describe, expect, it } from 'vitest';
import { AVATAR_EMOJIS, CATEGORIES } from '../config';
import { validateListingForm } from './validation';

function validListingBody(description: string): Record<string, unknown> {
  return {
    display_name: 'Иван',
    category: CATEGORIES[0],
    description,
    experience: '5 лет',
    contact_type: 'Telegram',
    contacts: '@ivan_dev',
    avatar_emoji: AVATAR_EMOJIS[0],
  };
}

describe('validateListingForm', () => {
  it('returns the matched stop word in resume description errors', () => {
    const result = validateListingForm(
      validListingBody('Помогаю настроить пассивный доход'),
    );

    expect(result).toEqual({
      error: 'stop_words',
      message: 'Текст содержит запрещённое слово: «пассивный». Измените описание.',
      stop_word: 'пассивный',
    });
  });

  it('allows words that only contain a stop word as substring', () => {
    const result = validateListingForm(
      validListingBody('Работаю с темой сексуальности в консультировании.'),
    );

    expect(result.error).toBeNull();
  });
});
