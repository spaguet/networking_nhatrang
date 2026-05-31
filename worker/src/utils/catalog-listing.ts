import { DEFAULT_AVATAR_EMOJI } from '../config';
import { decodeDescriptionNewlines } from './description';
import { parseKeywordsJson } from './keywords';

export function toIsoOrEmpty(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

export interface CatalogListingRow {
  listing_id: string;
  display_name: string;
  category: string;
  description: string;
  experience: string | null;
  contact_type: string | null;
  contacts: string;
  avatar_emoji: string | null;
  created_at: string | null;
  expires_at: string | null;
  pin_status: string | null;
  pinned_at: string | null;
  pin_expires_at: string | null;
  has_portfolio: number;
  portfolio_count: number;
  keywords: string;
}

export function mapCatalogListing(row: CatalogListingRow) {
  const portfolioCount = Number(row.portfolio_count ?? 0);
  return {
    listing_id: row.listing_id,
    display_name: row.display_name,
    category: row.category,
    description: decodeDescriptionNewlines(row.description),
    experience: row.experience != null ? String(row.experience) : '',
    contact_type: row.contact_type != null ? String(row.contact_type) : '',
    contacts: row.contacts,
    avatar_emoji: row.avatar_emoji ? String(row.avatar_emoji) : DEFAULT_AVATAR_EMOJI,
    created_at: toIsoOrEmpty(row.created_at),
    expires_at: toIsoOrEmpty(row.expires_at),
    pin_status: row.pin_status ? String(row.pin_status) : 'regular',
    pinned_at: row.pinned_at ? String(row.pinned_at) : '',
    pin_expires_at: row.pin_expires_at ? String(row.pin_expires_at) : '',
    has_portfolio: portfolioCount > 0,
    portfolio_count: portfolioCount,
    keywords: parseKeywordsJson(row.keywords),
  };
}
