// Renders sample picture cards (and the bot avatar) to PNG files, to look at a design change
// before deploying.
//   deno task cards <output dir>
// Offline? Point CARD_ASSETS_BASE at a folder laid out like the npm CDN (see lib/raster.ts).
import { type DayActivity, statsCard, weekCard } from '../supabase/functions/reminder-bot/lib/cards.ts';
import { addDays } from '../supabase/functions/reminder-bot/lib/dates.ts';
import { renderPng } from '../supabase/functions/reminder-bot/lib/raster.ts';

const out = Deno.args[0] ?? '.';
const today = '2026-11-12';

// A believable month: lessons on most weekdays, reviews on most days, a gap in the middle.
function sampleDays(length: number): DayActivity[] {
  const days: DayActivity[] = [];
  for (let i = 0; i < length; i++) {
    const d = addDays(today, -i);
    if (i >= 16 && i <= 18) continue;
    const n = i % 7 === 3 || i % 5 === 4 ? 0 : 1 + (i % 4 === 0 ? 1 : 0);
    const r = i > 30 ? 0 : i % 6 === 5 ? 0 : 1 + (i % 3);
    if (n || r) days.push({ d, n, r });
  }
  return days;
}

const samples: [string, string][] = [
  [
    'stats-ru',
    statsCard({
      lang: 'ru',
      name: 'Sohib',
      today,
      streak: 16,
      best: 16,
      entries: 24,
      reviewsDone: 61,
      mastered: 3,
      days: sampleDays(35),
    }),
  ],
  [
    'stats-de',
    statsCard({
      lang: 'de',
      name: 'Sohib',
      today,
      streak: 9,
      best: 12,
      entries: 12,
      reviewsDone: 30,
      mastered: 0,
      days: sampleDays(12),
    }),
  ],
  [
    'stats-new',
    statsCard({ lang: 'ru', name: null, today, streak: 0, best: 0, entries: 0, reviewsDone: 0, mastered: 0, days: [] }),
  ],
  [
    'stats-big',
    statsCard({
      lang: 'ru',
      name: 'Александра',
      today,
      streak: 128,
      best: 365,
      entries: 240,
      reviewsDone: 1180,
      mastered: 96,
      days: sampleDays(35),
    }),
  ],
  [
    'week-ru',
    weekCard({
      lang: 'ru',
      name: 'Sohib',
      from: addDays(today, -6),
      to: today,
      streak: 16,
      newTopics: 6,
      activeDays: 6,
      reviewsDone: 11,
      reviewsDue: 13,
      days: sampleDays(7),
    }),
  ],
  [
    'week-de',
    weekCard({
      lang: 'de',
      name: 'Sohib',
      from: addDays(today, -6),
      to: today,
      streak: 2,
      newTopics: 2,
      activeDays: 2,
      reviewsDone: 1,
      reviewsDue: 4,
      days: [{ d: today, n: 1, r: 1 }, { d: addDays(today, -1), n: 1, r: 0 }],
    }),
  ],
];

// The bot's profile picture (set it in @BotFather: /setuserpic).
samples.push(['bot-avatar', await Deno.readTextFile(new URL('../assets/bot-avatar.svg', import.meta.url))]);

await Deno.mkdir(out, { recursive: true });
for (const [name, svg] of samples) {
  const started = performance.now();
  const png = await renderPng(svg);
  await Deno.writeFile(`${out}/${name}.png`, png);
  console.log(`${name}.png  ${Math.round(png.length / 1024)} KB  ${Math.round(performance.now() - started)} ms`);
}
