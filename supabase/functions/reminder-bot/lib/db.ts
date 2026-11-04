// Data access: every operation is one call of a bot_* SQL function (see supabase/migrations).
// The transport is injected: PostgREST RPC in the Edge Function, node-postgres in the tests.
import type { Lang } from './i18n.ts';
import type { Ymd } from './dates.ts';

export type Call = (fn: string, args: Record<string, unknown>) => Promise<any>;

export class DbError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

export type User = {
  chat_id: number;
  first_name: string | null;
  lang: Lang;
  timezone: string;
  utc_offset_min: number;
  remind_time: string; // 'HH:MM'
  intervals: number[];
  nudge_enabled: boolean;
  nudge_time: string;
  weekly_enabled: boolean;
  onboarded: boolean;
  pending: string | null;
  is_active: boolean;
  local_date: Ymd;
  local_time: string;
  local_dow: number;
};

export type UserPatch = Partial<{
  lang: Lang;
  timezone: string;
  remind_time: string;
  intervals: number[];
  nudge_enabled: boolean;
  nudge_time: string;
  weekly_enabled: boolean;
  onboarded: boolean;
  pending: string | null;
}>;

export type NewEntry = { studied_on: Ymd; content: string; due_dates: Ymd[] };
export type SavedEntry = NewEntry & { id: number };

export type DigestItem = {
  review_id: number;
  step: number;
  total: number;
  due_on: Ymd;
  status: 'pending' | 'sent' | 'done';
  studied_on: Ymd;
  content: string;
};
export type DigestView = { id: number; local_date: Ymd; today: Ymd; message_id: number | null; items: DigestItem[] };

export type Streak = { current: number; best: number; active_days: number; active_today: boolean };

export type Stats = Streak & {
  entries_total: number;
  entries_week: number;
  first_day: Ymd | null;
  reviews_done: number;
  reviews_today: number;
  reviews_upcoming: number;
  next_due: Ymd | null;
};

export type WeekSummary = Streak & {
  from: Ymd;
  to: Ymd;
  entries: { studied_on: Ymd; content: string }[];
  week_days: number;
  reviews_due: number;
  reviews_done: number;
};

export type ListItem = { id: number; studied_on: Ymd; content: string; total: number; done: number; next_due: Ymd | null };

export type TickClaim = {
  digests: { chat_id: number; lang: Lang; review_ids: number[] }[];
  nudges: { chat_id: number; lang: Lang }[];
  weekly: { chat_id: number; lang: Lang; summary: WeekSummary }[];
};

const iso = (d: Date) => d.toISOString();

export function createDb(call: Call) {
  return {
    touchUser: (chatId: number, from: any, now: Date): Promise<User> =>
      call('bot_touch_user', {
        p_chat_id: chatId,
        p_first_name: from?.first_name ?? null,
        p_username: from?.username ?? null,
        p_language_code: from?.language_code ?? null,
        p_now: iso(now),
      }),
    setUser: (chatId: number, patch: UserPatch, now: Date): Promise<User> =>
      call('bot_set_user', { p_chat_id: chatId, p_patch: patch, p_now: iso(now) }),
    deactivate: (chatId: number) => call('bot_deactivate', { p_chat_id: chatId }),

    addEntries: (
      chatId: number,
      sourceMessageId: number,
      items: NewEntry[],
      replace = false,
    ): Promise<{ duplicate: boolean; entries: SavedEntry[] }> =>
      call('bot_add_entries', { p_chat_id: chatId, p_source_message_id: sourceMessageId, p_items: items, p_replace: replace }),
    setReply: (chatId: number, sourceMessageId: number, replyMessageId: number) =>
      call('bot_set_reply', { p_chat_id: chatId, p_source_message_id: sourceMessageId, p_reply_message_id: replyMessageId }),
    sourceEntries: (
      chatId: number,
      sourceMessageId: number,
    ): Promise<
      { entries: { id: number; studied_on: Ymd; content: string; reply_message_id: number | null }[]; started: boolean }
    > => call('bot_source_entries', { p_chat_id: chatId, p_source_message_id: sourceMessageId }),
    updateEntry: (chatId: number, entryId: number, content: string) =>
      call('bot_update_entry', { p_chat_id: chatId, p_entry_id: entryId, p_content: content }),
    getEntry: (chatId: number, entryId: number): Promise<{ id: number; studied_on: Ymd; content: string } | null> =>
      call('bot_get_entry', { p_chat_id: chatId, p_entry_id: entryId }),
    deleteEntries: (chatId: number, by: { entryId?: number; sourceMessageId?: number }): Promise<{ deleted: number }> =>
      call('bot_delete_entries', {
        p_chat_id: chatId,
        p_entry_id: by.entryId ?? null,
        p_source_message_id: by.sourceMessageId ?? null,
      }),
    listEntries: (chatId: number, limit = 15): Promise<{ total: number; items: ListItem[] }> =>
      call('bot_list_entries', { p_chat_id: chatId, p_limit: limit }),

    dueToday: (chatId: number, now: Date): Promise<{ review_ids: number[]; next_due: Ymd | null }> =>
      call('bot_due_today', { p_chat_id: chatId, p_now: iso(now) }),
    createDigest: (chatId: number, reviewIds: number[], now: Date): Promise<DigestView | null> =>
      call('bot_create_digest', { p_chat_id: chatId, p_review_ids: reviewIds, p_now: iso(now) }),
    digestSent: (digestId: number, messageId: number, now: Date) =>
      call('bot_digest_sent', { p_digest_id: digestId, p_message_id: messageId, p_now: iso(now) }),
    digestFailed: (digestId: number, release: boolean) =>
      call('bot_digest_failed', { p_digest_id: digestId, p_release: release }),
    reviewAction: (
      chatId: number,
      digestId: number,
      action: 'done' | 'done_all' | 'snooze',
      reviewId: number | null,
      now: Date,
    ): Promise<(DigestView & { changed: number; streak: Streak }) | null> =>
      call('bot_review_action', {
        p_chat_id: chatId,
        p_digest_id: digestId,
        p_action: action,
        p_review_id: reviewId,
        p_now: iso(now),
      }),

    stats: (chatId: number, now: Date): Promise<Stats> => call('bot_stats', { p_chat_id: chatId, p_now: iso(now) }),
    weekSummary: (chatId: number, now: Date): Promise<WeekSummary> =>
      call('bot_week_summary', { p_chat_id: chatId, p_now: iso(now) }),

    tickClaim: (now: Date, test: boolean): Promise<TickClaim> => call('bot_tick_claim', { p_now: iso(now), p_test: test }),
    releaseClaim: (chatId: number, kind: 'digest' | 'nudge' | 'weekly') =>
      call('bot_release_claim', { p_chat_id: chatId, p_kind: kind }),

    getState: (key: string): Promise<any> => call('bot_get_state', { p_key: key }),
    setState: (key: string, value: unknown) => call('bot_set_state', { p_key: key, p_value: value }),
    testCleanup: (): Promise<{ deleted_users: number }> => call('bot_test_cleanup', {}),
  };
}

export type Db = ReturnType<typeof createDb>;
