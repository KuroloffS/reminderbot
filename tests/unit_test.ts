import { assertEquals } from '@std/assert';
import { addDays, diffDays, weekday } from '../supabase/functions/reminder-bot/lib/dates.ts';
import { fmtDate, fmtDateLong, fmtOffset, joinList, pluralRu } from '../supabase/functions/reminder-bot/lib/i18n.ts';
import {
  monthFromWord,
  offsetToZone,
  parseDatePrefix,
  parseIntervals,
  parseTime,
  parseUtcOffset,
  splitEntries,
  timezoneCandidate,
} from '../supabase/functions/reminder-bot/lib/parse.ts';
import { scheduleReviews } from '../supabase/functions/reminder-bot/lib/schedule.ts';
import { clip, digest, esc } from '../supabase/functions/reminder-bot/lib/render.ts';

const TODAY = '2026-11-04'; // a Wednesday

Deno.test('dates', () => {
  assertEquals(addDays('2026-11-04', 1), '2026-11-05');
  assertEquals(addDays('2026-11-30', 1), '2026-12-01');
  assertEquals(addDays('2026-12-31', 1), '2027-01-01');
  assertEquals(addDays('2024-03-01', -1), '2024-02-29');
  assertEquals(diffDays('2026-12-04', '2026-11-04'), 30);
  assertEquals(weekday('2026-11-04'), 3);
  assertEquals(weekday('2026-11-08'), 0);
});

Deno.test('month names in Uzbek, Russian, German, English', () => {
  for (const w of ['noyabr', 'Noyabr', 'noyabrda', 'ноября', 'ноябрь', 'November', 'Nov.', 'nov', 'нояб.']) {
    assertEquals(monthFromWord(w), 11, w);
  }
  assertEquals(monthFromWord('mart'), 3);
  assertEquals(monthFromWord('марта'), 3);
  assertEquals(monthFromWord('März'), 3);
  assertEquals(monthFromWord('мая'), 5);
  assertEquals(monthFromWord('Mai'), 5);
  assertEquals(monthFromWord('may'), 5);
  assertEquals(monthFromWord('sentyabr'), 9);
  assertEquals(monthFromWord('Sept'), 9);
  assertEquals(monthFromWord('dekabr'), 12);
  assertEquals(monthFromWord('Dez'), 12);
  // not months
  for (const w of ['marta', 'leksion', 'Novellen', 'марки', 'mayonnaise', 'Lektion', 'dars', 'ta']) {
    assertEquals(monthFromWord(w), null, w);
  }
});

Deno.test('date at the start of a line (the notes from the screenshot)', () => {
  assertEquals(parseDatePrefix('4 noyabr. 1- leksion lugati. Sifatlarni skloneniyasi ni organdim.', TODAY), {
    date: '2026-11-04',
    rest: '1- leksion lugati. Sifatlarni skloneniyasi ni organdim.',
  });
  // Later in the year than today -> last year.
  assertEquals(parseDatePrefix('5- noyabr. 2 -leksion lugati. 1-2leksion grammatikasi', TODAY), {
    date: '2025-11-05',
    rest: '2 -leksion lugati. 1-2leksion grammatikasi',
  });
  assertEquals(parseDatePrefix('6-noyabr. 3 leksion lugati, 1 ta email yozdim', '2026-11-07'), {
    date: '2026-11-06',
    rest: '3 leksion lugati, 1 ta email yozdim',
  });
});

Deno.test('other date formats', () => {
  const p = (s: string, ref = TODAY) => parseDatePrefix(s, ref);
  assertEquals(p('3 ноября: лексика'), { date: '2026-11-03', rest: 'лексика' });
  assertEquals(p('3. November – Wortschatz'), { date: '2026-11-03', rest: 'Wortschatz' });
  assertEquals(p('November 3 Wortschatz'), { date: '2026-11-03', rest: 'Wortschatz' });
  assertEquals(p('03.11 Hausaufgabe'), { date: '2026-11-03', rest: 'Hausaufgabe' });
  assertEquals(p('3.11.2025: alt'), { date: '2025-11-03', rest: 'alt' });
  assertEquals(p('03.11.25 alt'), { date: '2025-11-03', rest: 'alt' });
  assertEquals(p('2026-11-02 Perfekt'), { date: '2026-11-02', rest: 'Perfekt' });
  assertEquals(p('4 ноября 2025 г. — лекция'), { date: '2025-11-04', rest: 'лекция' });
  assertEquals(p('вчера: 2-я лекция'), { date: '2026-11-03', rest: '2-я лекция' });
  assertEquals(p('kecha - 3 leksion'), { date: '2026-11-03', rest: '3 leksion' });
  assertEquals(p('Gestern habe ich Lektion 2 gelernt'), { date: '2026-11-03', rest: 'Gestern habe ich Lektion 2 gelernt' });
  assertEquals(parseDatePrefix('Heute habe ich viel gelernt', TODAY, false), null);
  assertEquals(parseDatePrefix('heute: Lektion 4', TODAY, false), { date: TODAY, rest: 'Lektion 4' });
  // not dates
  assertEquals(p('1- leksion lugati'), null);
  assertEquals(p('3 leksion lugati, 1 ta email yozdim'), null);
  assertEquals(p('1.2 leksion grammatikasi'), null);
  assertEquals(p('4 marta takrorladim'), null);
  assertEquals(p('31 fevral'), null);
  assertEquals(p('Lektion 5: Perfekt'), null);
  assertEquals(p('5.11.2026 future'), null); // explicit year in the future
});

