// The every-minute job: morning review reminders, evening question, Sunday summary.
import type { Db } from './db.ts';
import type { Lang } from './i18n.ts';
import * as R from './render.ts';
import { isBlocked, isTemporary, type Tg } from './telegram.ts';

export type Deps = { db: Db; tg: Tg; now: () => Date };

/** Reviews per reminder message (more are split into several messages). */
export const DIGEST_SIZE = 10;

const quiet = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

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
      const msg = await deps.tg('sendMessage', {
        chat_id: chatId,
        text: message.text,
        reply_markup: message.reply_markup,
        disable_notification: i > 0,
        ...quiet,
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

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      const view = R.nudge(n.lang);
      await deps.tg('sendMessage', { chat_id: n.chat_id, text: view.text, reply_markup: view.reply_markup, ...quiet });
      out.nudges++;
    } catch (e) {
      await failed(n.chat_id, e, 'nudge');
    }
  }

  for (const w of claim.weekly) {
    try {
      const view = R.weekly(w.lang, w.summary, w.summary.to);
      await deps.tg('sendMessage', { chat_id: w.chat_id, text: view.text, ...quiet });
      out.weekly++;
    } catch (e) {
      await failed(w.chat_id, e, 'weekly');
    }
  }

  return out;
}
