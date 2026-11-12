// Every message the bot sends: text (Telegram HTML) + inline keyboard.
//
// Callback data (max 64 bytes):
//   L:<ru|de>:<o|s>   language (o = onboarding, s = settings)
//   T:<HHMM|x>:<o|s>  reminder time (x = type it)        Z:<preset|x>:<o|s>  time zone
//   I:<preset|x>      intervals                          E:<HHMM|off|x>      evening question
//   W:<on|off>        weekly summary                     S:<page>[:o]        open a settings page
//   C:<o|s>           cancel typing                      N:off               evening question off
//   D:<digest>:<review> one review done   DA:<digest> all done   DS:<digest> rest -> tomorrow
//   X:<msg>:<n> / XY:<msg> / XN:<msg>:<n>  delete the entries of one message (ask, yes, no)
//   RY:<entry> / RN:<entry>                delete one entry from /del_<id>
//   A                                      show the badges (button under the statistics)
import { type Badge, badgeByCode, BADGES, badgeTitle, bar, earnedBadges, METRICS, metricsOf } from './badges.ts';
import type { DigestItem, DigestView, ListItem, SavedEntry, Stats, User, WeekSummary } from './db.ts';
import type { Ymd } from './dates.ts';
import {
  EVENING_PRESETS,
  fmtDate,
  fmtDateLong,
  fmtOffset,
  INTERVAL_PRESETS,
  type Lang,
  T,
  TIME_PRESETS,
  TZ_PRESETS,
  WELCOME,
} from './i18n.ts';

/** `style` colors the button in Telegram apps from 2026 on (blue, green, red); older apps ignore it. */
export type ButtonStyle = 'primary' | 'success' | 'danger';
export type Button = { text: string; callback_data: string; style?: ButtonStyle };
export type Keyboard = { inline_keyboard: Button[][] };
export type View = { text: string; reply_markup?: Keyboard };
export type Ctx = 'o' | 's';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Shortens to `max` characters (not UTF-16 units, so emoji are never cut in half). */
export function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const btn = (text: string, data: string, style?: ButtonStyle): Button =>
  style ? { text, callback_data: data, style } : { text, callback_data: data };

/** A choice in a picker: the current one is marked and blue. */
const option = (label: string, data: string, current: boolean): Button =>
  current ? btn(`• ${label} •`, data, 'primary') : btn(label, data);

/** The note text as a quote block; long notes fold up until tapped. */
const quote = (content: string, max: number): string => {
  const text = esc(clip(content, max));
  return `<blockquote${text.length > 240 || text.split('\n').length > 4 ? ' expandable' : ''}>${text}</blockquote>`;
};