Deno.test('one message with several dated lines becomes several notes', () => {
  const text = '4 noyabr. 1- leksion lugati. Sifatlarni skloneniyasi ni organdim.\n' +
    '5- noyabr. 2 -leksion lugati. 1-2leksion grammatikasi\n' +
    '6-noyabr. 3 leksion lugati, 1 ta email yozdim';
  assertEquals(splitEntries(text, '2026-11-07'), [
    { date: '2026-11-04', content: '1- leksion lugati. Sifatlarni skloneniyasi ni organdim.' },
    { date: '2026-11-05', content: '2 -leksion lugati. 1-2leksion grammatikasi' },
    { date: '2026-11-06', content: '3 leksion lugati, 1 ta email yozdim' },
  ]);
  assertEquals(splitEntries('Lektion 5: Perfekt\n\nNeue Wörter: gehen, kommen\nHeute habe ich viel gelernt', TODAY), [
    { date: null, content: 'Lektion 5: Perfekt\nNeue Wörter: gehen, kommen\nHeute habe ich viel gelernt' },
  ]);
  assertEquals(splitEntries('3 noyabr\n1-leksion lugati\n2-leksion grammatika', TODAY), [
    { date: '2026-11-03', content: '1-leksion lugati\n2-leksion grammatika' },
  ]);
  assertEquals(splitEntries('4 noyabr', TODAY), []);
  assertEquals(splitEntries('   ', TODAY), []);
});

Deno.test('times, intervals, time zones', () => {
  assertEquals(parseTime('8'), '08:00');
  assertEquals(parseTime('08:30'), '08:30');
  assertEquals(parseTime('8.30'), '08:30');
  assertEquals(parseTime('830'), '08:30');
  assertEquals(parseTime('2130'), '21:30');
  assertEquals(parseTime('20 Uhr'), '20:00');
  assertEquals(parseTime('21ч'), '21:00');
  assertEquals(parseTime('24:00'), null);
  assertEquals(parseTime('8:75'), null);
  assertEquals(parseTime('утром'), null);

  assertEquals(parseIntervals('1 3 7 14 30'), [1, 3, 7, 14, 30]);
  assertEquals(parseIntervals('7, 1, 3, 3'), [1, 3, 7]);
  assertEquals(parseIntervals('0 3'), null);
  assertEquals(parseIntervals('1 2 3 4 5 6 7 8 9 10 11'), null);
  assertEquals(parseIntervals('abc'), null);

  assertEquals(parseUtcOffset('+5'), 300);
  assertEquals(parseUtcOffset('UTC-3'), -180);
  assertEquals(parseUtcOffset('GMT+5:30'), 330);
  assertEquals(parseUtcOffset('5'), 300);
  assertEquals(parseUtcOffset('+15'), null);
  assertEquals(offsetToZone(300), 'Etc/GMT-5');
  assertEquals(offsetToZone(-180), 'Etc/GMT+3');
  assertEquals(offsetToZone(0), 'Etc/UTC');
  assertEquals(offsetToZone(330), 'Asia/Kolkata');
  assertEquals(timezoneCandidate('+5'), 'Etc/GMT-5');
  assertEquals(timezoneCandidate('Ташкент'), 'Asia/Tashkent');
  assertEquals(timezoneCandidate("Farg'ona"), 'Asia/Tashkent');
  assertEquals(timezoneCandidate('München'), 'Europe/Berlin');
  assertEquals(timezoneCandidate('Europe/Vienna'), 'Europe/Vienna');
  assertEquals(timezoneCandidate('new york'), 'new york');
  assertEquals(timezoneCandidate('12:30'), null);
});

