// Sending helpers shared by the update handlers (lib/bot.ts) and the scheduled jobs (lib/tick.ts).
import type { Db } from './db.ts';
import type { Keyboard, View } from './render.ts';
import { isBlocked, isNotModified, type Tg, TgError, tgSafe } from './telegram.ts';

export type Deps = {
  db: Db;
  tg: Tg;
  now: () => Date;
  /** Draws a picture card (lib/raster.ts). Without it, or when it fails, the card's text is sent alone. */
  render?: (svg: string) => Promise<Uint8Array>;
};

export const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

export const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function send(deps: Deps, chatId: number, view: View, extra: Record<string, unknown> = {}) {
  return await tgSafe(deps.tg, 'sendMessage', {
    chat_id: chatId,
    text: view.text,
    reply_markup: view.reply_markup,
    ...HTML,
    ...extra,
  });
}

export async function edit(deps: Deps, chatId: number, messageId: number, view: View) {
  try {
    return await tgSafe(deps.tg, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: view.text,
      reply_markup: view.reply_markup,
      ...HTML,
    });
  } catch (e) {
    if (isNotModified(e)) return null;
    throw e;
  }
}

/** Buttons only; a message that cannot be changed any more (400) is left as it is. */
export async function editMarkup(deps: Deps, chatId: number, messageId: number, markup?: Keyboard) {
  try {
    await tgSafe(deps.tg, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: markup });
  } catch (e) {
    if (!(e instanceof TgError && e.code === 400)) throw e;
  }
}

/** Puts an emoji reaction (with the big animation) on a message. Purely decorative: failures are ignored. */
export async function react(deps: Deps, chatId: number, messageId: number, emoji: string): Promise<void> {
  try {
    await deps.tg('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
      is_big: true,
    });
  } catch (e) {
    console.warn('Reaction failed:', describe(e));
  }
}

function withTimeout<X>(promise: Promise<X>, ms: number): Promise<X> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends a picture card with `view` as its caption and buttons. If the picture cannot be drawn or
 * Telegram does not take it, the same text goes out as a normal message instead.
 */
export async function sendCard(
  deps: Deps,
  chatId: number,
  svg: string | null,
  view: View,
  extra: Record<string, unknown> = {},
) {
  if (deps.render && svg) {
    try {
      const png = await withTimeout(deps.render(svg), 20_000);
      return await tgSafe(deps.tg, 'sendPhoto', {
        chat_id: chatId,
        photo: new File([png as BlobPart], 'card.png', { type: 'image/png' }),
        caption: view.text,
        parse_mode: 'HTML',
        reply_markup: view.reply_markup,
        ...extra,
      });
    } catch (e) {
      if (isBlocked(e)) throw e;
      console.error('Picture card failed, sending text instead:', describe(e));
    }
  }
  return await send(deps, chatId, view, extra);
}
