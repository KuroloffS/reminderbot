// Handling of Telegram updates: commands, study notes, typed settings and button presses.
import { earnedBadges, metricsOf } from './badges.ts';
import { statsCardFor, weekCardFor } from './cards.ts';
import { localDateFromUnix, type Ymd } from './dates.ts';
import { DbError, type NewEntry, type Stats, type User, type UserPatch } from './db.ts';
import { COMMANDS, INTERVAL_PRESETS, isLang, type Lang, MENU_VERSION, T, TZ_PRESETS } from './i18n.ts';
import { parseIntervals, parseTime, splitEntries, timezoneCandidate } from './parse.ts';
import * as R from './render.ts';
import { scheduleReviews } from './schedule.ts';
import { type Deps, describe, edit, editMarkup, react, send, sendCard } from './send.ts';
import { EFFECT, TgError } from './telegram.ts';
import { CAPTION_MAX, sendDigests } from './tick.ts';

export type { Deps };

const MAX_ITEMS = 50; // notes taken from one message
const MAX_CONTENT = 2000; // characters per note

const replyTo = (messageId: number) => ({ reply_parameters: { message_id: messageId, allow_sending_without_reply: true } });
const minDate = (a: Ymd, b: Ymd) => (a < b ? a : b);
const isPrivate = (chat: any) => chat?.type === 'private';

