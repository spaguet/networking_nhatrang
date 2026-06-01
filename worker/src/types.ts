export type AdminRole = 'grand_admin' | 'admin';

export interface Admin {
  tg_id: number;
  role: AdminRole;
  password_hash: string | null;
  password_salt: string | null;
  created_at: string;
  created_by: number | null;
  updated_at: string;
}

export interface User {
  tg_id: number;
  username: string | null;
  first_name: string;
  reg_date: string;
  free_used: number;
  banned?: number;
  banned_at?: string | null;
  banned_by?: number | null;
}

export interface Listing {
  listing_id: string;
  tg_id: number;
  display_name: string;
  category: string;
  description: string;
  experience: string | null;
  contact_type: string;
  contacts: string;
  status: string;
  payment_status: string;
  created_at: string | null;
  expires_at: string | null;
  submitted_at: string;
  avatar_emoji: string | null;
  pin_status: string;
  pinned_at: string | null;
  pin_expires_at: string | null;
}

export interface Session {
  tg_id: number;
  state: string;
  draft: string | null;
  updated_at: string;
  session_type: string | null;
}

export interface Log {
  id?: number;
  timestamp: string;
  tg_id: number | null;
  action: string;
  details: string | null;
}

export interface Like {
  listing_id: string;
  tg_id: number;
  liked_at: string;
}

export interface AdminLink {
  admin_message_id: number;
  user_tg_id: number;
  link_type: string | null;
  listing_id: string | null;
  created_at: string;
}
