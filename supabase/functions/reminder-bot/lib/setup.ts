// Connects the bot to Telegram: webhook, command menu and profile texts. Runs from the
// every-minute tick, so once the BOT_TOKEN secret exists the bot configures itself.
import type { Db } from './db.ts';
import { COMMANDS, type Lang, T } from './i18n.ts';
import type { Tg } from './telegram.ts';

/** Bump when commands or descriptions change, so they are sent to Telegram again. */
export const SETUP_VERSION = 2;
const RECHECK_MS = 60 * 60 * 1000;

// [Telegram language_code (none = everyone else), bot language]
const PROFILES: [string | null, Lang][] = [
  [null, 'ru'],
  ['ru', 'ru'],
  ['de', 'de'],
];

export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'];

async function setupProfile(tg: Tg) {
  for (const [code, lang] of PROFILES) {
    const scope = code ? { language_code: code } : {};
    await tg('setMyCommands', { commands: COMMANDS[lang].map(([command, description]) => ({ command, description })), ...scope });
    await tg('setMyDescription', { description: T[lang].botDescription, ...scope });
    await tg('setMyShortDescription', { short_description: T[lang].botShortDescription, ...scope });
  }
}

/**
 * Makes Telegram deliver updates to `url` with our secret. Cheap when nothing changed: reads one
 * app_state row and talks to Telegram at most once an hour.
 */
export async function ensureWebhook(
  tg: Tg,
  db: Db,
  opts: { url: string; secretToken: string; tokenId: string; now?: number },
): Promise<{ action: 'none' | 'checked' | 'set'; bot?: string }> {
  const now = opts.now ?? Date.now();
  const state = await db.getState('webhook');
  const sameToken = state?.token_id === opts.tokenId && state?.url === opts.url;
  const sameSetup = sameToken && state?.version === SETUP_VERSION;
  if (sameSetup && now - (state.checked_at ?? 0) < RECHECK_MS) return { action: 'none', bot: state.bot };

  const info = await tg('getWebhookInfo', {});
  // A recent 401 means Telegram sends a secret we do not expect any more.
  const authError = /401|403|unauthorized/i.test(info.last_error_message ?? '') &&
    now / 1000 - (info.last_error_date ?? 0) < 3600;
  let action: 'checked' | 'set' = 'checked';
  if (!sameToken || info.url !== opts.url || authError) {
    await tg('setWebhook', {
      url: opts.url,
      secret_token: opts.secretToken,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 10,
    });
    action = 'set';
  }
  let bot: string | undefined = state?.bot;
  if (!sameSetup) {
    await setupProfile(tg);
    const me = await tg('getMe', {});
    bot = me?.username ? `@${me.username}` : undefined;
    action = 'set';
  }
  await db.setState('webhook', {
    token_id: opts.tokenId,
    url: opts.url,
    version: SETUP_VERSION,
    checked_at: now,
    bot,
    pending_update_count: info.pending_update_count ?? 0,
    last_error: info.last_error_message ?? null,
  });
  return { action, bot };
}
