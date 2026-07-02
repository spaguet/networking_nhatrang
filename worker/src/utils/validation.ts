import {
  AVATAR_EMOJIS,
  CATEGORIES,
  CONTACT_TYPES,
  STOP_WORDS,
} from '../config';
import { encodeDescriptionNewlines, normalizeDescriptionInput } from './description';
import { validateKeywords } from './keywords';
import { containsLink } from './links';

export interface ListingFormFields {
  display_name: string;
  category: string;
  description: string;
  experience: string;
  contact_type: string;
  contacts: string;
  avatar_emoji: string;
  keywords: string[];
}

export interface ListingFormError {
  error: string;
  message: string;
  stop_word?: string;
}

export type ValidateListingFormResult =
  | ({ error: null } & ListingFormFields)
  | ListingFormError;

const LINKS_FORBIDDEN_MESSAGE = 'Ссылки не разрешены к использованию.';

function checkNoLinks(value: string): ListingFormError | null {
  if (containsLink(value)) {
    return {
      error: 'links_forbidden',
      message: LINKS_FORBIDDEN_MESSAGE,
    };
  }
  return null;
}

function checkStopWords(description: string): ListingFormError | null {
  const descLower = description.toLowerCase();
  for (let i = 0; i < STOP_WORDS.length; i++) {
    const stopWord = STOP_WORDS[i];
    if (descLower.includes(stopWord)) {
      return {
        error: 'stop_words',
        message: `Текст содержит запрещённое слово: «${stopWord}». Измените описание.`,
        stop_word: stopWord,
      };
    }
  }
  return null;
}

export function validateListingForm(
  body: Record<string, unknown>,
): ValidateListingFormResult {
  const displayName = String(body.display_name ?? '').trim();
  const category = String(body.category ?? '').trim();
  const description = normalizeDescriptionInput(body.description);
  const experience = String(body.experience ?? '').trim();
  const contactType = String(body.contact_type ?? '').trim();
  const contacts = String(body.contacts ?? '').trim();
  const avatarEmoji = String(body.avatar_emoji ?? '').trim();

  if (
    !displayName ||
    !category ||
    !description ||
    !experience ||
    !contactType ||
    !contacts ||
    !avatarEmoji
  ) {
    return { error: 'validation', message: 'Заполните все поля.' };
  }

  if (!(CONTACT_TYPES as readonly string[]).includes(contactType)) {
    return {
      error: 'invalid_contact_type',
      message: 'Выберите тип контакта из списка.',
    };
  }

  if (!(CATEGORIES as readonly string[]).includes(category)) {
    return {
      error: 'invalid_category',
      message: 'Выберите категорию из списка.',
    };
  }

  if (!(AVATAR_EMOJIS as readonly string[]).includes(avatarEmoji)) {
    return {
      error: 'invalid_avatar',
      message: 'Выберите эмодзи-аватар из списка.',
    };
  }

  const nameLinksError = checkNoLinks(displayName);
  if (nameLinksError) {
    return nameLinksError;
  }

  const descriptionLinksError = checkNoLinks(description);
  if (descriptionLinksError) {
    return descriptionLinksError;
  }

  const stopWordsError = checkStopWords(description);
  if (stopWordsError) {
    return stopWordsError;
  }

  const keywordsResult = validateKeywords(body.keywords_enabled === true, body.keywords);
  if (keywordsResult.error !== null) {
    return keywordsResult;
  }

  return {
    error: null,
    display_name: displayName,
    category,
    description: encodeDescriptionNewlines(description),
    experience,
    contact_type: contactType,
    contacts,
    avatar_emoji: avatarEmoji,
    keywords: keywordsResult.keywords,
  };
}