function chunk<X>(items: X[], size: number): X[][] {
  const out: X[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const hhmm = (time: string) => time.replace(':', '');

export function tzLabel(user: User): string {
  const preset = TZ_PRESETS.find((p) => p.tz === user.timezone);
  const name = preset ? preset[user.lang] : user.timezone.startsWith('Etc/') ? '' : user.timezone.replace(/_/g, ' ');
  const offset = fmtOffset(user.utc_offset_min);
  return name ? `${name} (${offset})` : offset;
}

// ---------------------------------------------------------------------------------------------
// Onboarding and settings
// ---------------------------------------------------------------------------------------------

export function welcome(): View {
  return { text: WELCOME, reply_markup: { inline_keyboard: [[btn('🇷🇺 Русский', 'L:ru:o'), btn('🇩🇪 Deutsch', 'L:de:o')]] } };
}

export function langPicker(user: User): View {
  const t = T[user.lang];
  return {
    text: t.pickLang,
    reply_markup: {
      inline_keyboard: [
        [option('🇷🇺 Русский', 'L:ru:s', user.lang === 'ru'), option('🇩🇪 Deutsch', 'L:de:s', user.lang === 'de')],
        [btn(t.btnBack, 'S:main')],
      ],
    },
  };
}

export function timePicker(user: User, ctx: Ctx): View {
  const t = T[user.lang];
  const kb = chunk(TIME_PRESETS.map((v) => option(v, `T:${hhmm(v)}:${ctx}`, v === user.remind_time)), 4);
  kb.push([btn(t.btnOther, `T:x:${ctx}`)]);
  kb.push(ctx === 'o' ? [btn(t.changeTz, 'S:tz:o')] : [btn(t.btnBack, 'S:main')]);
  return { text: ctx === 'o' ? t.askTime(tzLabel(user)) : t.pickTime(user.remind_time), reply_markup: { inline_keyboard: kb } };
}

export function tzPicker(user: User, ctx: Ctx): View {
  const t = T[user.lang];
  const kb = chunk(TZ_PRESETS.map((p, i) => option(p[user.lang], `Z:${i}:${ctx}`, p.tz === user.timezone)), 2);
  kb.push([btn(t.btnOther, `Z:x:${ctx}`)]);
  kb.push([btn(t.btnBack, ctx === 'o' ? 'S:time:o' : 'S:main')]);
  return { text: t.pickTz(tzLabel(user)), reply_markup: { inline_keyboard: kb } };
}

export function intervalsPicker(user: User): View {
  const t = T[user.lang];
  const current = user.intervals.join(',');
  const kb = INTERVAL_PRESETS.map((p, i) => [option(p.join(' · '), `I:${i}`, p.join(',') === current)]);
  kb.push([btn(t.btnOwn, 'I:x'), btn(t.btnBack, 'S:main')]);
  return { text: t.pickIntervals(user.intervals.join(', ')), reply_markup: { inline_keyboard: kb } };
}

export function eveningPicker(user: User): View {
  const t = T[user.lang];
  const kb = chunk(
    EVENING_PRESETS.map((v) => option(v, `E:${hhmm(v)}`, user.nudge_enabled && v === user.nudge_time)),
    5,
  );
  kb.push([option(t.btnOff, 'E:off', !user.nudge_enabled), btn(t.btnOther, 'E:x')]);
  kb.push([btn(t.btnBack, 'S:main')]);
  return { text: t.pickEvening(user.nudge_enabled ? user.nudge_time : t.off), reply_markup: { inline_keyboard: kb } };
}

export function settings(user: User, note?: string): View {
  const t = T[user.lang];
  const lines = [
    t.settingsTitle,
    '',
    t.setLang(t.langName),
    t.setTime(user.remind_time),
    t.setTz(tzLabel(user)),
    t.setIntervals(user.intervals.join(', ')),
    t.setNudge(user.nudge_enabled ? user.nudge_time : t.off),
    t.setWeekly(user.weekly_enabled ? t.weeklyOn : t.off),
  ];
  if (note) lines.unshift(note, '');
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [btn(t.btnLang, 'S:lang'), btn(t.btnTime, 'S:time')],
        [btn(t.btnTz, 'S:tz'), btn(t.btnIntervals, 'S:int')],
        [btn(t.btnEvening, 'S:eve'), btn(t.btnWeekly(user.weekly_enabled), user.weekly_enabled ? 'W:off' : 'W:on')],
      ],
    },
  };
}

export type PromptKind = 'time' | 'tz' | 'intervals' | 'evening';

export function promptText(lang: Lang, kind: PromptKind): string {
  const t = T[lang];
  return { time: t.promptTime, tz: t.promptTz, intervals: t.promptIntervals, evening: t.promptEvening }[kind];
}

export function prompt(lang: Lang, kind: PromptKind, ctx: Ctx, invalid = false): View {
  const t = T[lang];
  const text = invalid ? t.invalid(promptText(lang, kind)) : promptText(lang, kind);
  return { text, reply_markup: { inline_keyboard: [[btn(t.btnCancel, `C:${ctx}`)]] } };
}

export function help(user: User): View {
  const t = T[user.lang];
  return { text: t.help(user.remind_time, user.intervals), reply_markup: { inline_keyboard: [[btn(t.btnSettings, 'S:main')]] } };
}

export function onboardDone(user: User): View {
  const t = T[user.lang];
  return { text: `${t.onboardDone(user.remind_time)}\n\n${t.help(user.remind_time, user.intervals)}` };
}

// ---------------------------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------------------------

export function deleteKeyboard(lang: Lang, sourceMessageId: number, n: number): Keyboard {
  const t = T[lang];
  return { inline_keyboard: [[btn(n === 1 ? t.btnDelete : t.btnDeleteAll, `X:${sourceMessageId}:${n}`)]] };
}

export function deleteConfirmKeyboard(lang: Lang, sourceMessageId: number, n: number): Keyboard {
  const t = T[lang];
  return {
    inline_keyboard: [[btn(t.btnYesDelete, `XY:${sourceMessageId}`, 'danger'), btn(t.btnCancel, `XN:${sourceMessageId}:${n}`)]],
  };
}

