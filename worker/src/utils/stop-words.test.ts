import { describe, expect, it } from 'vitest';
import { containsStopWord, findStopWord } from './stop-words';

describe('stop-words', () => {
  it('matches whole words only, not substrings', () => {
    expect(containsStopWord('сексуальность')).toBe(false);
    expect(containsStopWord('перепродажа')).toBe(false);
    expect(containsStopWord('интимный сервис')).toBe(false);
  });

  it('matches exact stop words in text', () => {
    expect(findStopWord('Предлагаю секс услуги')).toBe('секс');
    expect(findStopWord('Помогаю настроить пассивный доход')).toBe('пассивный');
    expect(findStopWord('Занимаюсь продажей')).toBeNull();
    expect(findStopWord('Продажа услуг')).toBe('продажа');
  });

  it('matches multi-word stop phrases', () => {
    expect(containsStopWord('У нас требуется сотрудник для проекта')).toBe(true);
    expect(containsStopWord('требуетсясотрудник')).toBe(false);
  });
});
