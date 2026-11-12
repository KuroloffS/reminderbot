// The every-minute job: morning review reminders, evening question, Sunday summary.
import { weekCardFor } from './cards.ts';
import type { Lang } from './i18n.ts';
import * as R from './render.ts';
import { type Deps, describe, HTML, send, sendCard } from './send.ts';
import { isBlocked, isTemporary, tgSafe } from './telegram.ts';

/** Reviews per reminder message (more are split into several messages). */
export const DIGEST_SIZE = 10;

/** Photo captions hold 1024 characters; stay a little below. */
export const CAPTION_MAX = 1000;

/**
 * Sends the given reviews as reminder message(s) with ✅ buttons; returns how many messages went out.
 * On failure the unsent digest is dropped (its reviews stay due); `release` lets the next tick retry today.
 */
export async function sendDigests(
  deps: Deps,
  chatId: number,
  lang: Lang,
  reviewIds: number[],
  opts: { release: boolean },
): Promise<number> {
  const now = deps.now();
  let sent = 0;
  for (let i = 0; i < reviewIds.length; i += DIGEST_SIZE) {
    const view = await deps.db.createDigest(chatId, reviewIds.slice(i, i + DIGEST_SIZE), now);
    if (!view) break;
    const message = R.digest(lang, view);
    try {
      const msg = await tgSafe(deps.tg, 'sendMessage', {
        chat_id: chatId,
        text: message.text,
        reply_markup: message.reply_markup,
        disable_notification: i > 0,
        ...HTML,
      });
      await deps.db.digestSent(view.id, msg.message_id, now);
      sent++;
    } catch (e) {
      await deps.db.digestFailed(view.id, opts.release && sent === 0 && isTemporary(e));
      throw e;
    }
  }
  return sent;
}

export type TickResult = { digests: number; nudges: number; weekly: number; failed: number; errors: string[] };

export async function runTick(deps: Deps, opts: { test: boolean }): Promise<TickResult> {
  const now = deps.now();
  const claim = await deps.db.tickClaim(now, opts.test);
  const out: TickResult = { digests: 0, nudges: 0, weekly: 0, failed: 0, errors: [] };

  const failed = async (chatId: number, e: unknown, retry: 'nudge' | 'weekly' | null) => {
    out.failed++;
    out.errors.push(`${chatId}: ${describe(e)}`);
    if (isBlocked(e)) await deps.db.deactivate(chatId);
    else if (retry && isTemporary(e)) await deps.db.releaseClaim(chatId, retry);
  };

  for (const d of claim.digests) {
    try {
      out.digests += await sendDigests(deps, d.chat_id, d.lang, d.review_ids, { release: true });
    } catch (e) {
      await failed(d.chat_id, e, null);
    }
  }

  for (const n of claim.nudges) {
    try {
      await send(deps, n.chat_id, R.nudge(n.lang));
      out.nudges++;
    } catch (e) {
      await failed(n.chat_id, e, 'nudge');
    }
  }

  // The weekly summary is a picture (chart of the week) with the text as its caption.
  for (const w of claim.weekly) {
    try {
      const svg = deps.render && w.activity ? weekCardFor(w.lang, w.first_name, w.summary, w.activity) : null;
      await sendCard(deps, w.chat_id, svg, R.weekly(w.lang, w.summary, w.summary.to, svg ? CAPTION_MAX : undefined));
      out.weekly++;
    } catch (e) {
      await failed(w.chat_id, e, 'weekly');
    }
  }

  return out;
}