export function entriesSaved(
  user: User,
  entries: SavedEntry[],
  sourceMessageId: number,
  opts: { edited?: boolean; hint?: boolean } = {},
): View {
  const t = T[user.lang];
  const today = user.local_date;
  const dates = (list: Ymd[]) => list.map((d) => fmtDate(user.lang, d, { today, relative: true })).join(', ');
  const lines: string[] = [];
  if (opts.edited) lines.push(t.edited);
  if (entries.length === 1) {
    const e = entries[0];
    lines.push(t.saved(fmtDateLong(user.lang, e.studied_on, today)));
    lines.push(quote(e.content, 600));
    lines.push(e.due_dates.length ? t.willRemind(dates(e.due_dates)) : t.historyOnly);
  } else {
    lines.push(t.savedMany(entries.length), '');
    const shown = entries.slice(0, 15);
    for (const e of shown) {
      lines.push(`📅 <b>${fmtDate(user.lang, e.studied_on, { today })}</b> — ${esc(clip(e.content, 120))}`);
      lines.push(`      ${e.due_dates.length ? `🔁 ${dates(e.due_dates)}` : t.historyShort}`);
    }
    if (entries.length > shown.length) lines.push(t.weekMore(entries.length - shown.length));
  }
  if (opts.hint) lines.push('', t.defaultsHint(user.remind_time));
  return { text: lines.join('\n'), reply_markup: deleteKeyboard(user.lang, sourceMessageId, entries.length) };
}

export function deleteEntryConfirm(user: User, entry: { id: number; studied_on: Ymd; content: string }): View {
  const t = T[user.lang];
  return {
    text: t.confirmDeleteEntry(fmtDate(user.lang, entry.studied_on, { today: user.local_date }), esc(clip(entry.content, 300))),
    reply_markup: { inline_keyboard: [[btn(t.btnYesDelete, `RY:${entry.id}`, 'danger'), btn(t.btnCancel, `RN:${entry.id}`)]] },
  };
}

export function list(user: User, data: { total: number; items: ListItem[] }): View {
  const t = T[user.lang];
  if (!data.items.length) return { text: t.listEmpty };
  const today = user.local_date;
  const lines = [data.total > data.items.length ? t.listTitlePart(data.items.length, data.total) : t.listTitle, ''];
  for (const e of data.items) {
    lines.push(`📅 <b>${fmtDate(user.lang, e.studied_on, { today })}</b> — ${esc(clip(e.content, 100))}`);
    const progress = e.total ? `${bar(e.done, e.total, e.total)} ${e.done}/${e.total} · ` : '';
    const status = e.total === 0
      ? t.listNoReviews
      : e.next_due
      ? t.listNext(fmtDate(user.lang, e.next_due, { today, relative: true }))
      : t.listFinished;
    lines.push(`      ${progress}${status} · /del_${e.id}`);
  }
  lines.push('', t.listFooter);
  return { text: lines.join('\n') };
}

// ---------------------------------------------------------------------------------------------
// Review reminders
// ---------------------------------------------------------------------------------------------

export type ItemState = 'active' | 'done' | 'snoozed';

export function itemState(item: DigestItem, today: Ymd): ItemState {
  if (item.status === 'done') return 'done';
  if (item.status === 'pending' && item.due_on > today) return 'snoozed';
  return 'active';
}

export function digest(lang: Lang, view: DigestView, streak = 0): View {
  const t = T[lang];
  const states = view.items.map((it) => itemState(it, view.today));
  const activeCount = states.filter((s) => s === 'active').length;
  const lines: string[] = [];

  if (activeCount) {
    lines.push(t.digestTitle(view.items.length));
  } else if (states.every((s) => s === 'done')) {
    lines.push(t.allDone);
    if (streak > 1) lines.push(t.streakLine(streak));
  } else {
    lines.push(t.partDone);
  }
  lines.push('');

  // Items waiting for an answer show the note as a quote block; answered ones shrink to one line.
  const blocks = view.items.map((it, i) => {
    const n = i + 1;
    if (states[i] === 'done') {
      const mastered = it.step >= it.total ? ` · 🎓 <i>${t.masteredMark}</i>` : '';
      return `${n}. ✅ <s>${esc(clip(it.content, 120))}</s>${mastered}`;
    }
    if (states[i] === 'snoozed') return `${n}. ⏰ ${esc(clip(it.content, 120))} — <i>${t.movedTomorrow}</i>`;
    const date = fmtDate(lang, it.studied_on, { today: view.today });
    return `<b>${n}.</b> 📅 ${date} · <i>${t.step(it.step, it.total)}</i> ${bar(it.step, it.total, it.total)}\n${
      quote(it.content, 600)
    }`;
  });
  lines.push(blocks.join('\n'));
  if (activeCount) lines.push(states[states.length - 1] === 'active' ? t.digestHint : `\n${t.digestHint}`);

  const kb: Button[][] = [];
  if (activeCount) {
    if (view.items.length > 1) {
      const perItem = view.items
        .map((it, i) => (states[i] === 'active' ? btn(`✅ ${i + 1}`, `D:${view.id}:${it.review_id}`) : null))
        .filter((b): b is Button => b !== null);
      kb.push(...chunk(perItem, 5));
    }
    kb.push([
      btn(view.items.length > 1 ? t.btnDoneAll : t.btnDoneOne, `DA:${view.id}`, 'success'),
      btn(t.btnSnooze, `DS:${view.id}`),
    ]);
  }
  return { text: lines.join('\n').trim(), reply_markup: kb.length ? { inline_keyboard: kb } : undefined };
}