Deno.test('review schedule', () => {
  const iv = [1, 3, 7, 14, 30];
  // Logged today: next day, +3, +7, +14, +30.
  assertEquals(scheduleReviews(TODAY, iv, TODAY, true), ['2026-11-05', '2026-11-07', '2026-11-11', '2026-11-18', '2026-12-04']);
  // Yesterday's lesson logged before today's reminder: first review today.
  assertEquals(scheduleReviews('2026-11-03', iv, TODAY, false)[0], TODAY);
  // … logged after today's reminder went out: first review moves to tomorrow.
  assertEquals(scheduleReviews('2026-11-03', iv, TODAY, true), [
    '2026-11-05',
    '2026-11-06',
    '2026-11-10',
    '2026-11-17',
    '2026-12-03',
  ]);
  // Two days ago: the missed first review and the +3 one fall on the same day.
  assertEquals(scheduleReviews('2026-11-02', iv, TODAY, true), ['2026-11-05', '2026-11-09', '2026-11-16', '2026-12-02']);
  // Ten days ago: only what is still ahead.
  assertEquals(scheduleReviews('2026-10-25', iv, TODAY, true), ['2026-11-08', '2026-11-24']);
  // A year ago: history only.
  assertEquals(scheduleReviews('2025-11-05', iv, TODAY, true), []);
  assertEquals(scheduleReviews(TODAY, [1], TODAY, false), ['2026-11-05']);
});

Deno.test('formatting', () => {
  assertEquals(fmtDate('ru', '2026-11-04'), '4 нояб.');
  assertEquals(fmtDate('de', '2026-11-04'), '4. Nov.');
  assertEquals(fmtDate('ru', '2026-05-09', { today: TODAY }), '9 мая');
  assertEquals(fmtDate('de', '2025-03-01', { today: TODAY }), '1. März 2025');
  assertEquals(fmtDate('ru', '2026-11-05', { today: TODAY, relative: true }), 'завтра');
  assertEquals(fmtDate('de', '2026-11-03', { today: TODAY, relative: true }), 'gestern');
  assertEquals(fmtDate('ru', '2026-11-08', { weekday: true }), 'вс, 8 нояб.');
  assertEquals(fmtDateLong('ru', TODAY, TODAY), 'сегодня, 4 нояб.');
  assertEquals(fmtDateLong('de', '2026-10-30', TODAY), '30. Okt.');
  assertEquals(pluralRu(1, 'день', 'дня', 'дней'), 'день');
  assertEquals(pluralRu(3, 'день', 'дня', 'дней'), 'дня');
  assertEquals(pluralRu(11, 'день', 'дня', 'дней'), 'дней');
  assertEquals(pluralRu(22, 'день', 'дня', 'дней'), 'дня');
  assertEquals(joinList('ru', [1, 3, 7]), '1, 3 и 7');
  assertEquals(joinList('de', [1]), '1');
  assertEquals(fmtOffset(300), 'UTC+5');
  assertEquals(fmtOffset(-210), 'UTC−3:30');
  assertEquals(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assertEquals(clip('abcdef', 4), 'abc…');
  assertEquals(clip('😀😀😀', 3), '😀😀😀');
});

Deno.test('reminder message shows progress and buttons', () => {
  const item = (id: number, status: 'pending' | 'sent' | 'done', due = TODAY) => ({
    review_id: id,
    step: 1,
    total: 5,
    due_on: due,
    status,
    studied_on: '2026-11-03',
    content: `Lektion ${id} <neu>`,
  });
  const view = { id: 7, local_date: TODAY, today: TODAY, message_id: null, items: [item(1, 'sent'), item(2, 'sent')] };
  const fresh = digest('ru', view);
  assertEquals(fresh.text.includes('Lektion 1 &lt;neu&gt;'), true);
  assertEquals(fresh.reply_markup!.inline_keyboard.flat().map((b) => b.callback_data), ['D:7:1', 'D:7:2', 'DA:7', 'DS:7']);

  const half = digest('de', { ...view, items: [item(1, 'done'), item(2, 'sent')] });
  assertEquals(half.text.includes('<s>Lektion 1 &lt;neu&gt;</s>'), true);
  assertEquals(half.reply_markup!.inline_keyboard.flat().map((b) => b.callback_data), ['D:7:2', 'DA:7', 'DS:7']);

  const done = digest('ru', { ...view, items: [item(1, 'done'), item(2, 'done')] }, 3);
  assertEquals(done.text.startsWith('🎉'), true);
  assertEquals(done.text.includes('🔥 Серия: 3 дня подряд'), true);
  assertEquals(done.reply_markup, undefined);

  const snoozed = digest('ru', { ...view, items: [item(1, 'done'), item(2, 'pending', '2026-11-05')] });
  assertEquals(snoozed.text.startsWith('👍'), true);
  assertEquals(snoozed.text.includes('перенесено на завтра'), true);
});