async function setChatCommands(deps: Deps, chatId: number, lang: Lang) {
  try {
    await deps.tg('setMyCommands', {
      commands: COMMANDS[lang].map(([command, description]) => ({ command, description })),
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch (e) {
    console.warn('setMyCommands failed:', e);
  }
}

/** A chat keeps the command menu it got when its language was chosen; hand out the current one once. */
async function refreshMenu(deps: Deps, user: User): Promise<User> {
  if (!user.onboarded || user.menu_version === undefined || user.menu_version >= MENU_VERSION) return user;
  await setChatCommands(deps, user.chat_id, user.lang);
  return await deps.db.setUser(user.chat_id, { menu_version: MENU_VERSION }, deps.now());
}

/** Congratulates on badges earned since the last check: one message with a full-screen effect. */
async function checkAwards(deps: Deps, user: User, known?: Stats): Promise<void> {
  try {
    const stats = known ?? (await deps.db.stats(user.chat_id, deps.now()));
    if (!Array.isArray(stats.achievements)) return;
    const have = new Set(stats.achievements);
    const fresh = earnedBadges(metricsOf(stats)).map((b) => b.code).filter((code) => !have.has(code));
    if (!fresh.length) return;
    const claimed = await deps.db.claimAchievements(user.chat_id, fresh);
    if (!claimed.new.length) return;
    const effect = claimed.new.some((code) => code.startsWith('streak_')) ? EFFECT.fire : EFFECT.party;
    await send(deps, user.chat_id, R.newAwards(user.lang, claimed.new), { message_effect_id: effect });
  } catch (e) {
    console.error('Badge check failed:', describe(e));
  }
}

export async function handleUpdate(update: any, deps: Deps): Promise<void> {
  if (update?.message) await onMessage(update.message, deps);
  else if (update?.edited_message) await onEditedMessage(update.edited_message, deps);
  else if (update?.callback_query) await onCallback(update.callback_query, deps);
  else if (update?.my_chat_member) await onMemberUpdate(update.my_chat_member, deps);
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

async function onMessage(msg: any, deps: Deps) {
  if (!isPrivate(msg.chat) || !msg.from || msg.from.is_bot) return;
  const now = deps.now();
  let user = await deps.db.touchUser(msg.chat.id, msg.from, now);
  user = await refreshMenu(deps, user);
  const text = String(msg.text ?? msg.caption ?? '').trim();
  if (!text) {
    await send(deps, user.chat_id, { text: T[user.lang].onlyText });
    return;
  }
  if (text.startsWith('/')) {
    if (user.pending) user = await deps.db.setUser(user.chat_id, { pending: null }, now);
    await onCommand(text, user, deps);
    return;
  }
  const pending = parsePending(user.pending);
  if (pending) {
    await applyTyped(pending.kind, text, user, deps, pending.ctx);
    return;
  }
  await onStudyNote(msg, text, user, deps);
}

async function onCommand(text: string, user: User, deps: Deps) {
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  const cmd = (m?.[1] ?? '').toLowerCase();
  const arg = (m?.[2] ?? '').trim();
  const chatId = user.chat_id;
  const t = T[user.lang];

  switch (cmd) {
    case 'start':
      await send(deps, chatId, user.onboarded ? R.help(user) : R.welcome());
      return;
    case 'help':
      await send(deps, chatId, R.help(user));
      return;
    case 'today':
      await showToday(user, deps);
      return;
    case 'list':
      await send(deps, chatId, R.list(user, await deps.db.listEntries(chatId, 15)));
      return;
    case 'stats':
      await showStats(user, deps);
      return;
    case 'awards':
      await showAwards(user, deps);
      return;
    case 'week':
      await showWeek(user, deps);
      return;
    case 'settings':
      await send(deps, chatId, R.settings(user));
      return;
    case 'lang':
    case 'language':
      await send(deps, chatId, R.langPicker(user));
      return;
    case 'time':
      if (arg) await applyTyped('time', arg, user, deps, 's');
      else await send(deps, chatId, R.timePicker(user, 's'));
      return;
    case 'tz':
    case 'timezone':
      if (arg) await applyTyped('tz', arg, user, deps, 's');
      else await send(deps, chatId, R.tzPicker(user, 's'));
      return;
    case 'intervals':
      if (arg) await applyTyped('intervals', arg, user, deps, 's');
      else await send(deps, chatId, R.intervalsPicker(user));
      return;
    case 'evening':
      if (arg) await applyTyped('evening', arg, user, deps, 's');
      else await send(deps, chatId, R.eveningPicker(user));
      return;
    case 'cancel':
      await send(deps, chatId, { text: t.cancelled });
      return;
  }

  const del = cmd.match(/^del_?(\d+)$/);
  if (del) {
    const entry = await deps.db.getEntry(chatId, Number(del[1]));
    await send(deps, chatId, entry ? R.deleteEntryConfirm(user, entry) : { text: t.notFound });
    return;
  }
  await send(deps, chatId, { text: t.unknownCommand });
}

async function showToday(user: User, deps: Deps) {
  const due = await deps.db.dueToday(user.chat_id, deps.now());
  if (!due.review_ids.length) {
    await send(deps, user.chat_id, R.nothingToday(user, due.next_due));
    return;
  }
  await sendDigests(deps, user.chat_id, user.lang, due.review_ids, { release: false });
}

/** Tells the user a picture is on its way and collects what the card shows; null means "send text only". */
async function cardSvg(deps: Deps, chatId: number, build: () => Promise<string>): Promise<string | null> {
  if (!deps.render) return null;
  try {
    await deps.tg('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
    return await build();
  } catch (e) {
    console.error('Card data failed:', describe(e));
    return null;
  }
}

/** /stats: the progress card (streak, activity calendar, totals) with the numbers as caption. */
async function showStats(user: User, deps: Deps) {
  const now = deps.now();
  const stats = await deps.db.stats(user.chat_id, now);
  const hasData = stats.entries_total > 0 || stats.reviews_done > 0;
  const svg = hasData
    ? await cardSvg(deps, user.chat_id, async () => statsCardFor(user, stats, await deps.db.activity(user.chat_id, 35, now)))
    : null;
  await sendCard(deps, user.chat_id, svg, R.stats(user, stats));
  if (hasData) await checkAwards(deps, user, stats);
}

async function showAwards(user: User, deps: Deps) {
  const stats = await deps.db.stats(user.chat_id, deps.now());
  await send(deps, user.chat_id, R.awards(user, stats));
  await checkAwards(deps, user, stats);
}

/** /week: the last 7 days as a chart, with the summary as caption. */
async function showWeek(user: User, deps: Deps) {
  const now = deps.now();
  const summary = await deps.db.weekSummary(user.chat_id, now);
  const hasData = summary.entries.length > 0 || summary.reviews_due > 0 || summary.week_days > 0;
  const svg = hasData
    ? await cardSvg(
      deps,
      user.chat_id,
      async () => weekCardFor(user.lang, user.first_name, summary, await deps.db.activity(user.chat_id, 7, now)),
    )
    : null;
  await sendCard(deps, user.chat_id, svg, R.weekly(user.lang, summary, user.local_date, svg ? CAPTION_MAX : undefined));
}

/** Notes from a message; dates are relative to `base` (today, or the day a forwarded message was written). */
function buildEntries(text: string, base: Ymd, user: User): NewEntry[] {
  const afterReminderTime = user.local_time >= user.remind_time;
  return splitEntries(text, base)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const studied = item.date ?? base;
      return {
        studied_on: studied,
        content: R.clip(item.content, MAX_CONTENT),
        due_dates: scheduleReviews(studied, user.intervals, user.local_date, afterReminderTime),
      };
    });
}

async function onStudyNote(msg: any, text: string, user: User, deps: Deps) {
  const forwardedAt = msg.forward_origin?.date ?? msg.forward_date;
  const base = typeof forwardedAt === 'number'
    ? minDate(localDateFromUnix(forwardedAt, user.utc_offset_min), user.local_date)
    : user.local_date;
  const entries = buildEntries(text, base, user);
  if (!entries.length) {
    await send(deps, user.chat_id, { text: T[user.lang].needContent }, replyTo(msg.message_id));
    return;
  }
  const saved = await deps.db.addEntries(user.chat_id, msg.message_id, entries);
  if (saved.duplicate) return; // Telegram delivered the same message again

  // A reaction on the note itself: fire for something studied today (the streak lives), a pen for older days.
  const studiedToday = saved.entries.some((e) => e.studied_on === user.local_date);
  const reaction = react(deps, user.chat_id, msg.message_id, studiedToday ? '🔥' : '✍');

  const firstNote = !user.onboarded;
  if (firstNote) user = await deps.db.setUser(user.chat_id, { onboarded: true }, deps.now());
  const view = R.entriesSaved(user, saved.entries, msg.message_id, { hint: firstNote });
  const reply = await send(deps, user.chat_id, view, replyTo(msg.message_id));
  await deps.db.setReply(user.chat_id, msg.message_id, reply.message_id);
  await reaction;
  await checkAwards(deps, user);
}

/** An edited note is re-read; once reminders went out only the text of a single note changes. */
async function onEditedMessage(msg: any, deps: Deps) {
  if (!isPrivate(msg.chat) || !msg.from || msg.from.is_bot) return;
  const text = String(msg.text ?? msg.caption ?? '').trim();
  if (!text || text.startsWith('/')) return;
  const user = await deps.db.touchUser(msg.chat.id, msg.from, deps.now());
  const source = await deps.db.sourceEntries(user.chat_id, msg.message_id);
  if (!source.entries.length) return;

  const writtenOn = typeof msg.date === 'number'
    ? minDate(localDateFromUnix(msg.date, user.utc_offset_min), user.local_date)
    : user.local_date;
  const entries = buildEntries(text, writtenOn, user);
  if (!entries.length) return;

  if (source.started) {
    if (source.entries.length === 1 && entries.length === 1) {
      await deps.db.updateEntry(user.chat_id, source.entries[0].id, entries[0].content);
      await send(deps, user.chat_id, { text: T[user.lang].textUpdated }, replyTo(msg.message_id));
    }
    return;
  }

  const saved = await deps.db.addEntries(user.chat_id, msg.message_id, entries, true);
  const view = R.entriesSaved(user, saved.entries, msg.message_id, { edited: true });
  const replyId = source.entries.find((e) => e.reply_message_id)?.reply_message_id;
  if (replyId) {
    try {
      await edit(deps, user.chat_id, replyId, view);
      await deps.db.setReply(user.chat_id, msg.message_id, replyId);
      return;
    } catch (e) {
      if (!(e instanceof TgError)) throw e; // confirmation is gone: send a new one
    }
  }
  const reply = await send(deps, user.chat_id, view, replyTo(msg.message_id));
  await deps.db.setReply(user.chat_id, msg.message_id, reply.message_id);
}

async function onMemberUpdate(update: any, deps: Deps) {
  if (!isPrivate(update.chat)) return;
  const status = update.new_chat_member?.status;
  if (status === 'kicked') await deps.db.deactivate(update.chat.id);
  else if (status === 'member') await deps.db.touchUser(update.chat.id, update.from, deps.now());
}

// ---------------------------------------------------------------------------------------------
// Typed settings (after "✏️ Other" or /time 8:30, /tz +5, /intervals 1 3 7, /evening off)
// ---------------------------------------------------------------------------------------------

function parsePending(pending: string | null): { kind: R.PromptKind; ctx: R.Ctx } | null {
  const m = pending?.match(/^(time|tz|evening|intervals)(?::([os]))?$/);
  return m ? { kind: m[1] as R.PromptKind, ctx: m[2] === 'o' ? 'o' : 's' } : null;
}

const OFF_WORDS = /^(off|выкл\.?|выключить|нет|aus|ausschalten|nein|no)$/i;

function typedPatch(kind: R.PromptKind, text: string): UserPatch | null {
  switch (kind) {
    case 'time': {
      const time = parseTime(text);
      return time ? { remind_time: time } : null;
    }
    case 'evening': {
      if (OFF_WORDS.test(text.trim())) return { nudge_enabled: false };
      const time = parseTime(text);
      return time ? { nudge_time: time, nudge_enabled: true } : null;
    }
    case 'intervals': {
      const intervals = parseIntervals(text);
      return intervals ? { intervals } : null;
    }
    case 'tz': {
      const timezone = timezoneCandidate(text);
      return timezone ? { timezone } : null;
    }
  }
}

async function applyTyped(kind: R.PromptKind, text: string, user: User, deps: Deps, ctx: R.Ctx) {
  const now = deps.now();
  const patch = typedPatch(kind, text);
  let updated: User | null = null;
  if (patch) {
    if (ctx === 'o' && kind === 'time') patch.onboarded = true;
    try {
      updated = await deps.db.setUser(user.chat_id, { ...patch, pending: null }, now);
    } catch (e) {
      if (!(e instanceof DbError && e.code === '22023')) throw e; // 22023: unknown time zone
    }
  }
  if (!updated) {
    const pending = ctx === 'o' ? `${kind}:o` : kind;
    if (user.pending !== pending) await deps.db.setUser(user.chat_id, { pending }, now);
    await send(deps, user.chat_id, R.prompt(user.lang, kind, ctx, true));
    return;
  }
  if (ctx === 'o') {
    await send(deps, updated.chat_id, kind === 'time' ? R.onboardDone(updated) : R.timePicker(updated, 'o'));
  } else {
    await send(deps, updated.chat_id, R.settings(updated, T[updated.lang].savedSettings));
  }
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

async function onCallback(cq: any, deps: Deps) {
  // The button stops "loading" as soon as its result is known; follow-ups (reactions, badges) come after.
  let answered = false;
  const answer = async (text?: string) => {
    if (answered) return;
    answered = true;
    await deps.tg('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
  };
  try {
    const msg = cq.message;
    if (!msg || !isPrivate(msg.chat)) return;
    let user = await deps.db.touchUser(msg.chat.id, cq.from, deps.now());
    user = await refreshMenu(deps, user);
    await answer(await onButton(String(cq.data ?? ''), user, msg.message_id, deps, answer));
  } finally {
    await answer();
  }
}

async function onButton(
  data: string,
  user: User,
  messageId: number,
  deps: Deps,
  answer: (text?: string) => Promise<void>,
): Promise<string | undefined> {
  const now = deps.now();
  const chatId = user.chat_id;
  const t = T[user.lang];
  const [kind, a = '', b = ''] = data.split(':');
  const ctx: R.Ctx = b === 'o' ? 'o' : 's';
  const set = (patch: UserPatch) => deps.db.setUser(chatId, patch, now);
  // Replace the message with the button; if Telegram refuses (too old, deleted), send a new one.
  const show = async (view: R.View) => {
    try {
      await edit(deps, chatId, messageId, view);
    } catch (e) {
      if (!(e instanceof TgError && e.code === 400)) throw e;
      await send(deps, chatId, view);
    }
  };
  const savedNote = (u: User) => T[u.lang].savedSettings;

  switch (kind) {
    case 'L': {
      if (!isLang(a)) return;
      const u = await set({ lang: a, pending: null, menu_version: MENU_VERSION });
      await setChatCommands(deps, chatId, a);
      await show(ctx === 'o' ? R.timePicker(u, 'o') : R.settings(u, savedNote(u)));
      return;
    }
    case 'T': {
      if (a === 'x') {
        await set({ pending: ctx === 'o' ? 'time:o' : 'time' });
        await show(R.prompt(user.lang, 'time', ctx));
        return;
      }
      const time = parseTime(a);
      if (!time) return;
      const u = await set({ remind_time: time, pending: null, ...(ctx === 'o' ? { onboarded: true } : {}) });
      await show(ctx === 'o' ? R.onboardDone(u) : R.settings(u, savedNote(u)));
      return;
    }
    case 'Z': {
      if (a === 'x') {
        await set({ pending: ctx === 'o' ? 'tz:o' : 'tz' });
        await show(R.prompt(user.lang, 'tz', ctx));
        return;
      }
      const preset = TZ_PRESETS[Number(a)];
      if (!preset) return;
      const u = await set({ timezone: preset.tz, pending: null });
      await show(ctx === 'o' ? R.timePicker(u, 'o') : R.settings(u, savedNote(u)));
      return;
    }
    case 'I': {
      if (a === 'x') {
        await set({ pending: 'intervals' });
        await show(R.prompt(user.lang, 'intervals', 's'));
        return;
      }
      const preset = INTERVAL_PRESETS[Number(a)];
      if (!preset) return;
      const u = await set({ intervals: preset, pending: null });
      await show(R.settings(u, savedNote(u)));
      return;
    }
    case 'E': {
      if (a === 'x') {
        await set({ pending: 'evening' });
        await show(R.prompt(user.lang, 'evening', 's'));
        return;
      }
      const time = a === 'off' ? null : parseTime(a);
      if (a !== 'off' && !time) return;
      const u = await set(
        time ? { nudge_time: time, nudge_enabled: true, pending: null } : { nudge_enabled: false, pending: null },
      );
      await show(R.settings(u, savedNote(u)));
      return;
    }
    case 'W': {
      const u = await set({ weekly_enabled: a === 'on', pending: null });
      await show(R.settings(u, savedNote(u)));
      return;
    }
    case 'S': {
      const u = user.pending ? await set({ pending: null }) : user;
      const pages: Record<string, () => R.View> = {
        main: () => R.settings(u),
        lang: () => R.langPicker(u),
        time: () => R.timePicker(u, ctx),
        tz: () => R.tzPicker(u, ctx),
        int: () => R.intervalsPicker(u),
        eve: () => R.eveningPicker(u),
      };
      if (pages[a]) await show(pages[a]());
      return;
    }
    case 'C': {
      const u = await set({ pending: null });
      await show(ctx === 'o' ? R.timePicker(u, 'o') : R.settings(u));
      return;
    }
    case 'N': {
      await set({ nudge_enabled: false });
      await show({ text: `${t.nudge}\n\n${t.nudgeOff}` });
      return;
    }
    case 'D':
    case 'DA':
    case 'DS': {
      const action = kind === 'D' ? 'done' : kind === 'DA' ? 'done_all' : 'snooze';
      const result = await deps.db.reviewAction(chatId, Number(a), action, kind === 'D' ? Number(b) : null, now);
      if (!result) {
        await editMarkup(deps, chatId, messageId, undefined);
        return t.toastGone;
      }
      await show(R.digest(user.lang, result, result.streak?.current ?? 0));
      await answer(action === 'snooze' ? t.toastSnoozed : t.toastDone);
      if (action !== 'snooze' && result.changed > 0) {
        // Everything in this reminder is done: a little party on the message itself.
        if (result.items.length > 0 && result.items.every((it) => it.status === 'done')) {
          await react(deps, chatId, messageId, '🎉');
        }
        await checkAwards(deps, user);
      }
      return;
    }
    case 'A': {
      await send(deps, chatId, R.awards(user, await deps.db.stats(chatId, now)));
      return;
    }
    case 'X':
      await editMarkup(deps, chatId, messageId, R.deleteConfirmKeyboard(user.lang, Number(a), Number(b) || 1));
      return;
    case 'XN':
      await editMarkup(deps, chatId, messageId, R.deleteKeyboard(user.lang, Number(a), Number(b) || 1));
      return;
    case 'XY':
      await deps.db.deleteEntries(chatId, { sourceMessageId: Number(a) });
      await show({ text: t.deleted });
      return;
    case 'RY': {
      const result = await deps.db.deleteEntries(chatId, { entryId: Number(a) });
      await show({ text: result.deleted ? t.deleted : t.notFound });
      return;
    }
    case 'RN':
      await show({ text: t.cancelled });
      return;
  }
  return;
}