export function nothingToday(user: User, nextDue: Ymd | null): View {
  const t = T[user.lang];
  const next = nextDue
    ? t.nextReview(fmtDate(user.lang, nextDue, { today: user.local_date, relative: true, weekday: false }))
    : t.nothingPlanned;
  return { text: `${t.nothingToday}\n${next}` };
}

export function nudge(lang: Lang): View {
  const t = T[lang];
  return { text: t.nudge, reply_markup: { inline_keyboard: [[btn(t.btnNudgeOff, 'N:off')]] } };
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

export function stats(user: User, s: Stats): View {
  const t = T[user.lang];
  if (!s.entries_total && !s.reviews_done) return { text: t.listEmpty };
  const today = user.local_date;
  const lines = [
    t.statsTitle,
    '',
    t.statsStreak(s.current, s.best),
    t.statsEntries(s.entries_total, s.entries_week),
    t.statsActive(s.active_days),
    t.statsDone(s.reviews_done),
    t.statsMastered(s.mastered ?? 0),
    t.statsQueue(s.reviews_today, s.reviews_upcoming),
  ];
  if (s.next_due) lines.push(t.statsNext(fmtDate(user.lang, s.next_due, { today, relative: true })));
  if (s.first_day) lines.push(t.statsFirst(fmtDate(user.lang, s.first_day, { today })));
  const have = earnedBadges(metricsOf(s)).length;
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[btn(t.btnAwards(have, BADGES.length), 'A')]] } };
}

/** All badges by group: earned ones show their emoji, the rest a lock; plus the way to the next one. */
export function awards(user: User, s: Stats): View {
  const t = T[user.lang];
  const m = metricsOf(s);
  const lines = [t.awardsTitle(earnedBadges(m).length, BADGES.length)];
  for (const metric of METRICS) {
    const group = BADGES.filter((b) => b.metric === metric);
    const next = group.find((b) => m[metric] < b.need);
    lines.push('', `<b>${t.awardGroups[metric]}</b> · ${m[metric]}`);
    lines.push(group.map((b) => `${m[metric] >= b.need ? b.emoji : '🔒'} ${b.need}`).join(' · '));
    lines.push(
      next
        ? `${bar(m[metric], next.need)} ${m[metric]}/${next.need} → ${next.emoji} ${badgeTitle(user.lang, next)}`
        : t.awardsGroupDone,
    );
  }
  lines.push('', t.awardsNote);
  return { text: lines.join('\n') };
}

/** The congratulation for badges earned just now. */
export function newAwards(lang: Lang, codes: string[]): View {
  const t = T[lang];
  const badges = codes.map(badgeByCode).filter((b): b is Badge => b !== undefined);
  const lines = [badges.length === 1 ? t.newAward : t.newAwards(badges.length), ''];
  for (const b of badges) lines.push(`${b.emoji} <b>${badgeTitle(lang, b)}</b>`);
  lines.push('', t.awardsHint);
  return { text: lines.join('\n') };
}

/** `maxLength`: photo captions hold 1024 characters, so the topic list is shortened to fit. */
export function weekly(lang: Lang, w: WeekSummary, today: Ymd, maxLength = 4000): View {
  const t = T[lang];
  if (!w.entries.length && !w.reviews_due && !w.week_days) return { text: t.weekEmpty };
  const build = (topics: number): string => {
    const lines = [
      t.weekTitle(fmtDate(lang, w.from, { today }), fmtDate(lang, w.to, { today })),
      '',
      t.weekEntries(w.entries.length),
      t.weekDays(w.week_days),
    ];
    if (w.reviews_due) lines.push(t.weekReviews(w.reviews_done, w.reviews_due));
    if (w.current) lines.push(t.weekStreak(w.current));
    if (topics > 0) {
      lines.push('', t.weekTopics);
      for (const e of w.entries.slice(0, topics)) {
        lines.push(`• ${fmtDate(lang, e.studied_on, { today })} — ${esc(clip(e.content, 80))}`);
      }
      if (w.entries.length > topics) lines.push(t.weekMore(w.entries.length - topics));
    }
    lines.push('', w.week_days >= 5 ? t.weekGreat : w.week_days >= 3 ? t.weekGood : t.weekLow);
    return lines.join('\n');
  };
  let topics = Math.min(10, w.entries.length);
  let text = build(topics);
  while (text.length > maxLength && topics > 0) text = build(--topics);
  return { text };
}
